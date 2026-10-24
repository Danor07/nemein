import { readAgentToken } from "./credentials.js";
import { readFileSync } from "node:fs";
import { openBudget } from "./core.js";
import { commands, execute, proposalFile } from "./commands.js";
import { parseWatchFlags, watchOptions, watchEvents } from "./watch.js";
const args = process.argv.slice(2),
  [command = "help", raw = "{}", file] = args;
if (command === "help")
  console.log(
    JSON.stringify(
      {
        usage:
          "nemein.cmd <comando> <JSON> | <comando> --file solicitud.json | <comando> --stdin",
        commands: [
          ...Object.keys(commands),
          "watch",
          "proposal-create",
          "proposal-submit",
          "proposal-status",
          "permissions",
        ],
        authentication:
          "BUDGET_AGENT_TOKEN_FILE y BUDGET_AGENT_VERSION (1 por defecto), creados en Permisos y propuestas. BUDGET_AGENT_TOKEN se mantiene por compatibilidad. Sin permisos por defecto.",
        watch:
          "watch --after CURSOR [--limit 100] [--poll-ms 1000] [--format ndjson|json-seq] [--once]",
        proposals:
          "proposal-create no requiere base abierta: genera un archivo entregable después. Guardá .result del JSON. proposal-submit lo entrega y proposal-status consulta la respuesta.",
      },
      null,
      2,
    ),
  );
else {
  let owner;
  const controller = new AbortController(),
    stop = () => controller.abort(),
    stdoutError = (e) => controller.abort(e);
  try {
    if (
      command !== "watch" &&
      ![
        "proposal-create",
        "proposal-submit",
        "proposal-status",
        "permissions",
      ].includes(command) &&
      !Object.hasOwn(commands, command)
    )
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
    if (command === "proposal-create")
      console.log(JSON.stringify({ ok: true, result: proposalFile(p) }));
    else {
      const token = readAgentToken();
      if (!token)
        throw Object.assign(
          new Error(
            "Configurá BUDGET_AGENT_TOKEN_FILE desde Permisos y propuestas.",
          ),
          { code: "AUTH_REQUIRED" },
        );
      owner = openBudget();
      const b = owner.forAgent(token, process.env.BUDGET_AGENT_VERSION || "1");
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
      } else
        console.log(
          JSON.stringify({
            ok: true,
            result: (await execute(b, command, p)) ?? null,
          }),
        );
    }
  } catch (e) {
    if (e.code !== "EPIPE") {
      console.error(
        JSON.stringify({
          ok: false,
          error: e.message,
          code: e.code || "INVALID_REQUEST",
          ...(e.proposal_id ? { proposal_id: e.proposal_id } : {}),
        }),
      );
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    owner?.close();
  }
}
