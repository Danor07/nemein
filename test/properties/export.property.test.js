import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { parse } from "csv-parse/sync";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBudget } from "../../src/core.js";

test("PBT: financial JSON and RFC4180 CSV round-trip exactly without changing balances", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-export-property-")),
    b = openBudget(dir);
  try {
    const ids = ["One", "Two"].map((name) =>
      b.createAccount({ name, type: "efectivo" }),
    );
    const text = fc
      .array(
        fc.constantFrom(
          "a",
          "á",
          "中",
          "😀",
          '"',
          ",",
          "\r",
          "\n",
          "\t",
          " ",
          "=",
          "@",
          "+",
          "-",
        ),
        { maxLength: 35 },
      )
      .map((parts) => "Payee " + parts.join("") + " end");
    const dates = fc
      .tuple(
        fc.integer({ min: 2020, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
      )
      .map((parts) =>
        parts.map((n, i) => String(n).padStart(i ? 2 : 4, "0")).join("-"),
      );
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            payee: text,
            date: dates,
            amount: fc
              .integer({ min: -1000000000, max: 1000000000 })
              .filter((n) => n !== 0),
            account: fc.integer({ min: 0, max: 1 }),
          }),
          { maxLength: 20 },
        ),
        (rows) => {
          b.db.exec("DELETE FROM transactions");
          for (const row of rows)
            b.addTransaction({
              ...row,
              account_id: ids[row.account],
              category_id: 1,
            });
          const before = b.snapshot("2030-12"),
            cursor = b.eventSnapshot().cursor;
          const json = b.exportData(),
            doc = JSON.parse(json.content),
            csv = b.exportData({ format: "csv" });
          const decoded = parse(csv.content, {
            columns: true,
            record_delimiter: "\r\n",
          });
          assert.equal(doc.data.transactions.length, rows.length);
          assert.equal(csv.row_count, rows.length);
          assert.equal(doc.cursor, cursor);
          assert.equal(csv.cursor, cursor);
          assert.equal(doc.currency, "PYG");
          assert.equal(csv.currency, "PYG");
          assert.equal(doc.amount_unit, "integer");
          assert.equal(csv.amount_unit, "integer");
          const numbers = new Set([
            "id",
            "account_id",
            "amount",
            "category_id",
            "cleared",
            "reconciled",
          ]);
          const reconstructed = decoded.map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                numbers.has(key)
                  ? value === ""
                    ? null
                    : Number(value)
                  : key === "transfer_key" && value === ""
                    ? null
                    : value,
              ]),
            ),
          );
          assert.deepEqual(reconstructed, doc.data.transactions);
          assert.equal(
            doc.data.transactions.reduce(
              (n, row) => n + BigInt(row.amount),
              0n,
            ),
            rows.reduce((n, row) => n + BigInt(row.amount), 0n),
          );
          assert.equal(
            decoded.reduce((n, row) => n + BigInt(row.amount), 0n),
            rows.reduce((n, row) => n + BigInt(row.amount), 0n),
          );
          assert.deepEqual(b.snapshot("2030-12"), before);
          assert.equal(b.eventSnapshot().cursor, cursor);
        },
      ),
      { seed: 525252, numRuns: 100 },
    );
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
