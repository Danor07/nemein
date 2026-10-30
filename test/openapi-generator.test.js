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
import { generateOpenApi } from "../src/openapi.js";
import { actions, connectionActions } from "../src/actions.js";
import { schemaValidator } from "./helpers/openapi-schemas.js";

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

test("Generated OpenAPI is current, covers only catalogs, and all schema references resolve", () => {
  const document = generateOpenApi();
  assert.deepEqual(
    JSON.parse(
      readFileSync(new URL("../docs/openapi.v1.json", import.meta.url), "utf8"),
    ),
    document,
  );
  assert.equal(document.openapi, "3.1.0");
  assert.equal(document.info.version, "1.1.0");
  assert.deepEqual(
    Object.keys(document.paths).sort(),
    [
      ...Object.keys(actions),
      ...Object.keys(connectionActions),
      "calls",
      "openapi.json",
      "events/stream",
    ]
      .map((a) => "/api/v1/" + a)
      .sort(),
  );
  const compile = schemaValidator(document);
  for (const name of Object.keys(document.components.schemas)) compile(name);
  const stream = document.paths["/api/v1/events/stream"].get;
  assert.equal(stream.operationId, "eventStream");
  assert.equal(stream["x-nemein-action"], "events");
  assert.deepEqual(stream["x-nemein-stream-limits"], {
    streams: 8,
    eventsPerTurn: 100,
    pollMs: 1000,
    heartbeatMs: 15000,
    frameBytes: 65536,
  });
  assert.deepEqual(stream.parameters[1], {
    in: "header",
    name: "Last-Event-ID",
    required: true,
    schema: document.components.schemas["event-stream"].properties.cursor,
    description:
      "Snapshot cursor on first connection; last processed event cursor on reconnect. Duplicates are rejected. Never a CloudEvents id.",
  });
  assert.deepEqual(stream.responses[200].content["text/event-stream"], {
    schema: { type: "string" },
    "x-nemein-record-schema": { $ref: "#/components/schemas/event-stream" },
  });
  assert.ok(stream.responses[429]);
});
