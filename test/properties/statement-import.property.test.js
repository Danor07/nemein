import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { statementImportBatch } from "../../src/statement-import.js";
import { ofx, ofxRow, camt, camtRow } from "../fixtures/statements.js";

test("PBT statements: exact integer signs, independent civil dates, stable IDs under reorder and changed descriptions", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          amount: fc.integer({ min: 1, max: 1e12 }),
          debit: fc.boolean(),
          day: fc.integer({ min: 1, max: 28 }),
        }),
        { minLength: 1, maxLength: 12 },
      ),
      (rows) => {
        for (const format of ["ofx", "camt053"]) {
          const input = rows.map((row, i) => {
            const day = String(row.day).padStart(2, "0");
            const id = "fixture-" + i;
            return format === "ofx"
              ? ofxRow({
                  id,
                  amount: `${row.debit ? "-" : ""}${row.amount}.000`,
                  date: `202610${day}000100[14:TEST]`,
                })
              : camtRow({
                  id,
                  amount: `${row.amount}.000`,
                  sign: row.debit ? "DBIT" : "CRDT",
                  date: `<DtTm>2026-10-${day}T23:59:59-12:00</DtTm>`,
                });
          });
          const wrap = format === "ofx" ? ofx : camt;
          const parse = (xml) =>
            statementImportBatch(xml, { format }, 1).entries;
          const entries = parse(wrap(input.join("")));
          assert.deepEqual(
            entries.map((entry) => entry.amount),
            rows.map((row) => row.amount * (row.debit ? -1 : 1)),
          );
          assert.deepEqual(
            entries.map((entry) => entry.date),
            rows.map((row) => `2026-10-${String(row.day).padStart(2, "0")}`),
          );
          assert.deepEqual(
            parse(wrap([...input].reverse().join(""))).map((entry) => entry.id),
            entries.map((entry) => entry.id).reverse(),
          );
          assert.deepEqual(
            parse(
              wrap(input.join("").replaceAll("Fixture shop", "Changed memo")),
            ).map((entry) => entry.id),
            entries.map((entry) => entry.id),
          );
          assert.throws(() => parse(wrap(input.join("") + input[0])), {
            code: "IMPORT_DUPLICATE_ID",
          });
        }
      },
    ),
    { seed: 805301, numRuns: 100 },
  );
});

test("PBT statements: every nonzero fractional part is rejected without floating point rounding", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1e12 }),
      fc.integer({ min: 1, max: 999999 }),
      (whole, fraction) => {
        const amount = `${whole}.${String(fraction).padStart(6, "0")}`;
        for (const [format, content] of [
          ["ofx", ofx(ofxRow({ amount }))],
          ["camt053", camt(camtRow({ amount }))],
        ])
          assert.throws(() => statementImportBatch(content, { format }, 1), {
            code: "IMPORT_AMOUNT",
          });
      },
    ),
    { seed: 805302, numRuns: 150 },
  );
});
