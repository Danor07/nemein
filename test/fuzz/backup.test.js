import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { externalBackup } from "../../src/backup.js";
test("fuzz: invalid external destinations never reach SQLite", async () => {
  let touched = 0;
  const db = {
    prepare: () => {
      touched++;
      throw Error("database reached");
    },
  };
  await fc.assert(
    fc.asyncProperty(fc.jsonValue(), async (value) => {
      if (typeof value === "string") value = "relative-" + value;
      await assert.rejects(externalBackup(db, value));
    }),
    { seed: 261027, numRuns: 100 },
  );
  assert.equal(touched, 0);
});
