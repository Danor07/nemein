import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openBudget } from "../src/core.js";
import { eventOperations } from "../src/events.js";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-events-"));
  const b = openBudget(dir);
  b.testReaders = [];
  t.after(() => {
    for (const reader of b.testReaders) if (reader.open) reader.close();
    if (b.db.open) b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return b;
}
const events = (b) =>
  b.db
    .prepare("SELECT * FROM budget_events ORDER BY sequence")
    .all()
    .map((r) => ({ ...r, event: JSON.parse(r.envelope) }));
const account = (b) => b.createAccount({ name: "Test", type: "efectivo" });
const tx = (id) => ({
  account_id: id,
  date: "2026-01-01",
  payee: "Private test",
  amount: -5,
  category_id: 1,
});

test("events: atomic visibility, outer rollback, and persistence on reopen", (t) => {
  const b = fixture(t);
  const reader = new Database(path.join(b.dir, "budget.db"));
  b.testReaders.push(reader);
  b.db.transaction(() => {
    account(b);
    assert.equal(reader.prepare("SELECT COUNT(*) n FROM accounts").get().n, 0);
    assert.equal(
      reader.prepare("SELECT COUNT(*) n FROM budget_events").get().n,
      0,
    );
  })();
  assert.equal(reader.prepare("SELECT COUNT(*) n FROM accounts").get().n, 1);
  assert.equal(
    reader.prepare("SELECT COUNT(*) n FROM budget_events").get().n,
    1,
  );
  assert.throws(
    () =>
      b.db.transaction(() => {
        b.createGroup({ name: "Rolled back" });
        throw Error("abort");
      })(),
    /abort/,
  );
  assert.equal(events(b).length, 1);
  const saved = events(b);
  b.close();
  const reopened = openBudget(b.dir);
  try {
    assert.deepEqual(events(reopened), saved);
  } finally {
    reopened.close();
  }
});

test("events: insertion failure rolls back single and composite operations", (t) => {
  const b = fixture(t),
    id = account(b);
  b.db.exec(
    "CREATE TRIGGER reject_event BEFORE INSERT ON budget_events BEGIN SELECT RAISE(ABORT, 'event unavailable'); END",
  );
  assert.throws(
    () => b.setGoal({ category_id: 1, amount: 10, due_date: "2026-02-01" }),
    /event unavailable/,
  );
  assert.equal(b.listGoals("2026-01").length, 0);
  assert.throws(() => b.addTransaction(tx(id)), /event unavailable/);
  assert.equal(b.accountTransactions(id).length, 0);
  assert.equal(b.db.prepare("SELECT COUNT(*) n FROM memory").get().n, 0);
  b.db.exec("DROP TRIGGER reject_event");
  b.addTransaction(tx(id));
  assert.equal(events(b).length, 2); // depth restored after failure
});

test("events: every mutation covered, nested calls grouped, previews silent", (t) => {
  const b = fixture(t),
    a = account(b);
  const c = b.createAccount({ name: "Other", type: "efectivo" });
  const g = b.createGroup({ name: "Group" });
  const cat = b.createCategory({ name: "Category", group_id: g });
  b.allocate({ month: "2026-01", category_id: cat, amount: 10 });
  const id = b.addTransaction(tx(a));
  b.categorize({ id, category_id: cat });
  b.transfer({ from: a, to: c, amount: 2, date: "2026-01-01" });
  assert.equal(
    b.snapshot("2026-01").accounts.reduce((n, a) => n + a.balance, 0),
    -5,
  );
  b.deleteTransaction(id);
  b.setGoal({ category_id: cat, amount: 10, due_date: "2026-02-01" });
  b.removeGoal({ category_id: cat });
  const r = b.createRecurring({
    ...tx(a),
    next_date: "2026-01-01",
    frequency: "monthly",
  });
  let before = events(b).length;
  b.postRecurring({ id: r, due_date: "2026-01-01" });
  assert.equal(events(b).length, before + 1);
  assert.equal(events(b).at(-1).event.data.operation, "postRecurring");
  b.toggleRecurring({ id: r, active: false });
  before = events(b).length;
  const cfg = {
    date: "date",
    payee: "payee",
    amount: "amount",
    category_id: 1,
  };
  b.importCsv({
    account_id: a,
    content: "date,payee,amount\n2026-01-02,Private import,-3",
    config: cfg,
  });
  assert.equal(events(b).length, before + 1);
  const p = {
    account_id: a,
    date: "2026-01-31",
    balance: -10,
    ids: b.accountTransactions(a).map((t) => t.id),
  };
  before = events(b).length;
  b.reconcile(p);
  b.snapshot("2026-01");
  assert.equal(events(b).length, before);
  b.reconcile(p, true);
  assert.deepEqual(
    new Set(events(b).map((r) => r.event.data.operation)),
    new Set(eventOperations),
  );
  before = events(b).length;
  assert.throws(() => b.postRecurring({ id: r, due_date: "2026-01-01" }));
  b.removeGoal({ category_id: cat }); // no matching row: no event
  assert.equal(events(b).length, before);
  const schema = JSON.parse(
    readFileSync(
      new URL("../src/contracts/budget-changed.schema.json", import.meta.url),
    ),
  );
  for (const { event } of events(b)) {
    assert.equal(event.specversion, "1.0");
    assert.match(event.source, /^urn:uuid:/);
    assert.equal(event.dataschema, schema.$id);
    assert.deepEqual(Object.keys(event.data), ["operation"]);
    assert.ok(schema.properties.operation.enum.includes(event.data.operation));
    assert.ok(!JSON.stringify(event).includes("Private"));
  }
});

test("events: existing ledger gets no fabricated history; budgets have separate sources", (t) => {
  const b = fixture(t),
    id = account(b);
  b.addTransaction(tx(id));
  b.db.exec("DROP TABLE budget_events; DROP TABLE event_identity");
  b.close();
  const migrated = openBudget(b.dir);
  try {
    assert.equal(events(migrated).length, 0);
    assert.equal(migrated.accountTransactions(id).length, 1);
    migrated.allocate({ month: "2026-01", category_id: 1, amount: 2 });
    const other = fixture(t);
    account(other);
    assert.notEqual(
      events(migrated)[0].event.source,
      events(other)[0].event.source,
    );
  } finally {
    migrated.close();
  }
});
