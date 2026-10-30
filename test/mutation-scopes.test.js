import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("CI runs every mutation scope and the local gate runs the same ones", () => {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  const scopes = Object.keys(scripts)
    .filter((name) => name.startsWith("mutation:"))
    .map((name) => name.slice("mutation:".length));
  const ci = readFileSync(".github/workflows/quality.yml", "utf8");
  const matrix = /^\s+scope:\s+\[([^\]]+)\]/m.exec(ci)[1]
    .trim()
    .replace(/,$/, "")
    .split(/\s*,\s*/);
  assert.deepEqual(matrix, scopes);
  assert.equal(
    scripts["test:mutation"],
    scopes.map((scope) => "npm run mutation:" + scope).join(" && "),
  );
  for (const config of readdirSync(".").filter((file) =>
    /^stryker\..*config\.mjs$/.test(file),
  ))
    assert.ok(
      scopes.some((scope) => scripts["mutation:" + scope].includes(config)),
      config + " has no mutation script",
    );
});
