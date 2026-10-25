import { actions } from "../src/actions.js";
import { proposalFile } from "../src/commands.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import Ajv2020 from "ajv/dist/2020.js";
import { openBudget } from "../src/core.js";
import { exportData, maxExportRows, maxExportBytes } from "../src/export.js";
const schema = JSON.parse(
  readFileSync(
    new URL("../src/contracts/budget-export.schema.json", import.meta.url),
  ),
);
const validate = new Ajv2020({ strict: true }).compile(schema);
const expectedTables = [
  "accounts",
  "groups",
  "categories",
  "allocations",
  "transactions",
  "reconciliations",
  "goals",
  "recurring",
  "recurring_occurrences",
];
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-export-"));
  const b = openBudget(dir);
  const readers = [];
  t.after(() => {
    for (const budget of [b, ...readers]) if (budget.db.open) budget.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, b, readers };
}
const document = (b) => JSON.parse(b.exportData().content);
const coded = (code) => (e) =>
  e.code === code && typeof e.message === "string" && e.message.length > 0;
test("JSON export preserves the ledger and planning, whitelists data and stays read-only", (t) => {
  const { b } = fixture(t);
  const a = b.createAccount({
    name: "Cuenta ejemplo",
    type: "corriente",
    balance: 1000,
    date: "2026-01-01",
  });
  const card = b.createAccount({
    name: "Tarjeta",
    type: "credito",
    balance: -50,
    date: "2026-01-01",
  });
  b.addTransaction({
    account_id: a,
    date: "2026-01-02",
    payee: 'Compra, "café"\nParaguay',
    amount: -20,
    category_id: 1,
  });
  b.addTransaction({
    account_id: a,
    date: "2026-01-03",
    payee: "Reintegro",
    amount: 5,
    category_id: 1,
  });
  b.transfer({ from: a, to: card, amount: 30, date: "2026-01-04" });
  b.allocate({ month: "2026-01", category_id: 1, amount: 100 });
  b.setGoal({ category_id: 1, amount: 500, due_date: "2026-12-01" });
  const recurring = b.createRecurring({
    account_id: a,
    payee: "Renta",
    amount: -10,
    category_id: 1,
    next_date: "2026-01-31",
    frequency: "monthly",
  });
  b.postRecurring({ id: recurring, due_date: "2026-01-31" });
  const ids = b.accountTransactions(a).map((row) => row.id);
  b.reconcile({ account_id: a, date: "2026-01-31", balance: 945, ids }, true);
  const connection = b.createConnection({ label: "Private client" });
  b.db
    .prepare("INSERT OR REPLACE INTO mappings VALUES (?,?)")
    .run(a, JSON.stringify({ secret: "not-portable" }));
  const before = b.snapshot("2026-01"),
    cursor = b.eventSnapshot().cursor;
  const result = b.exportData(),
    doc = JSON.parse(result.content);
  assert.equal(validate(doc), true, JSON.stringify(validate.errors));
  assert.equal(result.version, 1);
  assert.equal(result.format, "json");
  assert.equal(result.media_type, "application/json");
  assert.equal(result.filename, "nemein-budget-v1.json");
  assert.equal(result.currency, "PYG");
  assert.equal(result.amount_unit, "integer");
  assert.equal(result.source, doc.source);
  assert.equal(result.cursor, cursor);
  assert.equal(doc.cursor, cursor);
  assert.equal(new Date(result.exported_at).toISOString(), result.exported_at);
  assert.equal(result.exported_at, doc.exported_at);
  assert.deepEqual(Object.keys(doc.data), expectedTables);
  assert.equal(
    result.row_count,
    Object.values(doc.data).reduce((n, rows) => n + rows.length, 0),
  );
  assert.equal(
    doc.data.transactions.reduce((n, row) => n + row.amount, 0),
    before.accounts.reduce((n, row) => n + row.balance, 0),
  );
  assert.equal(doc.data.allocations[0].amount, 100);
  assert.equal(doc.data.goals[0].amount, 500);
  assert.equal(doc.data.recurring[0].next_date, "2026-02-28");
  assert.equal(doc.data.recurring_occurrences[0].due_date, "2026-01-31");
  assert.equal(doc.data.reconciliations[0].balance, 945);
  assert.equal(
    doc.data.transactions.filter((row) => row.kind === "transfer").length,
    2,
  );
  assert.equal(
    doc.data.transactions.some((row) => row.reconciled === 1),
    true,
  );
  for (const secret of [
    connection.token,
    createHash("sha256").update(connection.token).digest("hex"),
    "not-portable",
  ])
    assert.equal(result.content.includes(secret), false);
  assert.equal("import_key" in doc.data.transactions[0], false);
  assert.equal(b.eventSnapshot().cursor, cursor);
  assert.deepEqual(b.snapshot("2026-01"), before);
  assert.deepEqual(document(b).data, doc.data);
});
test("CSV has a fixed header, CRLF records, literal text, and stable order", (t) => {
  const { b } = fixture(t),
    a = b.createAccount({ name: "CSV", type: "efectivo" });
  for (const [date, payee, amount] of [
    ["2026-02-02", '=SUM(1,2)\r\n"literal"', 10],
    ["2026-01-01", "Pago", -2],
  ])
    b.addTransaction({
      account_id: a,
      date,
      payee,
      amount,
      category_id: amount < 0 ? 1 : undefined,
    });
  const result = b.exportData({ format: "csv" }),
    doc = document(b);
  assert.equal(result.format, "csv");
  assert.equal(result.media_type, "text/csv;charset=utf-8;header=present");
  assert.equal(result.filename, "nemein-transactions-v1.csv");
  assert.equal(result.row_count, 2);
  assert.equal(result.content.endsWith("\r\n"), true);
  assert.equal(
    result.content.startsWith(
      '"id","account_id","date","payee","amount","category_id","kind","cleared","reconciled","transfer_key"\r\n',
    ),
    true,
  );
  const rows = parse(result.content, {
    columns: true,
    record_delimiter: "\r\n",
  });
  assert.equal(rows[0].date, "2026-01-01");
  assert.equal(rows[1].payee, '=SUM(1,2)\r\n"literal"');
  assert.deepEqual(
    rows,
    doc.data.transactions.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, String(v ?? "")]),
      ),
    ),
  );
});
test("new export permission is denied by default, supports review and revocation", (t) => {
  const { b } = fixture(t),
    connection = b.createConnection({ label: "Export client" });
  const agent = b.forAgent(connection.token);
  b.setRule({
    connection_id: connection.id,
    action: "snapshot",
    decision: "allow",
  });
  assert.throws(() => agent.exportData(), coded("PERMISSION_DENIED"));
  b.setRule({
    connection_id: connection.id,
    action: "export",
    decision: "ask",
  });
  const pending = agent.request(
    "export",
    { format: "csv" },
    { purpose: "Probar el flujo" },
  );
  assert.equal(pending.status, "pending");
  b.resolveProposal({ id: pending.proposal_id, decision: "accept" });
  const resolved = agent.proposalStatus({ id: pending.proposal_id });
  assert.equal(resolved.status, "accepted");
  assert.equal(resolved.result.format, "csv");
  b.setRule({
    connection_id: connection.id,
    action: "export",
    decision: "allow",
  });
  assert.equal(agent.exportData().format, "json");
  b.revokeConnection(connection.id);
  assert.throws(() => agent.exportData(), coded("AUTH_REQUIRED"));
});
test("export captures its cursor and all tables in the same snapshot under a concurrent writer", (t) => {
  const { dir, b, readers } = fixture(t),
    writer = openBudget(dir);
  readers.push(writer);
  const a = b.createAccount({
    name: "Concurrent",
    type: "efectivo",
    balance: 100,
    date: "2026-01-01",
  });
  b.setGoal({ category_id: 1, amount: 10, due_date: "2026-12-01" });
  const cursor = b.eventSnapshot().cursor,
    original = b.db.prepare;
  let committed = false;
  b.db.prepare = function (sql) {
    if (!committed && sql.startsWith("SELECT id,name,type FROM accounts")) {
      committed = true;
      writer.addTransaction({
        account_id: a,
        date: "2026-01-02",
        payee: "Concurrent write",
        amount: -5,
        category_id: 1,
      });
      writer.setGoal({ category_id: 1, amount: 20, due_date: "2026-12-01" });
    }
    return original.call(this, sql);
  };
  let result;
  try {
    result = b.exportData();
  } finally {
    b.db.prepare = original;
  }
  assert.equal(committed, true);
  assert.equal(result.cursor, cursor);
  const doc = JSON.parse(result.content);
  assert.equal(doc.data.transactions.length, 1);
  assert.equal(doc.data.transactions[0].amount, 100);
  assert.equal(doc.data.goals[0].amount, 10);
  assert.deepEqual(
    b
      .readEvents({ after: result.cursor })
      .events.map((e) => e.event.data.operation),
    ["addTransaction", "setGoal"],
  );
  assert.equal(document(b).data.transactions.length, 2);
});
test("uncommitted and damaged event histories are rejected, malformed options never write data", (t) => {
  const { b } = fixture(t);
  assert.throws(
    () => b.db.transaction(() => b.exportData()).immediate(),
    coded("EVENT_READ_IN_TRANSACTION"),
  );
  for (const options of [
    null,
    [],
    true,
    0,
    "json",
    { format: "JSON" },
    { format: null },
    { format: "xml" },
    { destination: "private" },
    { format: "csv", table: "agent_connections" },
  ])
    assert.throws(
      () => exportData(b.db, { source: "fixture", cursor: "fixture" }, options),
      coded("INVALID_EXPORT_OPTIONS"),
    );
  b.createGroup({ name: "Event" });
  b.db.exec("DELETE FROM budget_events");
  assert.throws(() => b.exportData(), coded("EVENT_HISTORY_GAP"));
});
test("integers are never rounded and out-of-contract stored values fail closed", (t) => {
  const { b } = fixture(t),
    a = b.createAccount({ name: "Precise", type: "efectivo" });
  const insert = b.db.prepare(
    "INSERT INTO transactions(account_id,date,payee,amount) VALUES (?,'2026-01-01','Test',?)",
  );
  for (const amount of [9007199254740991n, -9007199254740991n]) {
    b.db.exec("DELETE FROM transactions");
    insert.run(a, amount);
    assert.equal(BigInt(document(b).data.transactions[0].amount), amount);
  }
  for (const amount of [9007199254740992n, -9007199254740992n]) {
    b.db.exec("DELETE FROM transactions");
    insert.run(a, amount);
    assert.throws(() => b.exportData(), coded("EXPORT_UNSAFE_NUMBER"));
  }
  for (const amount of [1.5, Buffer.from("invalid"), "invalid"]) {
    b.db.exec("DELETE FROM transactions");
    insert.run(a, amount);
    assert.throws(() => b.exportData(), coded("EXPORT_INVALID_VALUE"));
  }
  b.db.exec("DELETE FROM transactions");
  const wrong = () => exportData(b.db, { source: "", cursor: "" });
  assert.throws(wrong, coded("EXPORT_INVALID_VALUE"));
});
test("row limits count all JSON tables and CSV transactions without truncation", (t) => {
  assert.equal(maxExportRows, 20000);
  const { b } = fixture(t);
  const insert = b.db.prepare("INSERT INTO groups_(name) VALUES (?)");
  b.db.transaction(() => {
    for (let i = 0; i < 19990; i++) insert.run("Group " + i);
  })();
  assert.equal(b.exportData().row_count, 20000);
  insert.run("One too many");
  assert.throws(() => b.exportData(), coded("EXPORT_TOO_LARGE"));
  const a = b.createAccount({ name: "Rows", type: "efectivo" });
  const tx = b.db.prepare(
    "INSERT INTO transactions(account_id,date,payee,amount) VALUES (?,'2026-01-01','Row',1)",
  );
  b.db.transaction(() => {
    for (let i = 0; i < 20000; i++) tx.run(a);
  })();
  assert.equal(b.exportData({ format: "csv" }).row_count, 20000);
  tx.run(a);
  assert.throws(
    () => b.exportData({ format: "csv" }),
    coded("EXPORT_TOO_LARGE"),
  );
});
test("UTF-8 size is bounded inclusively at five million bytes", (t) => {
  assert.equal(maxExportBytes, 5000000);
  const { b } = fixture(t),
    a = b.createAccount({ name: "Bytes", type: "efectivo" });
  const insert = b.db.prepare(
    "INSERT INTO transactions(account_id,date,payee,amount) VALUES (?,'2026-01-01','x',1)",
  );
  b.db.transaction(() => {
    for (let i = 0; i < 18000; i++) insert.run(a);
  })();
  let remaining =
    5000000 -
    Buffer.byteLength(b.exportData({ format: "csv" }).content, "utf8");
  const update = b.db.prepare("UPDATE transactions SET payee=? WHERE id=?");
  const text = (bytes) =>
    "界".repeat(Math.floor(bytes / 3)) +
    (bytes % 3 === 2 ? "é" : bytes % 3 === 1 ? "a" : "");
  let id = 1;
  b.db.transaction(() => {
    while (remaining > 0) {
      const added = Math.min(479, remaining);
      update.run(text(1 + added), id++);
      remaining -= added;
    }
  })();
  assert.equal(
    Buffer.byteLength(b.exportData({ format: "csv" }).content, "utf8"),
    5000000,
  );
  update.run("xx", id);
  assert.throws(
    () => b.exportData({ format: "csv" }),
    coded("EXPORT_TOO_LARGE"),
  );
});
test("schema rejects private fields, unsupported currencies and broken references in field types", (t) => {
  const { b } = fixture(t);
  const doc = document(b);
  assert.equal(validate(doc), true);
  for (const transform of [
    (x) => {
      x.currency = "USD";
    },
    (x) => {
      x.version = 2;
    },
    (x) => {
      x.secret = "private";
    },
    (x) => {
      x.data.agent_connections = [];
    },
    (x) => {
      delete x.data.goals;
    },
    (x) => {
      x.data.accounts.push({ id: "1", name: "Invalid", type: "efectivo" });
    },
  ]) {
    const changed = structuredClone(doc);
    transform(changed);
    assert.equal(validate(changed), false);
  }
});

