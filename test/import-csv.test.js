import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBudget } from "../src/core.js";

const config = {
  date: "date",
  payee: "payee",
  amount: "amount",
  category_id: 1,
};
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-import-"));
  const b = openBudget(dir);
  t.after(() => {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const account_id = b.createAccount({ name: "Fixture", type: "corriente" });
  return {
    b,
    p: {
      account_id,
      config,
      content:
        "date,payee,amount\n2026-10-02,Mercado,-80000\n2026-10-02,Mercado,-80000",
    },
  };
}

test("CSV contract projection preserves preview shape, historical keys, multiplicity and mapping", (t) => {
  const { b, p } = fixture(t);
  const keys = [
    "02b7fb2888686df108cbbd2cf5efd5e435c70a9780698ff62ddf7e0f5522bb95",
    "dcb1b26481c8baf22d918cd85053a68bf306eaa2386979b5465f0cdfb79e25a5",
  ];
  const rows = keys.map((import_key) => ({
    date: "2026-10-02",
    payee: "Mercado",
    amount: -80000,
    category_id: 1,
    import_key,
    duplicate: false,
  }));
  assert.deepEqual(b.csvPreview(p.content, p.config, p.account_id), {
    headers: ["date", "payee", "amount"],
    rows,
  });
  assert.equal(b.accountTransactions(p.account_id).length, 0);
  assert.deepEqual(b.importCsv(p), { added: 2, duplicates: 0 });
  assert.deepEqual(
    b.csvPreview(p.content, p.config, p.account_id).rows,
    rows.map((row) => ({ ...row, duplicate: true })),
  );
  assert.deepEqual(b.importCsv(p), { added: 0, duplicates: 2 });
  assert.deepEqual(b.mapping(p.account_id), config);
  assert.ok(
    b.accountTransactions(p.account_id).every((row) => row.cleared === 1),
  );
  const other = b.createAccount({ name: "Other", type: "corriente" });
  assert.ok(
    b
      .csvPreview(p.content, config, other)
      .rows.every((row) => !row.duplicate && !keys.includes(row.import_key)),
  );
  assert.deepEqual(b.importCsv({ ...p, content: "date,payee,amount" }), {
    added: 0,
    duplicates: 0,
  });
});

test("CSV contract preserves errors and rolls back late write failure, memory, mapping and events", (t) => {
  const { b, p } = fixture(t);
  const before = b.eventSnapshot().cursor;
  assert.throws(
    () => b.importCsv({ ...p, content: p.content + "\n2026-02-30,Invalid,-1" }),
    {
      message: "Fila 4: Fecha inválida. Usá una fecha real entre 1900 y 2200.",
    },
  );
  b.db.exec(
    "CREATE TEMP TRIGGER fail_import BEFORE INSERT ON transactions WHEN NEW.payee='Fail' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END",
  );
  assert.throws(
    () => b.importCsv({ ...p, content: p.content + "\n2026-10-03,Fail,-1" }),
    /fixture write failure/,
  );
  assert.deepEqual(b.accountTransactions(p.account_id), []);
  assert.deepEqual(b.mapping(p.account_id), {});
  assert.deepEqual(b.snapshot("2026-10").memory, []);
  assert.equal(b.eventSnapshot().cursor, before);
  b.db.exec("DROP TRIGGER fail_import");
  assert.deepEqual(b.importCsv(p), { added: 2, duplicates: 0 });
});

test("CSV still requires separate preview/import grants and owner resolution; stale proposals conflict", (t) => {
  const { b, p } = fixture(t);
  const connection = b.createConnection({ label: "Import fixture" });
  const a = b.forAgent(connection.token);
  assert.throws(() => a.csvPreview(p.content, config, p.account_id), {
    code: "PERMISSION_DENIED",
  });
  b.setRule({
    connection_id: connection.id,
    action: "import-preview",
    decision: "allow",
  });
  assert.equal(a.csvPreview(p.content, config, p.account_id).rows.length, 2);
  assert.throws(() => a.importCsv(p), { code: "PERMISSION_DENIED" });
  b.setRule({
    connection_id: connection.id,
    action: "import",
    decision: "ask",
  });
  const meta = {
    base: b.eventSnapshot().cursor,
    purpose: "Review fixture",
    request_id: "csv-import",
  };
  const pending = a.request("import", p, meta);
  assert.equal(pending.status, "pending");
  assert.deepEqual(b.accountTransactions(p.account_id), []);
  assert.equal(a.request("import", p, meta).proposal_id, pending.proposal_id);
  const accepted = b.resolveProposal({
    id: pending.proposal_id,
    decision: "accept",
  });
  assert.deepEqual(accepted.result, { added: 2, duplicates: 0 });
  assert.deepEqual(
    b.accountTransactions(p.account_id).map((r) => r.amount),
    [-80000, -80000],
  );
  const stale = a.request("import", p, {
    ...meta,
    base: b.eventSnapshot().cursor,
    request_id: "csv-stale",
  });
  b.addTransaction({
    account_id: p.account_id,
    date: "2026-10-03",
    payee: "Later",
    amount: 1,
  });
  assert.throws(
    () => b.resolveProposal({ id: stale.proposal_id, decision: "accept" }),
    { code: "PROPOSAL_CONFLICT" },
  );
  assert.equal(b.accountTransactions(p.account_id).length, 3);
});
