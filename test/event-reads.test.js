import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBudget } from "../src/core.js";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-cursor-"));
  const connections = [];
  const open = () => {
    const b = openBudget(dir);
    connections.push(b);
    return b;
  };
  t.after(() => {
    for (const b of connections) if (b.db.open) b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, open };
}
const group = (b, name) => b.createGroup({ name });
const coded = (code) => (e) =>
  e.code === code && typeof e.message === "string" && e.message.length > 0;

test("cursor: empty baseline, bounded pages, per-event resume, and reopen", (t) => {
  const f = fixture(t),
    b = f.open();
  const baseline = b.eventSnapshot({ month: "2026-01" });
  assert.deepEqual(b.readEvents({ after: baseline.cursor }), {
    version: 1,
    events: [],
    cursor: baseline.cursor,
    hasMore: false,
  });
  for (let i = 0; i < 4; i++) group(b, "Group " + i);
  const first = b.readEvents({ after: baseline.cursor, limit: 2 });
  assert.equal(first.events.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.cursor, first.events[1].cursor);
  assert.equal(
    b.readEvents({ after: first.events[0].cursor, limit: 1 }).cursor,
    first.cursor,
  );
  b.close();
  const reopened = f.open();
  const second = reopened.readEvents({ after: first.cursor, limit: 2 });
  assert.equal(second.events.length, 2);
  assert.equal(second.hasMore, false);
  assert.equal(
    new Set([...first.events, ...second.events].map((x) => x.event.id)).size,
    4,
  );
  assert.deepEqual(
    reopened.readEvents({ after: baseline.cursor, limit: 2 }),
    first,
  );
  assert.equal(
    reopened.readEvents({ after: second.cursor }).cursor,
    second.cursor,
  );
});

test("snapshot: another connection commits between reads without mixing states or losing events", (t) => {
  const f = fixture(t),
    b = f.open(),
    writer = f.open();
  const a = b.createAccount({
    name: "Account",
    type: "efectivo",
    balance: 100,
    date: "2026-01-01",
  });
  b.setGoal({ category_id: 1, amount: 10, due_date: "2026-02-01" });
  const original = b.snapshot;
  let committed = false;
  b.snapshot = (month) => {
    if (!committed) {
      committed = true;
      writer.addTransaction({
        account_id: a,
        date: "2026-01-02",
        payee: "Test",
        amount: -5,
        category_id: 1,
      });
      writer.setGoal({ category_id: 1, amount: 20, due_date: "2026-02-01" });
      writer.createRecurring({
        account_id: a,
        payee: "Test",
        amount: -2,
        category_id: 1,
        next_date: "2026-02-01",
        frequency: "monthly",
      });
    }
    return original(month);
  };
  const cut = b.eventSnapshot({ month: "2026-01" });
  b.snapshot = original;
  assert.equal(cut.snapshot.accounts[0].balance, 100);
  assert.equal(cut.goals[0].amount, 10);
  assert.equal(cut.recurring.length, 0);
  const changes = b.readEvents({ after: cut.cursor });
  assert.deepEqual(
    changes.events.map((x) => x.event.data.operation),
    ["addTransaction", "setGoal", "createRecurring"],
  );
  const fresh = b.eventSnapshot({ month: "2026-01" });
  assert.equal(fresh.snapshot.accounts[0].balance, 95);
  assert.equal(fresh.goals[0].amount, 20);
  assert.equal(fresh.recurring.length, 1);
  assert.equal(changes.cursor, fresh.cursor);
});

