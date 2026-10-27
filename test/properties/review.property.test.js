import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openBudget } from "../../src/core.js";
test("PBT: review cutoffs conserve real funds and reserve future allocations", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          amount: fc.integer({ min: -1000, max: 1000 }).filter((n) => n !== 0),
          day: fc.integer({ min: 1, max: 28 }),
        }),
        { maxLength: 30 },
      ),
      fc.integer({ min: 1, max: 28 }),
      fc.integer({ min: 0, max: 10000 }),
      (movements, day, reserve) => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "review-pbt-")),
          b = openBudget(dir);
        try {
          const account_id = b.createAccount({
            name: "Fixture",
            type: "efectivo",
            balance: 10000,
            date: "2026-01-01",
          });
          b.allocate({ month: "2026-02", category_id: 1, amount: reserve });
          for (const t of movements)
            b.addTransaction({
              account_id,
              payee: "Fixture",
              amount: t.amount,
              category_id: t.amount < 0 ? 1 : null,
              date: `2026-01-${String(t.day).padStart(2, "0")}`,
            });
          const cut = `2026-01-${String(day).padStart(2, "0")}`,
            p = b.reviewPackage({ from: "2026-01-01", to: cut, as_of: cut }),
            included = movements.filter((t) => t.day <= day);
          assert.equal(
            p.recorded.accounts[0].balance,
            10000 + included.reduce((s, t) => s + t.amount, 0),
          );
          assert.equal(
            p.recorded.ready,
            10000 +
              included
                .filter((t) => t.amount > 0)
                .reduce((s, t) => s + t.amount, 0) -
              reserve,
          );
          assert.equal(p.evidence.length, included.length + 1);
          const before = b.eventSnapshot().cursor;
          b.saveReview({
            id: "f",
            package: p,
            report: "",
            generator: "Fixture",
          });
          b.markReview({ id: "f" });
          assert.equal(b.eventSnapshot().cursor, before);
        } finally {
          b.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    ),
    { seed: 261028, numRuns: 30 },
  );
});
