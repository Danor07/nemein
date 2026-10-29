import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import vectors from "../fixtures/import-vectors.json" with { type: "json" };
import { validateImportBatch } from "../../src/import-contract.js";

test("fuzz: hostile JSON cannot bypass the closed import envelope or mutate its input", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const before = structuredClone(value);
      assert.throws(() => validateImportBatch(value), {
        code: "IMPORT_INVALID_BATCH",
      });
      assert.deepEqual(value, before);
      const b = structuredClone(vectors.valid[0].batch);
      for (const key of [
        "version",
        "account_id",
        "period",
        "entries",
        "provenance",
      ]) {
        const invalid = { ...b, [key]: value };
        try {
          validateImportBatch(invalid);
        } catch (error) {
          assert.match(
            error.code,
            /^IMPORT_(INVALID_BATCH|INVALID_DATE|INVALID_PERIOD|OUTSIDE_PERIOD|DUPLICATE_ID)$/,
          );
        }
        assert.deepEqual(value, before);
      }
    }),
    { seed: 151517, numRuns: 400 },
  );
});

test("fuzz: injected fields and poisoned money, identities and dates are rejected", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 100 }), (tail) => {
      const b = structuredClone(vectors.valid[0].batch);
      for (const [key, value] of [
        ["amount", "1" + tail],
        ["id", "../" + tail],
        ["date", "<" + tail],
        ["duplicate", true],
        ["__proto__", { admin: true }],
      ]) {
        const poisoned = { ...b, entries: [{ ...b.entries[0], [key]: value }] };
        assert.throws(() => validateImportBatch(poisoned), {
          code: "IMPORT_INVALID_BATCH",
        });
      }
    }),
    { seed: 151518, numRuns: 200 },
  );
});