test("offline proposal schema stays aligned with every reviewable catalog action", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL("../src/contracts/proposal-file.schema.json", import.meta.url),
    ),
  );
  const expected = Object.entries(actions)
    .filter(([, spec]) => !spec.async)
    .map(([name]) => name)
    .sort();
  assert.deepEqual([...schema.properties.action.enum].sort(), expected);
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const proposal = proposalFile({
    action: "export",
    args: { format: "json" },
    purpose: "Portar datos con revisión",
  });
  assert.equal(validate(proposal), true, JSON.stringify(validate.errors));
  const write = {
    ...proposal,
    action: "allocate",
    args: { month: "2026-01", category_id: 1, amount: 1 },
  };
  assert.equal(validate(write), false);
  assert.equal(validate({ ...write, base: "fixture-cursor" }), true);
  assert.deepEqual(
    [...schema.allOf[0].if.properties.action.enum].sort(),
    Object.entries(actions)
      .filter(([, spec]) => spec.write)
      .map(([name]) => name)
      .sort(),
  );
});

test("JSON validates every financial table and both formats validate their metadata", (t) => {
  const { b } = fixture(t);
  for (const name of ["", "x".repeat(161)]) {
    b.db.prepare("UPDATE groups_ SET name=? WHERE id=1").run(name);
    assert.throws(() => b.exportData(), coded("EXPORT_INVALID_VALUE"));
  }
  b.db.prepare("UPDATE groups_ SET name='Restored' WHERE id=1").run();
  for (const format of ["json", "csv"])
    assert.throws(
      () => exportData(b.db, { source: "", cursor: "" }, { format }),
      coded("EXPORT_INVALID_VALUE"),
    );
});
test("the row budget bounds materialization across multiple tables", (t) => {
  const { b } = fixture(t);
  const group = b.db.prepare("INSERT INTO groups_(name) VALUES (?)"),
    category = b.db.prepare(
      "INSERT INTO categories(group_id,name) VALUES (1,?)",
    );
  b.db.transaction(() => {
    for (let i = 0; i < 19990; i++) group.run("Budget " + i);
    for (let i = 0; i < 10000; i++) category.run("Category " + i);
  })();
  const original = b.db.prepare;
  let materialized = 0;
  b.db.prepare = function (sql) {
    const statement = original.call(this, sql);
    if (sql.startsWith("SELECT ") && sql.includes(" LIMIT ?")) {
      const all = statement.all;
      statement.all = function (...args) {
        const rows = all.apply(this, args);
        materialized += rows.length;
        return rows;
      };
    }
    return statement;
  };
  try {
    assert.throws(() => b.exportData(), coded("EXPORT_TOO_LARGE"));
  } finally {
    b.db.prepare = original;
  }
  assert.ok(
    materialized <= 20001,
    "Do not materialize an unbounded surplus after the row budget is exhausted",
  );
});
