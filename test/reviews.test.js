import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openBudget, today } from "../src/core.js";
import { maxReviewTextBytes, maxReviewPackageBytes } from "../src/reviews.js";
import { eventOperations } from "../src/events.js";
import { actions } from "../src/actions.js";

const options = { from: "2026-01-01", to: "2026-01-15", as_of: "2026-01-15" };
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-review-")),
    b = openBudget(dir);
  t.after(() => {
    if (b.db.open) b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return b;
}
const save = (b, extra = {}) => ({
  id: "review-1",
  package: b.reviewPackage(options),
  report: "Informe",
  generator: "IA elegida",
  ...extra,
});
test("review package uses one explicit cutoff, reserves future allocations and preserves snapshot v1", (t) => {
  const b = fixture(t),
    a = b.createAccount({
      name: "Cash",
      type: "efectivo",
      balance: 1000,
      date: "2026-01-01",
    });
  b.allocate({ month: "2026-01", category_id: 1, amount: 300 });
  b.allocate({ month: "2026-02", category_id: 2, amount: 200 });
  b.addTransaction({
    account_id: a,
    date: "2026-01-10",
    payee: "Expense",
    amount: -100,
    category_id: 1,
  });
  b.addTransaction({
    account_id: a,
    date: "2026-01-11",
    payee: "Refund",
    amount: 20,
    category_id: 1,
  });
  b.addTransaction({
    account_id: a,
    date: "2026-01-20",
    payee: "Later",
    amount: 400,
  });
  b.setGoal({ category_id: 1, amount: 500, due_date: "2026-03-01" });
  b.createRecurring({
    account_id: a,
    category_id: 1,
    payee: "Next",
    amount: -30,
    next_date: "2026-02-01",
    frequency: "monthly",
  });
  b.reconcile(
    {
      account_id: a,
      date: "2026-01-11",
      balance: 920,
      ids: b
        .accountTransactions(a)
        .filter((t) => t.date <= "2026-01-11")
        .map((t) => t.id),
    },
    true,
  );
  const p = b.reviewPackage(options);
  assert.equal(p.version, 1);
  assert.equal(p.currency, "PYG");
  assert.equal(p.coverage, "not_declared");
  assert.equal(p.recorded.accounts[0].balance, 920);
  assert.equal(p.recorded.ready, 500);
  assert.equal(p.recorded.categories[0].available, 220);
  assert.equal(p.recorded.categories[0].activity, -80);
  assert.equal(p.recorded.goals[0].saved, 220);
  assert.equal(p.recorded.goals[0].monthly, 94);
  assert.equal(p.recorded.goals[0].progress, 44);
  assert.equal(p.recorded.accounts[0].last_reconciliation.balance, 920);
  assert.equal(p.recorded.metrics.spending, 80);
  assert.equal(p.recorded.metrics.income, 0);
  assert.equal(p.projected.upcoming.length, 1);
  assert.equal(p.evidence.length, 3);
  assert.equal(b.snapshot("2026-01").accounts[0].balance, 1320);
  assert.equal(b.snapshot("2026-01").ready, 900);
  assert.equal(p.cursor, b.eventSnapshot({ month: "2026-01" }).cursor);
  assert.equal(
    b.reviewPackage({ ...options, as_of: "2026-01-01", to: "2026-01-01" })
      .recorded.accounts[0].last_reconciliation,
    null,
  );
});
test("review save is immutable, idempotent, rejects altered or stale packages and changes no financial cursor", (t) => {
  const b = fixture(t),
    p = save(b),
    before = b.eventSnapshot();
  const first = b.saveReview(p);
  assert.deepEqual(b.saveReview(p), first);
  assert.equal(b.getReview({ id: p.id }).reviewed_at, null);
  assert.equal(b.getReview({ id: p.id }).generated_by, "owner");
  b.markReview({ id: p.id });
  const reviewed = b.getReview({ id: p.id }).reviewed_at;
  assert.ok(reviewed);
  b.markReview({ id: p.id });
  assert.equal(b.getReview({ id: p.id }).reviewed_at, reviewed);
  assert.deepEqual(b.eventSnapshot(), before);
  assert.throws(() => b.saveReview({ ...p, report: "changed" }), {
    code: "REVIEW_ID_REUSED",
  });
  const altered = structuredClone(p);
  altered.id = "altered";
  altered.package.recorded.ready = 1;
  assert.throws(() => b.saveReview(altered), { code: "REVIEW_STALE" });
  b.createGroup({ name: "Change after read" });
  assert.throws(() => b.saveReview({ ...p, id: "stale" }), {
    code: "REVIEW_STALE",
  });
  assert.deepEqual(b.saveReview(p), first); // Retry of a committed report survives later events.
  b.close();
  const reopened = openBudget(b.dir);
  try {
    assert.equal(reopened.getReview({ id: p.id }).report, p.report);
    assert.equal(reopened.listReviews().total, 1);
  } finally {
    reopened.close();
  }
  assert.equal(eventOperations.includes("saveReview"), false);
  assert.equal(eventOperations.includes("markReview"), false);
});
test("review permissions are independent, owner guard holds and approved proposals preserve authorship", (t) => {
  const b = fixture(t),
    c = b.createConnection({ label: "External IA" }),
    agent = b.forAgent(c.token);
  for (const action of [
    "review-package",
    "review-save",
    "review-list",
    "review-get",
  ]) {
    assert.equal(agent.permissions().actions[action].decision, "deny");
    assert.throws(() => agent.request(action, {}), {
      code: "PERMISSION_DENIED",
    });
  }
  assert.equal(agent.markReview, undefined);
  assert.throws(() => agent.request("review-mark", { id: "x" }), {
    code: "INVALID_ACTION",
  });
  assert.match(actions["review-package"].label, /saldrá hacia la IA/);
  b.setRule({
    connection_id: c.id,
    action: "review-package",
    decision: "allow",
  });
  const p = {
    id: "agent-report",
    package: agent.reviewPackage(options),
    report: "",
    generator: "Nemein, sin IA",
  };
  b.setRule({ connection_id: c.id, action: "review-save", decision: "allow" });
  agent.saveReview(p);
  assert.equal(b.getReview({ id: p.id }).generated_by, c.id);
  assert.equal(b.getReview({ id: p.id }).reviewed_at, null);
  b.setRule({ connection_id: c.id, action: "review-save", decision: "ask" });
  const pending = agent.request(
    "review-save",
    { ...p, id: "asked" },
    { base: p.package.cursor, purpose: "Guardar informe" },
  );
  b.resolveProposal({ id: pending.proposal_id, decision: "accept" });
  assert.equal(b.getReview({ id: "asked" }).generated_by, c.id);
  // Accepting runs the action internally; its nested reads are not separate owner actions.
  assert.equal(
    b.db
      .prepare(
        "SELECT COUNT(*) n FROM agent_audit WHERE actor='owner' AND action IN ('cube','recurring')",
      )
      .get().n,
    0,
  );
  b.setRule({ connection_id: c.id, action: "review-save", decision: "allow" });
  const hostile = { ...p, id: "guard" };
  Object.defineProperty(hostile, "report", {
    get() {
      b.markReview({ id: p.id });
      return "";
    },
    enumerable: true,
  });
  assert.throws(() => agent.saveReview(hostile), { code: "OWNER_REQUIRED" });
  b.revokeConnection(c.id);
  assert.throws(() => agent.reviewPackage(options), { code: "AUTH_REQUIRED" });
});
test("review input bounds, schema version, list pagination and absence errors", (t) => {
  const b = fixture(t);
  for (const p of [
    null,
    [],
    {},
    { ...options, extra: 1 },
    { ...options, from: "2026-02-30" },
    { ...options, to: "2026-01-16" },
    { ...options, from: "2026-01-16" },
    { ...options, as_of: "2200-01-01" },
  ])
    assert.throws(() => b.reviewPackage(p));
  const p = save(b, { report: "x".repeat(maxReviewTextBytes) });
  b.saveReview(p);
  assert.throws(
    () => b.saveReview({ ...p, id: "long", report: p.report + "x" }),
    { code: "INVALID_REVIEW_TEXT" },
  );
  for (const generator of ["", " ", 1, "a".repeat(161)])
    assert.throws(() => b.saveReview({ ...p, id: "bad", generator }));
  for (const id of [null, "", "../x", "a".repeat(101)])
    assert.throws(() => b.getReview({ id }));
  for (const offset of [-1, 0.5, "1", NaN])
    assert.throws(() => b.listReviews({ offset }));
  assert.deepEqual(b.listReviews({ offset: 1 }).items, []);
  assert.equal(b.listReviews().items[0].id, p.id);
  assert.throws(() => b.getReview({ id: "absent" }), {
    code: "REVIEW_NOT_FOUND",
  });
  assert.throws(() => b.markReview({ id: "absent" }), {
    code: "REVIEW_NOT_FOUND",
  });
  const versioned = structuredClone(p);
  versioned.id = "version";
  versioned.package.version = 2;
  assert.throws(() => b.saveReview(versioned), { code: "REVIEW_STALE" });
  assert.match(
    readFileSync(
      new URL("../src/migrations/006-reviews.sql", import.meta.url),
      "utf8",
    ),
    /CREATE TABLE reviews/,
  );
});
test("review package and cursor share a read snapshot under a concurrent write", (t) => {
  const b = fixture(t),
    other = openBudget(b.dir),
    original = b.cube;
  const before = b.eventSnapshot().cursor;
  b.cube = (p) => {
    other.createAccount({
      name: "Concurrent",
      type: "efectivo",
      balance: 25,
      date: "2026-01-02",
    });
    return original(p);
  };
  try {
    const p = b.reviewPackage(options);
    assert.equal(p.cursor, before);
    assert.deepEqual(p.recorded.accounts, []);
    assert.deepEqual(p.evidence, []);
    assert.notEqual(b.eventSnapshot().cursor, before);
  } finally {
    other.close();
  }
});
const rejects = (fn, code, message) => assert.throws(fn, { code, message });
test("review validation reports exact codes and messages at every boundary", (t) => {
  const b = fixture(t),
    p = save(b);
  assert.equal(p.package.unit, "integer");
  assert.throws(() => b.snapshot("2026-13"));
  const period =
    "El período debe terminar como máximo en el corte, y el corte no puede ser futuro.";
  for (const o of [
    { ...options, from: "2026-01-16" },
    { ...options, to: "2026-01-16" },
    { ...options, as_of: "2200-01-01" },
  ])
    rejects(() => b.reviewPackage(o), "INVALID_REVIEW_PERIOD", period);
  const now = today();
  assert.equal(b.reviewPackage({ from: now, to: now, as_of: now }).as_of, now);
  for (const id of [5, "bad id", "!ok", "ok!", "a".repeat(101)])
    rejects(
      () => b.saveReview({ ...p, id }),
      "INVALID_REVIEW",
      "Identificador de revisión inválido.",
    );
  const changed = (id, change) => {
    const copy = structuredClone(p);
    copy.id = id;
    change(copy.package);
    return copy;
  };
  for (const value of [null, 5, []])
    rejects(
      () => b.saveReview(changed("period", (k) => (k.period = value))),
      "INVALID_REVIEW",
      "Opciones de revisión inválidas.",
    );
  rejects(
    () => b.saveReview(changed("unsafe", (k) => (k.recorded.ready = 0.5))),
    "REVIEW_UNSAFE_NUMBER",
    "Un importe o contador no puede representarse exactamente.",
  );
  const sized = (bytes) =>
    changed("sized", (k) => {
      k.coverage = "";
      k.coverage = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(k)));
    });
  rejects(
    () => b.saveReview(sized(maxReviewPackageBytes + 1)),
    "REVIEW_TOO_LARGE",
    "El paquete supera 2 MB. Elegí un período menor.",
  );
  rejects(
    () => b.saveReview(sized(maxReviewPackageBytes)),
    "REVIEW_STALE",
    "El paquete cambió o no corresponde a este presupuesto. Generá otro y revisá el informe antes de guardar.",
  );
  rejects(
    () => b.saveReview({ ...p, id: "text", report: 5 }),
    "INVALID_REVIEW_TEXT",
    "El informe debe ser texto plano de hasta 100000 bytes.",
  );
  for (const generator of [5, " ", "g".repeat(161)])
    rejects(
      () => b.saveReview({ ...p, id: "generator", generator }),
      "INVALID_REVIEW_GENERATOR",
      "Indicá quién redactó el informe, hasta 160 caracteres.",
    );
  assert.equal(
    b.saveReview({ ...p, id: "generator", generator: "g".repeat(160) }).id,
    "generator",
  );
  b.saveReview(p);
  const reused = "Ese identificador ya pertenece a otro informe.";
  rejects(
    () => b.saveReview({ ...p, generator: "Otra IA" }),
    "REVIEW_ID_REUSED",
    reused,
  );
  const c = b.createConnection({ label: "Other author" });
  b.setRule({ connection_id: c.id, action: "review-save", decision: "allow" });
  rejects(() => b.forAgent(c.token).saveReview(p), "REVIEW_ID_REUSED", reused);
  rejects(
    () => b.listReviews({ offset: -1 }),
    "INVALID_REVIEW",
    "Posición de lista inválida.",
  );
  for (const read of [b.getReview, b.markReview])
    rejects(
      () => read({ id: "absent" }),
      "REVIEW_NOT_FOUND",
      "La revisión no existe.",
    );
  assert.deepEqual(b.markReview({ id: p.id }), { id: p.id });
  assert.deepEqual(
    b.db
      .prepare(
        "SELECT actor,action,decision,reason FROM agent_audit WHERE action='review-mark'",
      )
      .all(),
    [
      {
        actor: "owner",
        action: "review-mark",
        decision: "allow",
        reason: "Revisión del propietario",
      },
    ],
  );
});
test("review goals and upcoming payments follow their own rows", (t) => {
  const b = fixture(t),
    a = b.createAccount({ name: "Cash", type: "efectivo" });
  b.allocate({ month: "2026-01", category_id: 2, amount: 100 });
  b.setGoal({ category_id: 2, amount: 1600, due_date: "2027-12-01" });
  for (const payee of ["Active", "Paused"])
    b.createRecurring({
      account_id: a,
      category_id: 1,
      payee,
      amount: -1,
      next_date: "2026-02-01",
      frequency: "monthly",
    });
  const paused = b.listRecurring().find((r) => r.payee === "Paused");
  b.toggleRecurring({ id: paused.id, active: false });
  const p = b.reviewPackage(options),
    [goal] = p.recorded.goals;
  assert.equal(
    goal.name,
    b.snapshot("2026-01").categories.find((c) => c.id === 2).name,
  );
  assert.equal(goal.saved, 100);
  assert.equal(goal.monthly, 63); // 1500 over 24 months, January 2026 to December 2027.
  assert.deepEqual(
    p.projected.upcoming.map((r) => r.payee),
    ["Active"],
  );
});
test("review package rejects more than 5000 movements or 2 MB before leaving Nemein", (t) => {
  const b = fixture(t),
    a = b.createAccount({ name: "Bulk", type: "efectivo" }),
    insert = b.db.prepare(
      "INSERT INTO transactions(account_id,date,payee,amount) VALUES (?,?,?,?)",
    );
  const add = (n, payee = "Bulk") =>
    b.db.transaction(() => {
      for (let i = 0; i < n; i++) insert.run(a, "2026-01-02", payee, -1);
    })();
  add(5000);
  assert.equal(b.reviewPackage(options).evidence.length, 5000);
  add(1);
  rejects(
    () => b.reviewPackage(options),
    "REVIEW_TOO_LARGE",
    "El paquete supera 5000 movimientos. Elegí un período menor.",
  );
  b.db.exec("DELETE FROM transactions");
  add(700, "p".repeat(3000));
  rejects(
    () => b.reviewPackage(options),
    "REVIEW_TOO_LARGE",
    "El paquete supera 2 MB. Elegí un período menor.",
  );
});
