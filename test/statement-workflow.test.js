import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBudget } from "../src/core.js";
import { ofx, ofxRow, camt, camtRow } from "./fixtures/statements.js";

for (const [format, wrap, row] of [
  ["ofx", ofx, ofxRow],
  ["camt053", camt, camtRow],
]) {
  test(
    format +
      ": preview, grants, proposals, rollback, category memory and replay share the existing import workflow",
    (t) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-statements-"));
      const b = openBudget(dir);
      t.after(() => {
        b.close();
        rmSync(dir, { recursive: true, force: true });
      });
      const account_id = b.createAccount({
        name: "Fixture",
        type: "corriente",
      });
      const p = {
        account_id,
        content: wrap(),
        config: { format, category_id: 1 },
      };
      for (const invalid of ["unknown", "", false, 0, null])
        assert.throws(
          () => b.csvPreview(p.content, { format: invalid }, account_id),
          { code: "IMPORT_FORMAT" },
        );
      assert.throws(
        () => b.csvPreview(p.content, { format }, account_id),
        /categoría inicial/,
      );
      assert.throws(
        () =>
          b.csvPreview(
            p.content,
            { ...p.config, category_id: 9999 },
            account_id,
          ),
        /categoría no existe/,
      );
      assert.throws(
        () => b.csvPreview(p.content, p.config, 9999),
        /cuenta no existe/,
      );
      const initial = b.eventSnapshot().cursor;
      const preview = b.csvPreview(p.content, p.config, account_id);
      assert.deepEqual(preview.headers, []);
      assert.equal(preview.rows.length, 1);
      assert.equal(preview.rows[0].category_id, 1);
      assert.equal(preview.rows[0].duplicate, false);
      assert.deepEqual(b.accountTransactions(account_id), []);
      assert.equal(b.eventSnapshot().cursor, initial);
      const connection = b.createConnection({ label: "Fixture" });
      const agent = b.forAgent(connection.token);
      assert.throws(() => agent.csvPreview(p.content, p.config, account_id), {
        code: "PERMISSION_DENIED",
      });
      b.setRule({
        connection_id: connection.id,
        action: "import-preview",
        decision: "allow",
      });
      assert.deepEqual(
        agent.csvPreview(p.content, p.config, account_id),
        preview,
      );
      assert.throws(() => agent.importCsv(p), { code: "PERMISSION_DENIED" });
      b.setRule({
        connection_id: connection.id,
        action: "import",
        decision: "ask",
      });
      const meta = {
        base: b.eventSnapshot().cursor,
        purpose: "Review fictional extract",
        request_id: format + "-fixture",
      };
      const pending = agent.request("import", p, meta);
      assert.equal(pending.status, "pending");
      assert.equal(
        agent.request("import", p, meta).proposal_id,
        pending.proposal_id,
      );
      assert.deepEqual(b.accountTransactions(account_id), []);
      assert.deepEqual(
        b.resolveProposal({ id: pending.proposal_id, decision: "accept" })
          .result,
        { added: 1, duplicates: 0 },
      );
      assert.deepEqual(b.importCsv(p), { added: 0, duplicates: 1 });
      assert.equal(
        b.csvPreview(p.content, p.config, account_id).rows[0].duplicate,
        true,
      );
      assert.deepEqual(b.mapping(account_id), {});
      assert.equal(b.accountTransactions(account_id)[0].cleared, 1);
      const remembered = b.csvPreview(
        wrap(row({ id: "memory", ref: "memory" })),
        { format },
        account_id,
      );
      assert.equal(remembered.rows[0].category_id, 1);
      const other = b.createAccount({
        name: "Other fixture",
        type: "corriente",
      });
      assert.equal(
        b.csvPreview(p.content, p.config, other).rows[0].duplicate,
        false,
      );
      const before = b.eventSnapshot().cursor;
      b.db.exec(
        "CREATE TEMP TRIGGER fail_statement BEFORE INSERT ON transactions WHEN NEW.payee='Fail' BEGIN SELECT RAISE(ABORT,'fixture statement failure'); END",
      );
      const failing = {
        ...p,
        content: wrap(
          row({ id: "new", ref: "new" }) +
            row({
              id: "fail",
              ref: "fail",
              payee:
                format === "ofx" ? "Fail" : "<AddtlNtryInf>Fail</AddtlNtryInf>",
            }),
        ),
      };
      assert.throws(() => b.importCsv(failing), /fixture statement failure/);
      assert.equal(b.accountTransactions(account_id).length, 1);
      assert.equal(b.eventSnapshot().cursor, before);
      assert.deepEqual(b.mapping(account_id), {});
      b.db.exec("DROP TRIGGER fail_statement");
      assert.throws(() => b.importCsv({ ...p, content: wrap(row() + row()) }), {
        code: "IMPORT_DUPLICATE_ID",
      });
      assert.equal(b.accountTransactions(account_id).length, 1);
    },
  );
}

test("A statement import leaves the saved CSV mapping untouched", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-statements-"));
  const b = openBudget(dir);
  t.after(() => {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const account_id = b.createAccount({ name: "Fixture", type: "corriente" });
  const config = {
    date: "date",
    payee: "payee",
    amount: "amount",
    dateFormat: "iso",
    thousands: "none",
    category_id: 1,
  };
  b.importCsv({
    account_id,
    content: "date,payee,amount\n2026-10-02,Fixture,-1",
    config,
  });
  const saved = b.mapping(account_id);
  assert.equal(saved.date, "date");
  b.importCsv({
    account_id,
    content: ofx(),
    config: { format: "ofx", category_id: 1 },
  });
  assert.deepEqual(b.mapping(account_id), saved);
  b.importCsv({
    account_id,
    content: "date,payee,amount\n2026-10-03,Fixture,-2",
    config: { ...config, format: "csv", thousands: "dot" },
  });
  assert.equal(b.mapping(account_id).thousands, "dot");
});
