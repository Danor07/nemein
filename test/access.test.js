import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openBudget } from "../src/core.js";
import { decide, evaluatePolicy } from "../src/access.js";
import { proposalFile } from "../src/commands.js";
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-access-")),
    b = openBudget(dir);
  t.after(() => {
    if (b.db.open) b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const connection = b.createConnection({ label: "Fixture agent" });
  const agent = b.forAgent(connection.token);
  const grant = (action, decision = "allow", conditions = {}) =>
    b.setRule({ connection_id: connection.id, action, decision, conditions });
  return { b, connection, agent, grant };
}
const coded = (code) => (e) => e.code === code;
const payment = (account_id) => ({
  account_id,
  date: "2026-10-24",
  payee: "Test",
  amount: -5,
  category_id: 1,
});

test("P1: default deny, per-action grants, no admin facade, tokens never audited", (t) => {
  const { b, connection, agent, grant } = fixture(t);
  assert.throws(() => agent.snapshot("2026-10"), coded("PERMISSION_DENIED"));
  assert.equal(agent.db, undefined);
  assert.equal(agent.setRule, undefined);
  assert.equal(agent.resolveProposal, undefined);
  grant("snapshot");
  assert.equal(agent.snapshot("2026-10").month, "2026-10");
  assert.throws(
    () => agent.createAccount({ name: "Forbidden", type: "efectivo" }),
    coded("PERMISSION_DENIED"),
  );
  assert.throws(() => b.forAgent("bad"), coded("AUTH_REQUIRED"));
  assert.ok(!JSON.stringify(b.accessState()).includes(connection.token));
  const audit = b.accessState().audit;
  assert.ok(
    audit.some(
      (r) =>
        r.actor === connection.id &&
        r.action === "snapshot" &&
        r.decision === "deny",
    ),
  );
  assert.ok(
    audit.some(
      (r) =>
        r.actor === connection.id &&
        r.action === "snapshot" &&
        r.decision === "allow",
    ),
  );
});

test("P1: limits, revocation, rotation and version changes checked on every call", (t) => {
  const { b, connection, agent, grant } = fixture(t);
  const account = b.createAccount({ name: "Cash", type: "efectivo" });
  grant("transaction", "allow", {
    max_amount: 10,
    account_id: account,
    otherwise: "deny",
  });
  agent.addTransaction(payment(account));
  assert.throws(
    () => agent.addTransaction({ ...payment(account), amount: -11 }),
    coded("PERMISSION_DENIED"),
  );
  assert.throws(
    () => agent.addTransaction({ ...payment(account), amount: "1e1" }),
    coded("PERMISSION_DENIED"),
  );
  grant("transaction", "deny");
  assert.throws(
    () => agent.addTransaction(payment(account)),
    coded("PERMISSION_DENIED"),
  );
  grant("snapshot");
  b.changeConnectionVersion({ id: connection.id, version: "2" });
  assert.throws(() => agent.snapshot(), coded("VERSION_MISMATCH"));
  const next = b.forAgent(connection.token, "2");
  assert.throws(() => next.snapshot(), coded("PERMISSION_DENIED"));
  const rotated = b.rotateConnection(connection.id);
  assert.throws(() => next.snapshot(), coded("AUTH_REQUIRED"));
  const newAgent = b.forAgent(rotated.token, "2");
  b.setRule({
    connection_id: connection.id,
    action: "snapshot",
    decision: "allow",
  });
  assert.ok(newAgent.snapshot());
  b.revokeConnection(connection.id);
  assert.throws(() => newAgent.snapshot(), coded("AUTH_REQUIRED"));
});

test("P1: idempotent writes and atomic audit with ledger events", (t) => {
  const { b, agent, grant } = fixture(t);
  grant("account");
  const p = { name: "Idempotent", type: "efectivo" };
  const id = agent.request("account", p, { request_id: "create-1" });
  assert.equal(agent.request("account", p, { request_id: "create-1" }), id);
  assert.equal(b.snapshot().accounts.length, 1);
  assert.throws(
    () =>
      agent.request(
        "account",
        { ...p, name: "Different" },
        { request_id: "create-1" },
      ),
    coded("REQUEST_ID_REUSED"),
  );
  b.db.exec(
    "CREATE TRIGGER fail_event BEFORE INSERT ON budget_events BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  assert.throws(
    () =>
      agent.request(
        "account",
        { name: "Rollback", type: "efectivo" },
        { request_id: "create-2" },
      ),
    /fixture failure/,
  );
  assert.equal(b.snapshot().accounts.length, 1);
  assert.equal(
    b.db
      .prepare(
        "SELECT COUNT(*) n FROM agent_requests WHERE request_id='create-2'",
      )
      .get().n,
    0,
  );
  assert.ok(
    b
      .accessState()
      .audit.some((r) => r.actor !== "owner" && r.decision === "error"),
  );
});

test("P2: ask does not write, acceptance only once, requester-only status", (t) => {
  const { b, agent, grant } = fixture(t);
  const account = b.createAccount({ name: "Cash", type: "efectivo" });
  grant("transaction", "ask");
  const base = b.eventSnapshot().cursor;
  const p = payment(account),
    meta = {
      base,
      purpose: "Registrar gasto revisado",
      request_id: "request-1",
    };
  const pending = agent.request("transaction", p, meta);
  assert.equal(pending.status, "pending");
  assert.equal(b.accountTransactions(account).length, 0);
  assert.deepEqual(agent.request("transaction", p, meta), pending);
  const accepted = b.resolveProposal({
    id: pending.proposal_id,
    decision: "accept",
  });
  assert.equal(accepted.status, "accepted");
  assert.equal(b.accountTransactions(account).length, 1);
  const status = agent.proposalStatus({ id: pending.proposal_id });
  assert.equal(status.status, "accepted");
  assert.equal(status.delivery, "responded");
  assert.throws(
    () => b.resolveProposal({ id: pending.proposal_id, decision: "accept" }),
    coded("PROPOSAL_CLOSED"),
  );
  const other = b.createConnection({ label: "Other" });
  assert.throws(
    () => b.forAgent(other.token).proposalStatus({ id: pending.proposal_id }),
    coded("PROPOSAL_NOT_FOUND"),
  );
});

test("P2: modification preserves both versions, rejection has reason, stale base conflicts", (t) => {
  const { b, agent, grant } = fixture(t);
  const account = b.createAccount({ name: "Cash", type: "efectivo" });
  grant("transaction", "ask");
  const propose = (id) =>
    agent.request("transaction", payment(account), {
      base: b.eventSnapshot().cursor,
      purpose: "Gasto",
      request_id: id,
    });
  const modified = propose("modify");
  b.resolveProposal({
    id: modified.proposal_id,
    decision: "modify",
    args: { ...payment(account), amount: -3 },
    reason: "Importe corregido",
  });
  let row = agent.proposalStatus({ id: modified.proposal_id });
  assert.equal(row.args.amount, -5);
  assert.equal(row.final_args.amount, -3);
  assert.equal(row.status, "modified");
  const rejected = propose("reject");
  assert.throws(
    () => b.resolveProposal({ id: rejected.proposal_id, decision: "reject" }),
    coded("REASON_REQUIRED"),
  );
  b.resolveProposal({
    id: rejected.proposal_id,
    decision: "reject",
    reason: "No corresponde",
  });
  assert.equal(
    agent.proposalStatus({ id: rejected.proposal_id }).status,
    "rejected",
  );
  const stale = propose("stale");
  b.allocate({ month: "2026-10", category_id: 1, amount: 10 });
  assert.throws(
    () => b.resolveProposal({ id: stale.proposal_id, decision: "accept" }),
    coded("PROPOSAL_CONFLICT"),
  );
  assert.equal(
    agent.proposalStatus({ id: stale.proposal_id }).status,
    "pending",
  );
  assert.equal(b.accountTransactions(account).length, 1);
});

test("P2: changed policies cannot be bypassed by an old proposal", (t) => {
  const { b, agent, grant } = fixture(t);
  grant("group", "ask");
  const pending = agent.request(
    "group",
    { name: "Review" },
    { base: b.eventSnapshot().cursor, purpose: "Organizar categorías" },
  );
  grant("group", "deny");
  assert.throws(
    () => b.resolveProposal({ id: pending.proposal_id, decision: "accept" }),
    coded("PERMISSION_DENIED"),
  );
});

test("P2: read approval returns a committed snapshot and honors later revocation", (t) => {
  const { b, agent, grant } = fixture(t);
  grant("event-snapshot", "ask");
  const pending = agent.request(
    "event-snapshot",
    { month: "2026-10" },
    { purpose: "Revisar planificación" },
  );
  b.resolveProposal({ id: pending.proposal_id, decision: "accept" });
  const status = agent.proposalStatus({ id: pending.proposal_id });
  assert.equal(status.result.snapshot.month, "2026-10");
  grant("event-snapshot", "deny");
  assert.throws(
    () => agent.proposalStatus({ id: pending.proposal_id }),
    coded("PERMISSION_DENIED"),
  );
});

test("P2: offline file delivery is explicit, idempotent and cannot apply immediately", (t) => {
  const { b, agent, grant } = fixture(t);
  grant("group");
  const file = proposalFile({
    action: "group",
    args: { name: "Offline" },
    base: b.eventSnapshot().cursor,
    purpose: "Preparado sin conexión",
  });
  assert.equal(file.delivery, "undelivered");
  const pending = agent.submitProposal(file);
  assert.equal(pending.delivery, "delivered");
  assert.deepEqual(agent.submitProposal(file), pending);
  assert.ok(!b.snapshot().groups.some((g) => g.name === "Offline"));
  b.resolveProposal({ id: pending.proposal_id, decision: "accept" });
  assert.ok(b.snapshot().groups.some((g) => g.name === "Offline"));
});

test("P1 portable decision vectors", () => {
  const vectors = [
    [null, "transaction", { amount: -5 }, "deny"],
    [
      {
        action_version: 1,
        decision: "allow",
        conditions: { max_amount: 10, otherwise: "ask" },
      },
      "transaction",
      { amount: -11 },
      "ask",
    ],
    [
      {
        action_version: 1,
        decision: "allow",
        conditions: { max_amount: 10, otherwise: "ask" },
      },
      "transaction",
      { amount: -10 },
      "allow",
    ],
    [{ action_version: 2, decision: "allow" }, "snapshot", {}, "deny"],
  ];
  for (const [rule, action, args, want] of vectors)
    assert.equal(decide(rule, action, args).decision, want);
});

test("P1: explicit deny overrides old limits and retries; void write replay is identical", (t) => {
  const { b, agent, connection, grant } = fixture(t);
  grant("allocate");
  const p = { month: "2026-10", category_id: 1, amount: 10 };
  assert.equal(agent.request("allocate", p, { request_id: "void" }), null);
  assert.equal(agent.request("allocate", p, { request_id: "void" }), null);
  grant("allocate", "deny", { max_amount: 1, otherwise: "ask" });
  assert.throws(
    () => agent.request("allocate", p, { request_id: "void" }),
    coded("PERMISSION_DENIED"),
  );
  assert.ok(
    b
      .accessState()
      .audit.some(
        (r) =>
          r.actor === connection.id &&
          r.action === "allocate" &&
          r.policy?.conditions.max_amount === 1 &&
          r.decision === "deny",
      ),
  );
});
test("P2: an offline stale proposal is delivered, displayed as conflict and cannot be accepted", (t) => {
  const { b, agent, grant } = fixture(t);
  grant("group");
  const file = proposalFile({
    action: "group",
    args: { name: "Offline stale" },
    base: b.eventSnapshot().cursor,
    purpose: "Preparado antes",
  });
  b.createGroup({ name: "Other change" });
  const pending = agent.submitProposal(file);
  assert.equal(
    agent.proposalStatus({ id: pending.proposal_id }).conflict,
    true,
  );
  assert.equal(
    b.accessState().proposals.find((p) => p.id === pending.proposal_id)
      .conflict,
    true,
  );
  assert.throws(
    () => b.resolveProposal({ id: pending.proposal_id, decision: "accept" }),
    coded("PROPOSAL_CONFLICT"),
  );
  assert.ok(
    b
      .accessState()
      .audit.some((r) => r.reviewer === "owner" && r.decision === "error"),
  );
});

test("P1: portable actor/action/policy fixtures", () => {
  const vectors = JSON.parse(
    readFileSync(
      new URL("./fixtures/permission-vectors.json", import.meta.url),
      "utf8",
    ),
  );
  for (const vector of vectors)
    assert.equal(evaluatePolicy(vector).decision, vector.expected);
});
test("P2: pending proposals remain reachable through pagination", (t) => {
  const { b, agent, grant } = fixture(t);
  grant("group", "ask");
  const base = b.eventSnapshot().cursor;
  for (let i = 0; i < 51; i++)
    agent.request(
      "group",
      { name: "Page " + i },
      { base, purpose: "Organizar", request_id: "page-" + i },
    );
  assert.equal(b.accessState().proposalTotal, 51);
  assert.equal(b.accessState().proposals.length, 50);
  assert.equal(b.accessState({ offset: 50 }).proposals.length, 1);
  assert.equal(
    new Set(
      [
        ...b.accessState().proposals,
        ...b.accessState({ offset: 50 }).proposals,
      ].map((p) => p.id),
    ).size,
    51,
  );
});
test("P1: concurrent processes migrate the audit schema safely", async (t) => {
  const { b } = fixture(t),
    dir = b.dir;
  b.db.exec(
    "DROP TABLE agent_audit; CREATE TABLE agent_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,args TEXT NOT NULL,decision TEXT NOT NULL,reason TEXT NOT NULL,reviewer TEXT)",
  );
  b.close();
  const core = new URL("../src/core.js", import.meta.url).href;
  const script =
    "import {openBudget} from " +
    JSON.stringify(core) +
    "; const b=openBudget(process.argv[1]);b.close();";
  await Promise.all(
    [0, 1].map(
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [
            "--input-type=module",
            "-e",
            script,
            dir,
          ]);
          let stderr = "";
          child.stderr.on("data", (c) => (stderr += c));
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0 ? resolve() : reject(Error(stderr)),
          );
        }),
    ),
  );
  const reopened = openBudget(dir);
  try {
    assert.ok(
      reopened.db
        .prepare("PRAGMA table_info(agent_audit)")
        .all()
        .some((c) => c.name === "policy"),
    );
  } finally {
    reopened.close();
  }
});
