import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

test("OpenAPI generation is reproducible and --check rejects drift without rewriting the artifact", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nemein-openapi-generator-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["src", "scripts", "docs"])
    mkdirSync(path.join(root, name));
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  copyFileSync(
    new URL("../scripts/generate-openapi.js", import.meta.url),
    path.join(root, "scripts/generate-openapi.js"),
  );
  writeFileSync(
    path.join(root, "src/openapi.js"),
    'export function generateOpenApi() { return {openapi:"3.1.0",info:{title:"Fixture",version:"1.0.0"}}; }',
  );
  const file = path.join(root, "docs/openapi.v1.json");
  const expected =
    '{\n  "openapi": "3.1.0",\n  "info": {\n    "title": "Fixture",\n    "version": "1.0.0"\n  }\n}\n';
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/generate-openapi.js", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
    });
  writeFileSync(file, expected);
  assert.equal(run("--check").status, 0);
  assert.equal(readFileSync(file, "utf8"), expected);
  writeFileSync(file, "stale fixture\n");
  const stale = run("--check");
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /OpenAPI is stale/);
  assert.equal(readFileSync(file, "utf8"), "stale fixture\n");
  assert.equal(run().status, 0);
  assert.equal(readFileSync(file, "utf8"), expected);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(file, "utf8"), expected);
});
