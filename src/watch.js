import { setTimeout } from "node:timers/promises";
import { execute, assertEventRead } from "./commands.js";

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_WATCH_OPTIONS" });
}
export function watchOptions(p) {
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).some(
      (k) => !["after", "limit", "poll_ms", "format", "once"].includes(k),
    )
  )
    throw invalid("Opciones de watch inválidas.");
  const {
    after,
    limit = 100,
    poll_ms = 1000,
    format = "ndjson",
    once = false,
  } = p;
  if (
    typeof after !== "string" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isSafeInteger(poll_ms) ||
    poll_ms < 100 ||
    poll_ms > 60000 ||
    !["ndjson", "json-seq"].includes(format) ||
    typeof once !== "boolean"
  )
    throw invalid(
      "watch requiere after, limit 1–1000, poll_ms 100–60000 y format ndjson o json-seq.",
    );
  return { after, limit, poll_ms, format, once };
}

export function parseWatchFlags(args) {
  const p = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const key = {
      "--after": "after",
      "--limit": "limit",
      "--poll-ms": "poll_ms",
      "--format": "format",
      "--once": "once",
    }[flag];
    if (!key || Object.hasOwn(p, key))
      throw invalid("Opción desconocida o repetida: " + flag);
    if (key === "once") p.once = true;
    else {
      const value = args[++i];
      if (value === undefined || value.startsWith("--"))
        throw invalid("Falta el valor de " + flag);
      p[key] = ["limit", "poll_ms"].includes(key)
        ? /^\d+$/.test(value)
          ? Number(value)
          : NaN
        : value;
    }
  }
  return watchOptions(p);
}

export async function watchEvents(budget, options, { signal, write } = {}) {
  const p = watchOptions(options);
  let after = p.after;
  while (!signal?.aborted) {
    assertEventRead();
    const page = await execute(budget, "events", { after, limit: p.limit });
    for (const entry of page.events) {
      if (signal?.aborted) return;
      await write(
        (p.format === "json-seq" ? "\x1e" : "") +
          JSON.stringify({ version: 1, ...entry }) +
          "\n",
      );
      after = entry.cursor;
    }
    if (p.once) return;
    if (!page.hasMore) {
      try {
        await setTimeout(p.poll_ms, undefined, { signal });
      } catch (e) {
        if (e.name === "AbortError") return;
        throw e;
      }
    }
  }
}
