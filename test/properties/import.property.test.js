import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import vectors from "../fixtures/import-vectors.json" with { type: "json" };
import {
  csvImportBatch,
  validateImportBatch,
} from "../../src/import-contract.js";

test("PBT: exact signed money, stable identities and declared inclusive periods survive validation unchanged", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          day: fc.integer({ min: 1, max: 29 }),
          amount: fc
            .integer({ min: -1000000000000, max: 1000000000000 })
            .filter((x) => x !== 0),
        }),
        { maxLength: 25 },
      ),
      (rows) => {
        const b = structuredClone(vectors.valid[0].batch);
        b.entries = rows.map((r, i) => ({
          id: i.toString(16).padStart(64, "0"),
          date: "2024-02-" + String(r.day).padStart(2, "0"),
          payee: "Fixture",
          amount: r.amount,
          category_id: r.amount < 0 ? 1 : null,
        }));
        const before = JSON.stringify(b);
        assert.equal(validateImportBatch(b), b);
        assert.equal(JSON.stringify(b), before);
        assert.deepEqual(csvImportBatch(1, b.entries).entries, b.entries);
        assert.equal(
          b.entries.reduce((n, r) => n + r.amount, 0),
          rows.reduce((n, r) => n + r.amount, 0),
        );
        if (b.entries.length) {
          b.entries.push({ ...b.entries[0] });
          assert.throws(() => validateImportBatch(b), {
            code: "IMPORT_DUPLICATE_ID",
          });
        }
      },
    ),
    { seed: 151515, numRuns: 200 },
  );
});

test("PBT: shrinking a declared period rejects dates on either excluded side", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 28 }), (day) => {
      const b = structuredClone(vectors.valid[0].batch);
      const at = (d) => "2024-02-" + String(d).padStart(2, "0");
      b.period = { from: at(day), to: at(day) };
      b.entries[0].date = at(day);
      assert.equal(validateImportBatch(b), b);
      for (const outside of [day - 1, day + 1]) {
        b.entries[0].date = at(outside);
        assert.throws(() => validateImportBatch(b), {
          code: "IMPORT_OUTSIDE_PERIOD",
        });
      }
    }),
    { seed: 151516, numRuns: 100 },
  );
});
