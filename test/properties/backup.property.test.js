import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { openBudget } from "../../src/core.js";
import { externalBackup } from "../../src/backup.js";
test("PBT: external backups conserve arbitrary ledger sequences", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 1000000 }), {
        minLength: 1,
        maxLength: 12,
      }),
      async (amounts) => {
        const root = mkdtempSync(path.join(os.tmpdir(), "backup-pbt-")),
          b = openBudget(path.join(root, "data"));
        try {
          const account_id = b.createAccount({
            name: "Fixture",
            type: "efectivo",
            balance: 0,
          });
          for (const amount of amounts)
            b.addTransaction({
              account_id,
              amount,
              payee: "Fixture",
              date: "2026-10-01",
            });
          const file = await externalBackup(b.db, root),
            copy = new Database(file, { readonly: true });
          try {
            assert.deepEqual(
              copy.prepare("SELECT * FROM transactions ORDER BY id").all(),
              b.db.prepare("SELECT * FROM transactions ORDER BY id").all(),
            );
          } finally {
            copy.close();
          }
        } finally {
          b.close();
          rmSync(root, { recursive: true, force: true });
        }
      },
    ),
    { seed: 261026, numRuns: 12 },
  );
});
