import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { openBudget } from "../../src/core.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
test("PBT: transfers conserve wealth; ready plus envelopes equals cash", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 10000000 }),
      fc.integer({ min: 0, max: 1000000 }),
      fc.array(fc.integer({ min: 1, max: 100000 }), { maxLength: 10 }),
      (opening, allocated, expenses) => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-pbt-")),
          b = openBudget(dir);
        try {
          const a = b.createAccount({
            name: "A",
            type: "efectivo",
            balance: opening,
            date: "2026-10-01",
          });
          const c = b.createAccount({
            name: "B",
            type: "corriente",
            balance: 0,
            date: "2026-10-01",
          });
          b.allocate({ month: "2026-10", category_id: 1, amount: allocated });
          for (const amount of expenses) {
            b.transfer({ from: a, to: c, amount, date: "2026-10-02" });
            b.addTransaction({
              account_id: c,
              date: "2026-10-03",
              payee: "Fixture",
              amount: -amount,
              category_id: 1,
            });
          }
          const s = b.snapshot("2026-10"),
            wealth = s.accounts.reduce((n, a) => n + a.balance, 0);
          assert.equal(wealth, opening - expenses.reduce((a, b) => a + b, 0));
          assert.equal(
            s.ready + s.categories.reduce((n, c) => n + c.available, 0),
            wealth,
          );
          assert.equal(
            b.db.prepare("SELECT COUNT(*) n FROM budget_events").get().n,
            3 + expenses.length * 2,
          );
        } finally {
          b.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    ),
    { seed: 424242, numRuns: 60 },
  );
});

test("PBT: quoted UTF-8 imports conserve totals and retries keep multiplicity", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          payee: fc.constantFrom(
            "Mercado",
            "Café",
            "A;B",
            'Dice "hola"',
            "Pago\nlínea",
            "重复",
          ),
          amount: fc.integer({ min: 1, max: 50000 }),
        }),
        { minLength: 1, maxLength: 12 },
      ),
      (rows) => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-csv-pbt-")),
          b = openBudget(dir);
        try {
          const account = b.createAccount({
            name: "CSV",
            type: "corriente",
            balance: 10000000,
            date: "2026-10-01",
          });
          const quote = (text) => '"' + text.replaceAll('"', '""') + '"';
          const content =
            "Fecha;Descripción;Importe\n" +
            rows
              .map((r) => "2026-10-02;" + quote(r.payee) + ";-" + r.amount)
              .join("\n");
          const p = {
            account_id: account,
            content,
            config: {
              date: "Fecha",
              payee: "Descripción",
              amount: "Importe",
              delimiter: ";",
              dateFormat: "iso",
              thousands: "none",
              category_id: 1,
            },
          };
          assert.equal(b.importCsv(p).added, rows.length);
          assert.equal(b.importCsv(p).duplicates, rows.length);
          assert.equal(b.accountTransactions(account).length, rows.length + 1);
          assert.equal(
            b.snapshot("2026-10").accounts[0].balance,
            10000000 - rows.reduce((n, r) => n + r.amount, 0),
          );
        } finally {
          b.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    ),
    { seed: 424242, numRuns: 40 },
  );
});
