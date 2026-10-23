import { readFileSync } from "node:fs";
import { openBudget } from "./core.js";
import { commands, execute } from "./commands.js";
const [command = "help", raw = "{}", file] = process.argv.slice(2);

if (command === "help") {
  console.log(
    JSON.stringify(
      {
        usage:
          "node src/cli.js <comando> <JSON> | <comando> --file solicitud.json | <comando> --stdin",
        commands: Object.keys(commands),
        note: "Todos los importes son guaraníes enteros. reconcile confirma solo con commit:true.",
      },
      null,
      2,
    ),
  );
} else {
  let b;
  try {
    const input =
      raw === "--file"
        ? readFileSync(file, "utf8")
        : raw === "--stdin"
          ? readFileSync(0, "utf8")
          : raw;
    const p = JSON.parse(input.replace(/^\uFEFF/, ""));
    b = openBudget();
    await b.backup();
    if (!commands[command]) throw Error("Comando desconocido.");
    const result = await execute(b,command,p);
    console.log(JSON.stringify({ ok: true, result: result ?? null }));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exitCode = 1;
  } finally {
    b?.close();
  }
}
