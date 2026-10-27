import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import fc from "fast-check";

const project = fileURLToPath(new URL("../", import.meta.url));
const expected = readFileSync(
  path.join(project, ".node-version"),
  "utf8",
).trim();
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nemein-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of [
    "scripts",
    "src",
    "public",
    "views",
    "desktop-resources/runtime",
  ])
    mkdirSync(path.join(root, folder), { recursive: true });
  copyFileSync(
    path.join(project, "scripts/prepare-desktop.js"),
    path.join(root, "scripts/prepare-desktop.js"),
  );
  writeFileSync(
    path.join(root, "scripts/desktop-notices.js"),
    "export function writeDesktopNotices() {}\n",
  );
  writeFileSync(
    path.join(root, "npm-cli.cjs"),
    "console.log(process.cwd());\n",
  );
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  for (const name of [
    "LICENSE",
    "PRIVACIDAD.md",
    "src/fixture.txt",
    "public/fixture.txt",
    "views/fixture.txt",
  ])
    writeFileSync(path.join(root, name), "fixture");
  writeFileSync(path.join(root, ".node-version"), expected + "\n");
  const target = path.join(root, "desktop-resources/runtime");
  writeFileSync(path.join(target, "preserve.txt"), "previous runtime");
  const run = (version) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        (version === undefined
          ? ""
          : `Object.defineProperty(process,'version',{value:${JSON.stringify(version)}});`) +
          `await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/prepare-desktop.js")).href)});`,
      ],
      {
        cwd: root,
        env: { ...process.env, npm_execpath: path.join(root, "npm-cli.cjs") },
        encoding: "utf8",
        timeout: 15000,
      },
    );
  return { root, target, run };
}
function rejected(f, version) {
  const r = f.run(version);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(
    r.stderr
      .replaceAll("\r\n", "\n")
      .includes(
        `La compilación requiere Node ${expected}; estás usando ${version}.`,
      ),
    r.stderr,
  );
  assert.deepEqual(readdirSync(f.target), ["preserve.txt"]);
  assert.equal(
    readFileSync(path.join(f.target, "preserve.txt"), "utf8"),
    "previous runtime",
  );
}
test("desktop build rejects vulnerable or unvalidated Node before touching the runtime", (t) => {
  const f = fixture(t);
  for (const version of ["v22.23.2", "v22.23.3", "v24.22.1", "v26.12.1"])
    rejected(f, version);
});
test("desktop build copies the verified executable and records its exact Node version", (t) => {
  const f = fixture(t),
    r = f.run();
  assert.equal(r.status, 0, r.stderr);
  const executable = path.join(
    f.target,
    process.platform === "win32" ? "node.exe" : "node",
  );
  assert.equal(
    execFileSync(executable, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    `v${expected}`,
  );
  const sha = (file) =>
    createHash("sha256").update(readFileSync(file)).digest("hex");
  assert.equal(sha(executable), sha(process.execPath));
  assert.equal(
    readFileSync(path.join(f.target, ".node-version"), "utf8"),
    expected + "\n",
  );
  for (const name of [
    "package.json",
    "LICENSE",
    "PRIVACIDAD.md",
    "src/fixture.txt",
    "public/fixture.txt",
    "views/fixture.txt",
  ])
    assert.equal(
      readFileSync(path.join(f.target, name), "utf8"),
      readFileSync(path.join(f.root, name), "utf8"),
    );
});
test("PBT: no other Node version can prepare a distributable", (t) => {
  const f = fixture(t);
  fc.assert(
    fc.property(
      fc
        .tuple(
          fc.integer({ min: 0, max: 40 }),
          fc.integer({ min: 0, max: 40 }),
          fc.integer({ min: 0, max: 40 }),
        )
        .filter((parts) => parts.join(".") !== expected),
      (parts) => rejected(f, "v" + parts.join(".")),
    ),
    { seed: 22234, numRuns: 8 },
  );
});
test("fuzz: malformed version strings leave the generated runtime intact", (t) => {
  const f = fixture(t);
  for (const value of [
    "",
    expected,
    `v${expected}\n`,
    `v${expected}-rc.1`,
    "v22.23.4\u0000",
    "../../node",
    "v２２.23.4",
  ])
    rejected(f, value);
});
test("runtime pins stay aligned across package metadata and CI", () => {
  const pkg = JSON.parse(readFileSync(path.join(project, "package.json")));
  const lock = JSON.parse(
    readFileSync(path.join(project, "package-lock.json")),
  );
  assert.equal(pkg.engines.node, "^" + expected);
  assert.equal(lock.packages[""].engines.node, pkg.engines.node);
  const ci = readFileSync(
    path.join(project, ".github/workflows/quality.yml"),
    "utf8",
  );
  assert.ok(ci.includes(`IMAGE: node:${expected}-bookworm@sha256:`));
  assert.ok(ci.includes("node-version-file: .node-version"));
});
