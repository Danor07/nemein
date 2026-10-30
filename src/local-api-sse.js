import { Buffer } from "node:buffer";
import { apiError, apiFailure, sseLimits } from "./local-api-contract.js";

// This adapter only reads the protected events action; the cursor owns progress.
export function createEventStreams() {
  const streams = new Set();

  function open(agent, after, res) {
    if (streams.size >= sseLimits.streams)
      throw apiFailure("STREAM_LIMIT", "Too many event streams.");
    function read() {
      const { decision } = agent.eventStreamState(after);
      if (decision === "ask")
        throw apiFailure(
          "APPROVAL_REQUIRED",
          "Continuous events require an allow rule.",
        );
      const page = agent.request(
        "events",
        { after, limit: 1 },
        {
          purpose: "Read continuous budget events",
        },
      );
      if (page.status === "pending")
        throw apiFailure(
          "APPROVAL_REQUIRED",
          "Continuous events require approval.",
        );
      return page;
    }
    // A denied rule also takes the audited path, which records and rejects it.
    function next() {
      const { decision, pending } = agent.eventStreamState(after);
      return pending || decision !== "allow" ? read() : { events: [] };
    }
    // Validate the first cursor and permission before committing HTTP 200.
    let page = read();
    let timer,
      closed = false,
      heartbeat = Date.now();
    function cleanup() {
      closed = true;
      clearTimeout(timer);
      streams.delete(close);
    }
    function close(destroy = false) {
      if (closed) return;
      cleanup();
      if (destroy) res.destroy();
      else res.end();
    }
    function write(frame) {
      if (Buffer.byteLength(frame) > sseLimits.frameBytes)
        throw apiFailure(
          "STREAM_EVENT_TOO_LARGE",
          "Event exceeds the stream byte limit; use paged events.",
        );
      if (!res.write(frame)) {
        close(true);
        return false;
      }
      return true;
    }
    function pump() {
      if (closed) return;
      try {
        for (let count = 0; count < sseLimits.eventsPerTurn; count++) {
          const entry = page.events[0];
          if (!entry) break;
          if (
            !write(
              "event: budget-event\nid: " +
                entry.cursor +
                "\ndata: " +
                JSON.stringify({ version: 1, ...entry }) +
                "\n\n",
            )
          )
            return;
          after = entry.cursor;
          page = next();
        }
        if (Date.now() - heartbeat >= sseLimits.heartbeatMs) {
          if (!write(": heartbeat\n\n")) return;
          heartbeat = Date.now();
        }
        timer = setTimeout(
          () => {
            try {
              page = next();
              pump();
            } catch (error) {
              fail(error);
            }
          },
          page.events.length ? 1 : sseLimits.pollMs,
        );
        timer.unref();
      } catch (error) {
        fail(error);
      }
    }
    function fail(error) {
      try {
        write(
          "event: stream-error\ndata: " +
            JSON.stringify({ ok: false, error: apiError(error) }) +
            "\n\n",
        );
      } catch {
        close(true);
      } finally {
        close();
      }
    }
    streams.add(close);
    res.once("close", cleanup);
    res.once("error", () => close(true));
    res.set("Content-Type", "text/event-stream; charset=utf-8");
    if (write(": connected\n\n")) pump();
  }

  return {
    open,
    close: () => {
      for (const close of streams) close();
    },
  };
}