test("cursor: malformed, foreign, forged positions and transaction-local reads rejected", (t) => {
  const b = fixture(t).open(),
    other = fixture(t).open();
  group(b, "Test");
  const good = b.eventSnapshot().cursor;
  for (const after of [
    undefined,
    null,
    1,
    "",
    "!",
    "e30",
    good + "=",
    "a".repeat(1025),
  ])
    assert.throws(() => b.readEvents({ after }), coded("INVALID_CURSOR"));
  for (const limit of [0, -1, 1.2, 1001, "1", null])
    assert.throws(
      () => b.readEvents({ after: good, limit }),
      coded("INVALID_EVENT_LIMIT"),
    );
  assert.throws(
    () => other.readEvents({ after: good }),
    coded("CURSOR_MISMATCH"),
  );
  const p = JSON.parse(Buffer.from(good, "base64url").toString());
  for (const change of [
    { sequence: p.sequence + 1 },
    { id: "another-event" },
  ]) {
    const after = Buffer.from(JSON.stringify({ ...p, ...change })).toString(
      "base64url",
    );
    assert.throws(() => b.readEvents({ after }), coded("CURSOR_MISMATCH"));
  }
  b.db.transaction(() => {
    assert.throws(() => b.eventSnapshot(), coded("EVENT_READ_IN_TRANSACTION"));
    assert.throws(
      () => b.readEvents({ after: good }),
      coded("EVENT_READ_IN_TRANSACTION"),
    );
  })();
  assert.throws(() => b.eventSnapshot({ month: "wrong" }));
  group(b, "After rejection");
  assert.equal(b.readEvents({ after: good }).events.length, 1);
});

test("cursor: restored backup rejects lost suffix and a divergent branch with reused sequence", async (t) => {
  const f = fixture(t),
    b = f.open();
  group(b, "Before backup");
  const prefix = b.eventSnapshot().cursor;
  const backup = path.join(f.dir, "checkpoint.db");
  await b.db.backup(backup);
  group(b, "Lost event");
  const lost = b.eventSnapshot().cursor;
  b.close();
  copyFileSync(backup, path.join(f.dir, "budget.db"));
  const restored = f.open();
  assert.throws(
    () => restored.readEvents({ after: lost }),
    coded("CURSOR_MISMATCH"),
  );
  group(restored, "Different event");
  assert.throws(
    () => restored.readEvents({ after: lost }),
    coded("CURSOR_MISMATCH"),
  );
  assert.equal(restored.readEvents({ after: prefix }).events.length, 1);
  const fresh = restored.eventSnapshot();
  assert.equal(restored.readEvents({ after: fresh.cursor }).events.length, 0);
});

test("cursor: missing history fails explicitly instead of silently skipping", (t) => {
  const b = fixture(t).open(),
    start = b.eventSnapshot().cursor;
  for (let i = 0; i < 3; i++) group(b, "History " + i);
  b.db.prepare("DELETE FROM budget_events WHERE sequence=2").run();
  assert.throws(
    () => b.readEvents({ after: start }),
    coded("EVENT_HISTORY_GAP"),
  );
  const fresh = b.eventSnapshot();
  assert.equal(b.readEvents({ after: fresh.cursor }).events.length, 0);
  b.db.prepare("DELETE FROM budget_events WHERE sequence=3").run();
  assert.throws(
    () => b.readEvents({ after: fresh.cursor }),
    coded("EVENT_HISTORY_GAP"),
  );
  assert.throws(() => b.eventSnapshot(), coded("EVENT_HISTORY_GAP"));
});

test("event reads do not generate events, mutate ledger or change existing snapshot shape", (t) => {
  const b = fixture(t).open();
  const original = b.snapshot("2026-01");
  const cut = b.eventSnapshot({ month: "2026-01" });
  assert.deepEqual(cut.snapshot, original);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(b.eventSnapshot({ month: "2026-01" }), cut);
    assert.equal(b.readEvents({ after: cut.cursor }).events.length, 0);
  }
  assert.equal(b.db.prepare("SELECT COUNT(*) n FROM budget_events").get().n, 0);
});

test("zero-position cursors isolate budgets, exact maximum pages work, and missing anchors fail explicitly", (t) => {
  const f = fixture(t),
    b = f.open(),
    other = f.open();
  const foreign = fixture(t).open();
  const baseline = b.eventSnapshot().cursor;
  assert.throws(
    () => foreign.readEvents({ after: baseline }),
    coded("CURSOR_MISMATCH"),
  );
  assert.equal(b.readEvents({ after: baseline, limit: 1000 }).events.length, 0);
  group(b, "First");
  group(b, "Anchor");
  const anchor = b.eventSnapshot().cursor;
  group(b, "Tail");
  b.db.prepare("DELETE FROM budget_events WHERE sequence=2").run();
  assert.throws(
    () => b.readEvents({ after: anchor }),
    coded("CURSOR_MISMATCH"),
  );
  assert.equal(other.eventSnapshot().cursor, b.eventSnapshot().cursor);
});
