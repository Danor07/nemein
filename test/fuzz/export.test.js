import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBudget } from "../../src/core.js";
import { exportData } from "../../src/export.js";
test("fuzz: hostile export options cannot select tables, write files or mutate data", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-export-fuzz-")),
    b = openBudget(dir);
  try {
    const position = { source: "fixture", cursor: "fixture" };
    const before = b.db.prepare("SELECT total_changes() n").get().n;
    fc.assert(
      fc.property(fc.jsonValue(), (options) => {
        const valid =
          options !== null &&
          typeof options === "object" &&
          !Array.isArray(options) &&
          Object.keys(options).every((k) => k === "format") &&
          (!Object.hasOwn(options, "format") ||
            options.format === "json" ||
            options.format === "csv");
        if (valid)
          assert.ok(exportData(b.db, position, options).content.length > 0);
        else
          assert.throws(
            () => exportData(b.db, position, options),
            (e) => e.code === "INVALID_EXPORT_OPTIONS",
          );
        assert.equal(b.db.prepare("SELECT total_changes() n").get().n, before);
      }),
      { seed: 626262, numRuns: 400 },
    );
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("fuzz: malformed stored money is rejected without rewriting the ledger", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-export-values-")),
    b = openBudget(dir);
  try {
    const a = b.createAccount({ name: "Fuzz", type: "efectivo" });
    const insert = b.db.prepare(
      "INSERT INTO transactions(account_id,date,payee,amount) VALUES (?,'2026-01-01','Fuzz',?)",
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (tail) => {
        b.db.exec("DELETE FROM transactions");
        const raw = "not-money:" + tail;
        insert.run(a, raw);
        for (const format of ["json", "csv"])
          assert.throws(
            () => b.exportData({ format }),
            (e) => e.code === "EXPORT_INVALID_VALUE",
          );
        assert.equal(
          b.db.prepare("SELECT amount FROM transactions").get().amount,
          raw,
        );
      }),
      { seed: 626262, numRuns: 100 },
    );
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
