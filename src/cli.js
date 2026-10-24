import { readFileSync } from "node:fs";
import { openBudget } from "./core.js";
import { commands, execute, assertEventRead } from "./commands.js";
import { parseWatchFlags, watchOptions, watchEvents } from "./watch.js";
const args = process.argv.slice(2);
const [command = "help", raw = "{}", file] = args;

if (command === "help") {
  console.log(
    JSON.stringify(
      {
        usage:
          "node src/cli.js <comando> <JSON> | <comando> --file solicitud.json | <comando> --stdin",
        commands: [...Object.keys(commands), "watch"],
        watch:
          "watch --after CURSOR [--limit 100] [--poll-ms 1000] [--format ndjson|json-seq] [--once]",
        eventRead:
          "event-snapshot, events y watch requieren BUDGET_EVENTS_READ=1. watch también acepta JSON, --file y --stdin.",
        note: "Todos los importes son guaraníes enteros. reconcile confirma solo con commit:true.",
      },
      null,
      2,
    ),
  );
} else {
  let b;
  const controller = new AbortController();
  const stop = () => controller.abort();
  const stdoutError = (e) => controller.abort(e);
  try {
    if (["event-snapshot", "events", "watch"].includes(command))
      assertEventRead();
    if (command !== "watch" && !Object.hasOwn(commands, command))
      throw Error("Comando desconocido.");
    const input =
      command === "watch" &&
      raw.startsWith("--") &&
      !["--file", "--stdin"].includes(raw)
        ? parseWatchFlags(args.slice(1))
        : JSON.parse(
            (raw === "--file"
              ? readFileSync(file, "utf8")
              : raw === "--stdin"
                ? readFileSync(0, "utf8")
                : raw
            ).replace(/^\uFEFF/, ""),
          );
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error("La solicitud debe ser un objeto JSON.");
    const p = command === "watch" ? watchOptions(input) : input;
    b = openBudget();
    await b.backup();
    if (command === "watch") {
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      process.stdout.on("error", stdoutError);
      await watchEvents(b, p, {
        signal: controller.signal,
        write: (chunk) =>
          new Promise((resolve, reject) =>
            process.stdout.write(chunk, (e) => (e ? reject(e) : resolve())),
          ),
      });
    } else {
      const result = await execute(b, command, p);
      console.log(JSON.stringify({ ok: true, result: result ?? null }));
    }
  } catch (e) {
    if (e.code !== "EPIPE") {
      console.error(
        JSON.stringify({
          ok: false,
          error: e.message,
          ...(e.code ? { code: e.code } : {}),
        }),
      );
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    // Keep the stdout error listener until queued writes have finished closing.
    b?.close();
  }
}
