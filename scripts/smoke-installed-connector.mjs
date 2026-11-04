// Installed connector smoke, Windows CI only: the installed runtime's runner
// runs the example component through the installed nemein-connector.exe, then
// the sizes the encargo asks for are measured. Fictitious data only.
import { readFileSync, statSync, appendFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const [root, componentPath, installerPath] = process.argv.slice(2);
const { runConnector } = await import(
  pathToFileURL(path.join(root, "runtime", "src", "connector-runner.js"))
);
const binary = path.join(root, "nemein-connector.exe");
const component = readFileSync(componentPath);
const fixtures = new URL(
  "../src-tauri/connector/examples/fictitious-bank-csv/fixtures/",
  import.meta.url,
);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", fixtures)));

const described = await runConnector({
  op: "describe",
  component,
  accountId: "1",
  command: binary,
});
assert.deepEqual(described.manifest, manifest);
const started = performance.now();
const parsed = await runConnector({
  op: "parse",
  component,
  input: readFileSync(new URL("extracto.csv", fixtures)),
  accountId: "1",
  command: binary,
  expectedManifest: manifest,
});
const elapsed = Math.round(performance.now() - started);
assert.equal(
  JSON.stringify(parsed.batch) + "\n",
  readFileSync(new URL("extracto.batch.json", fixtures), "utf8"),
);
const left = execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    "@(Get-Process -Name nemein-connector -ErrorAction SilentlyContinue).Count",
  ],
  { encoding: "utf8", windowsHide: true },
).trim();
assert.equal(left, "0", "no connector process is left behind");

const executable = readFileSync(binary);
const sizes = [
  ["nemein-connector.exe instalado", executable.length],
  [
    "nemein-connector.exe comprimido con zlib 9 (aprox. lo que suma al instalador)",
    deflateSync(executable, { level: 9 }).length,
  ],
  ["nemein.exe instalado", statSync(path.join(root, "nemein.exe")).size],
  ["Instalador NSIS", statSync(installerPath).size],
];
const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MiB";
for (const [name, bytes] of sizes)
  console.log(`${name}: ${bytes} bytes (${mb(bytes)})`);
console.log(`Ejecución instalada del ejemplo: ${elapsed} ms`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    "### Conector instalado\n\n| Medida | Bytes | MiB |\n| --- | ---: | ---: |\n" +
      sizes.map(([n, b]) => `| ${n} | ${b} | ${mb(b)} |`).join("\n") +
      `\n\nEjecución del ejemplo con el conector instalado: ${elapsed} ms.\n`,
  );
console.log(
  "INSTALLED CONNECTOR OK: describe, parse, golden batch, no leftover processes.",
);
