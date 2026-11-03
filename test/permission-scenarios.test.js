import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scenarios, runScenario } from "./helpers/permission-scenarios.js";

const oracle = JSON.parse(
  readFileSync(new URL("./fixtures/permission-scenarios.json", import.meta.url), "utf8"),
);

test("The permission scenarios file lists every scenario the engine runs", () => {
  assert.deepEqual(
    oracle.scenarios.map((s) => s.name),
    scenarios.map((s) => s.name),
  );
});

for (const scenario of scenarios)
  test("Permission scenario: " + scenario.name, async () => {
    assert.deepEqual(
      await runScenario(scenario),
      oracle.scenarios.find((s) => s.name === scenario.name),
    );
  });
