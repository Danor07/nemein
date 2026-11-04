import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBudget } from "../src/core.js";
import { CONNECTOR_LIMITS } from "../src/connectors.js";
import {
  base64,
  batchFor,
  component,
  fakeRunner,
  importThroughConnector,
  manifest,
  statement,
} from "./helpers/connector-budget.js";

// Fictitious budgets in temporary folders only.
function fixture(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-connectors-"));
  const clock = { now: new Date("2026-11-04T12:00:00.000Z") };
  const run = options.runConnector ?? fakeRunner();
  const open = () =>
    openBudget(dir, { runConnector: run, now: () => clock.now });
  const b = open();
  const opened = [b];
  t.after(() => {
    for (const budget of opened) if (budget.db.open) budget.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const reopen = () => {
    const next = open();
    opened.push(next);
    return next;
  };
  const accountId = b.createAccount({
    name: "Banco ficticio",
    type: "corriente",
  });
  const group = b.createGroup({ name: "Ficticio" });
  const category = b.createCategory({ name: "Varios", group_id: group });
  return { b, dir, clock, run, reopen, accountId, category, opened };
}
const coded = (code) => (e) => {
  assert.equal(e.code, code, e.message);
  assert.ok(e.message.length > 0);
  return true;
};
const prepare = (b, hash, accountId, extra = {}) =>
  b.prepareConnectorImport({
    hash,
    account_id: accountId,
    content_base64: base64(statement),
    ...extra,
  });
async function installed(b) {
  const entry = await b.installConnector({
    component_base64: base64(component),
  });
  b.enableConnector({ hash: entry.hash });
  return entry.hash;
}
const audits = (b, action) =>
  b.db
    .prepare("SELECT * FROM agent_audit WHERE action=? ORDER BY sequence")
    .all(action);

test("install describes the component enclosed, stores it by hash and lists it disabled", async (t) => {
  const { b, run, dir } = fixture(t);
  const entry = await b.installConnector({
    component_base64: base64(component),
  });
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].op, "describe");
  assert.deepEqual(run.calls[0].component, component);
  assert.match(entry.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(entry.manifest, manifest);
  assert.equal(entry.enabled, false);
  assert.equal(entry.invalidated, false);
  assert.deepEqual(
    readFileSync(path.join(dir, "connectors", entry.hash, "component.wasm")),
    component,
  );
  assert.deepEqual(b.listConnectors(), [entry]);
  // Installing the same bytes again is the same connector.
  assert.deepEqual(
    await b.installConnector({ component_base64: base64(component) }),
    entry,
  );
  assert.equal(b.listConnectors().length, 1);
  assert.equal(
    audits(b, "connector-install").filter((a) => a.decision === "allow").length,
    2,
  );
  // Strict base64 and the component limit.
  for (const bad of ["no es base64!", "QQ", 1, "Q".repeat(23_000_000)])
    await assert.rejects(
      b.installConnector({ component_base64: bad }),
      coded("CONNECTOR_REQUEST_INVALID"),
    );
});

test("only the owner installs, enables and revokes; agents get the catalog actions only", async (t) => {
  const { b, accountId } = fixture(t);
  const hash = await installed(b);
  const connection = b.createConnection({ label: "Agente ficticio" });
  const agent = b.forAgent(connection.token);
  for (const method of [
    "installConnector",
    "enableConnector",
    "revokeConnector",
  ])
    assert.equal(agent[method], undefined, method);
  assert.throws(() => agent.listConnectors(), coded("PERMISSION_DENIED"));
  b.setRule({
    connection_id: connection.id,
    action: "connectors",
    decision: "allow",
    conditions: {},
  });
  assert.equal(agent.listConnectors()[0].hash, hash);
  // Denied before any promise exists.
  assert.throws(
    () =>
      agent.prepareConnectorImport({
        hash,
        account_id: accountId,
        content_base64: base64(statement),
      }),
    coded("PERMISSION_DENIED"),
  );
});

test("prepare runs the approved bytes outside every transaction and fixes the review", async (t) => {
  let observed;
  const run = fakeRunner(async (request) => {
    observed = { inTransaction: budget.db.inTransaction, request };
    return { manifest, batch: batchFor(request.accountId) };
  });
  const { b, accountId, category } = fixture(t, { runConnector: run });
  const budget = b;
  const hash = await installed(b);
  run.calls.length = 0;
  const prepared = await prepare(b, hash, accountId, {
    category_id: category,
    config: "perfil=ficticio",
  });
  assert.equal(
    observed.inTransaction,
    false,
    "third-party code never runs inside a transaction",
  );
  assert.deepEqual(observed.request.component, component);
  assert.equal(observed.request.accountId, String(accountId));
  assert.equal(observed.request.config, "perfil=ficticio");
  assert.deepEqual(observed.request.expectedManifest, manifest);
  assert.deepEqual(observed.request.input, statement);
  assert.equal(prepared.rows.length, 5);
  assert.ok(
    prepared.rows.every((r) =>
      r.amount < 0 ? r.category_id === category : r.category_id === null,
    ),
  );
  assert.ok(prepared.rows.every((r) => r.duplicate === false));
  assert.match(prepared.batch_sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    prepared.expires_at,
    new Date(
      Date.parse("2026-11-04T12:00:00.000Z") + CONNECTOR_LIMITS.batchTtlMs,
    ).toISOString(),
  );
  // Nothing reached the budget yet.
  assert.equal(b.accountTransactions(accountId).length, 0);
  // Expenses without memory need the owner's default category.
  await assert.rejects(prepare(b, hash, accountId), /categoría/);
  // Requests are checked before anything runs.
  run.calls.length = 0;
  await assert.rejects(prepare(b, hash, 999), /cuenta/);
  await assert.rejects(
    prepare(b, hash, accountId, { content_base64: "%%%" }),
    coded("CONNECTOR_REQUEST_INVALID"),
  );
  await assert.rejects(
    prepare(b, hash, accountId, { config: "c".repeat(16_385) }),
    coded("CONNECTOR_REQUEST_INVALID"),
  );
  await assert.rejects(
    prepare(b, "a".repeat(64), accountId, { category_id: category }),
    coded("CONNECTOR_UNKNOWN"),
  );
  await assert.rejects(
    prepare(b, "no-es-hash", accountId, { category_id: category }),
    coded("CONNECTOR_REQUEST_INVALID"),
  );
  await assert.rejects(
    prepare(b, hash, accountId, { category_id: 999 }),
    /categoría/,
  );
  assert.equal(run.calls.length, 0);
});

test("connectors only parse: their categories are ignored", async (t) => {
  const run = fakeRunner(async (request) => {
    const batch = batchFor(request.accountId);
    return {
      manifest,
      batch: {
        ...batch,
        entries: batch.entries.map((e) => ({ ...e, category_id: 1 })),
      },
    };
  });
  const { b, accountId, category } = fixture(t, { runConnector: run });
  const hash = await installed(b);
  const prepared = await prepare(b, hash, accountId, { category_id: category });
  assert.ok(
    prepared.rows
      .filter((r) => r.amount < 0)
      .every((r) => r.category_id === category),
  );
  assert.ok(
    prepared.rows
      .filter((r) => r.amount > 0)
      .every((r) => r.category_id === null),
  );
});

test("confirm imports the stored batch once; retries return the same result", async (t) => {
  const { b, accountId, category } = fixture(t);
  const { prepared, result } = await importThroughConnector(b, accountId, {
    category_id: category,
  });
  assert.deepEqual(result, { added: 5, duplicates: 0 });
  const transactions = b.accountTransactions(accountId);
  assert.equal(transactions.length, 5);
  assert.deepEqual(
    transactions.map((t) => t.import_key).sort(),
    prepared.rows.map((r) => r.import_key).sort(),
  );
  assert.ok(transactions.every((t) => t.cleared === 1));
  const again = b.confirmConnectorImport({
    id: prepared.id,
    batch_sha256: prepared.batch_sha256,
  });
  assert.deepEqual(again, result);
  assert.equal(b.accountTransactions(accountId).length, 5);
  // The confirmed batch keeps only its result.
  const row = b.db
    .prepare("SELECT * FROM connector_batches WHERE id=?")
    .get(prepared.id);
  assert.equal(row.batch, null);
  assert.deepEqual(JSON.parse(row.result), result);
});

test("a confirmation that is not what was reviewed is refused", async (t) => {
  const { b, accountId, category } = fixture(t);
  const hash = await installed(b);
  const prepared = await prepare(b, hash, accountId, { category_id: category });
  for (const args of [
    { id: prepared.id, batch_sha256: "0".repeat(64) },
    { id: prepared.id, batch_sha256: prepared.batch_sha256.toUpperCase() },
  ])
    assert.throws(
      () => b.confirmConnectorImport(args),
      (e) =>
        ["CONNECTOR_BATCH_MISMATCH", "CONNECTOR_REQUEST_INVALID"].includes(
          e.code,
        ),
    );
  assert.throws(
    () => b.confirmConnectorImport({ id: prepared.id }),
    coded("CONNECTOR_REQUEST_INVALID"),
  );
  assert.throws(
    () =>
      b.confirmConnectorImport({
        id: "otro",
        batch_sha256: prepared.batch_sha256,
      }),
    coded("CONNECTOR_BATCH_UNKNOWN"),
  );
  assert.throws(
    () =>
      b.confirmConnectorImport({ id: 7, batch_sha256: prepared.batch_sha256 }),
    coded("CONNECTOR_BATCH_UNKNOWN"),
  );
  // Rows from the caller are not an input at all.
  assert.throws(
    () =>
      b.confirmConnectorImport({
        id: prepared.id,
        batch_sha256: "f".repeat(64),
        rows: [],
      }),
    coded("CONNECTOR_BATCH_MISMATCH"),
  );
  // The stored batch itself changed: the reviewed hash no longer matches it.
  b.db
    .prepare(
      "UPDATE connector_batches SET batch=replace(batch,'Sueldo','Sueldo alterado') WHERE id=?",
    )
    .run(prepared.id);
  assert.throws(
    () =>
      b.confirmConnectorImport({
        id: prepared.id,
        batch_sha256: prepared.batch_sha256,
      }),
    coded("CONNECTOR_BATCH_MISMATCH"),
  );
  assert.equal(b.accountTransactions(accountId).length, 0);
});

test("categories are the reviewed ones, not recomputed from a memory that changed", async (t) => {
  const { b, accountId, category } = fixture(t);
  const hash = await installed(b);
  const prepared = await prepare(b, hash, accountId, { category_id: category });
  const other = b.createCategory({
    name: "Otra",
    group_id: b.createGroup({ name: "Otro" }),
  });
  const expense = prepared.rows.find((r) => r.amount < 0);
  // The owner categorizes the same payee elsewhere: memory changes.
  const manual = b.addTransaction({
    account_id: accountId,
    date: "2026-10-01",
    payee: expense.payee,
    amount: -1,
    category_id: other,
  });
  b.deleteTransaction(manual);
  b.confirmConnectorImport({
    id: prepared.id,
    batch_sha256: prepared.batch_sha256,
  });
  const imported = b
    .accountTransactions(accountId)
    .find((t) => t.import_key === expense.import_key);
  assert.equal(imported.category_id, category);
});

test("a revoked or changed connector stops; so does an expired batch", async (t) => {
  const { b, dir, clock, accountId, category } = fixture(t);
  const hash = await installed(b);
  const prepared = await prepare(b, hash, accountId, { category_id: category });
  b.revokeConnector({ hash });
  assert.equal(b.listConnectors()[0].enabled, false);
  assert.throws(
    () =>
      b.confirmConnectorImport({
        id: prepared.id,
        batch_sha256: prepared.batch_sha256,
      }),
    coded("CONNECTOR_DISABLED"),
  );
  await assert.rejects(
    prepare(b, hash, accountId, { category_id: category }),
    coded("CONNECTOR_DISABLED"),
  );
  b.enableConnector({ hash });
  // The artifact changes on disk after its approval.
  const file = path.join(dir, "connectors", hash, "component.wasm");
  writeFileSync(file, Buffer.from("otro componente"));
  await assert.rejects(
    prepare(b, hash, accountId, { category_id: category }),
    coded("CONNECTOR_ARTIFACT_CHANGED"),
  );
  assert.throws(
    () =>
      b.confirmConnectorImport({
        id: prepared.id,
        batch_sha256: prepared.batch_sha256,
      }),
    coded("CONNECTOR_ARTIFACT_CHANGED"),
  );
  assert.throws(
    () => b.enableConnector({ hash }),
    coded("CONNECTOR_ARTIFACT_CHANGED"),
  );
  rmSync(file);
  await assert.rejects(
    prepare(b, hash, accountId, { category_id: category }),
    coded("CONNECTOR_ARTIFACT_CHANGED"),
  );
  writeFileSync(file, component);
  // Expiry: exactly at expires_at the batch is gone.
  clock.now = new Date(Date.parse(prepared.expires_at));
  assert.throws(
    () =>
      b.confirmConnectorImport({
        id: prepared.id,
        batch_sha256: prepared.batch_sha256,
      }),
    coded("CONNECTOR_BATCH_EXPIRED"),
  );
  clock.now = new Date(Date.parse(prepared.expires_at) - 1);
  assert.deepEqual(
    b.confirmConnectorImport({
      id: prepared.id,
      batch_sha256: prepared.batch_sha256,
    }),
    { added: 5, duplicates: 0 },
  );
  assert.equal(audits(b, "connector-revoke").length, 1);
  assert.equal(
    audits(b, "connector-enable").filter((a) => a.decision === "allow").length,
    2,
  );
  assert.equal(
    audits(b, "connector-enable").filter((a) => a.decision === "error").length,
    1,
  );
});

test("revoked while it runs: nothing is stored", async (t) => {
  const state = {};
  const run = fakeRunner(async (request) => {
    if (request.op === "parse")
      state.budget.revokeConnector({ hash: state.hash });
    return request.op === "describe"
      ? { manifest }
      : { manifest, batch: batchFor(request.accountId) };
  });
  const { b, accountId, category } = fixture(t, { runConnector: run });
  state.budget = b;
  state.hash = await installed(b);
  await assert.rejects(
    prepare(b, state.hash, accountId, { category_id: category }),
    coded("CONNECTOR_DISABLED"),
  );
  assert.equal(
    b.db.prepare("SELECT COUNT(*) n FROM connector_batches").get().n,
    0,
  );
});

test("the connector's hash never enters the identity of movements", async (t) => {
  const { b, accountId, category } = fixture(t);
  const first = await importThroughConnector(b, accountId, {
    category_id: category,
  });
  const second = await importThroughConnector(b, accountId, {
    category_id: category,
    component: Buffer.from("versión nueva del componente ficticio"),
  });
  assert.notEqual(first.installed.hash, second.installed.hash);
  assert.deepEqual(second.result, { added: 0, duplicates: 5 });
  assert.ok(second.prepared.rows.every((r) => r.duplicate));
  assert.equal(b.accountTransactions(accountId).length, 5);
});

test("pending batches are bounded per actor; expired and old ones are purged", async (t) => {
  const { b, clock, accountId, category } = fixture(t);
  const hash = await installed(b);
  const first = await prepare(b, hash, accountId, { category_id: category });
  for (let i = 1; i < CONNECTOR_LIMITS.pendingPerActor; i++)
    await prepare(b, hash, accountId, { category_id: category });
  await assert.rejects(
    prepare(b, hash, accountId, { category_id: category }),
    coded("CONNECTOR_BATCH_LIMIT"),
  );
  b.confirmConnectorImport({ id: first.id, batch_sha256: first.batch_sha256 });
  await prepare(b, hash, accountId, { category_id: category });
  // Unconfirmed batches go when they expire; confirmed ones after their own term.
  clock.now = new Date(Date.parse(first.expires_at) + 1);
  await prepare(b, hash, accountId, { category_id: category });
  const count = () =>
    b.db.prepare("SELECT COUNT(*) n FROM connector_batches").get().n;
  assert.equal(count(), 2, "the confirmed batch and the new one");
  clock.now = new Date(
    clock.now.getTime() + CONNECTOR_LIMITS.confirmedTtlMs + 1,
  );
  await prepare(b, hash, accountId, { category_id: category });
  assert.equal(count(), 1);
});

test("agents prepare only with allow; confirmations go through proposals; batches stay with their actor", async (t) => {
  const { b, accountId, category } = fixture(t);
  const hash = await installed(b);
  const connection = b.createConnection({ label: "Agente ficticio" });
  const agent = b.forAgent(connection.token);
  const grant = (action, decision) =>
    b.setRule({
      connection_id: connection.id,
      action,
      decision,
      conditions: {},
    });
  // Running a connector is allowed or denied, never deferred.
  assert.throws(() => grant("connector-prepare", "ask"), coded("INVALID_RULE"));
  grant("connector-prepare", "allow");
  const prepared = await agent.prepareConnectorImport({
    hash,
    account_id: accountId,
    content_base64: base64(statement),
    category_id: category,
  });
  // The owner cannot confirm the agent's batch directly, nor the agent the owner's.
  assert.throws(
    () =>
      b.confirmConnectorImport({
        id: prepared.id,
        batch_sha256: prepared.batch_sha256,
      }),
    coded("CONNECTOR_BATCH_UNKNOWN"),
  );
  const own = await prepare(b, hash, accountId, { category_id: category });
  grant("connector-import", "allow");
  assert.throws(
    () =>
      agent.confirmConnectorImport({
        id: own.id,
        batch_sha256: own.batch_sha256,
      }),
    coded("CONNECTOR_BATCH_UNKNOWN"),
  );
  grant("connector-import", "ask");
  const pending = agent.request(
    "connector-import",
    { id: prepared.id, batch_sha256: prepared.batch_sha256 },
    {
      purpose: "Importar extracto ficticio",
      base: b.eventSnapshot().cursor,
      request_id: "importar-1",
    },
  );
  assert.equal(pending.status, "pending");
  assert.equal(b.accountTransactions(accountId).length, 0);
  const resolved = b.resolveProposal({
    id: pending.proposal_id,
    decision: "accept",
  });
  assert.equal(resolved.status, "accepted");
  assert.deepEqual(resolved.result, { added: 5, duplicates: 0 });
  assert.equal(b.accountTransactions(accountId).length, 5);
});

test("recovery: a restored backup does not revive an enablement; a copied folder does not either", async (t) => {
  const { b, dir, reopen, accountId, category, opened } = fixture(t);
  const entry = await b.installConnector({
    component_base64: base64(component),
  });
  const before = path.join(dir, "antes.db");
  await b.db.backup(before);
  b.enableConnector({ hash: entry.hash });
  const after = path.join(dir, "despues.db");
  await b.db.backup(after);
  b.close();
  // Restoring a copy from before the enablement: the inventory still says
  // enabled, but this history never recorded it.
  const restore = (file) => {
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(path.join(dir, "budget.db" + suffix), { force: true });
    copyFileSync(file, path.join(dir, "budget.db"));
  };
  restore(before);
  let restored = reopen();
  assert.deepEqual(
    restored
      .listConnectors()
      .map(({ enabled, invalidated }) => ({ enabled, invalidated })),
    [{ enabled: false, invalidated: true }],
  );
  await assert.rejects(
    prepare(restored, entry.hash, accountId, { category_id: category }),
    coded("CONNECTOR_DISABLED"),
  );
  restored.close();
  // A copy from after the enablement is this same state: it holds.
  restore(after);
  restored = reopen();
  assert.equal(restored.listConnectors()[0].enabled, true);
  // Revoked, then a copy from before the revocation: it stays revoked.
  restored.revokeConnector({ hash: entry.hash });
  restored.close();
  restore(after);
  restored = reopen();
  assert.equal(restored.listConnectors()[0].enabled, false);
  assert.equal(restored.listConnectors()[0].invalidated, false);
  restored.close();

  // The connectors folder copied next to another budget: nothing holds there,
  // and the first change there drops the foreign enablements.
  const otherDir = mkdtempSync(
    path.join(os.tmpdir(), "nemein-connectors-other-"),
  );
  t.after(() => rmSync(otherDir, { recursive: true, force: true }));
  const first = reopen();
  first.enableConnector({ hash: entry.hash });
  first.close();
  cpSync(path.join(dir, "connectors"), path.join(otherDir, "connectors"), {
    recursive: true,
  });
  const other = openBudget(otherDir, { runConnector: fakeRunner() });
  opened.push(other);
  assert.deepEqual(
    other
      .listConnectors()
      .map(({ enabled, invalidated }) => ({ enabled, invalidated })),
    [{ enabled: false, invalidated: true }],
  );
  other.revokeConnector({ hash: entry.hash });
  const inventory = JSON.parse(
    readFileSync(path.join(otherDir, "connectors", "inventory.json"), "utf8"),
  );
  assert.notEqual(
    inventory.source,
    JSON.parse(
      readFileSync(path.join(dir, "connectors", "inventory.json"), "utf8"),
    ).source,
  );
  assert.equal(inventory.connectors[0].enablement, null);
});

test("a damaged inventory fails closed and is not overwritten", async (t) => {
  const { b, dir, accountId, category } = fixture(t);
  const hash = await installed(b);
  const file = path.join(dir, "connectors", "inventory.json");
  for (const damaged of [
    "{",
    "null",
    JSON.stringify({ version: 2, source: "x", connectors: [] }),
    JSON.stringify({ version: 1, source: "x", connectors: [{ hash }] }),
  ]) {
    writeFileSync(file, damaged);
    assert.throws(
      () => b.listConnectors(),
      coded("CONNECTOR_INVENTORY_INVALID"),
    );
    await assert.rejects(
      prepare(b, hash, accountId, { category_id: category }),
      coded("CONNECTOR_INVENTORY_INVALID"),
    );
    await assert.rejects(
      b.installConnector({ component_base64: base64(component) }),
      coded("CONNECTOR_INVENTORY_INVALID"),
    );
    assert.equal(readFileSync(file, "utf8"), damaged);
  }
  assert.ok(existsSync(path.join(dir, "connectors", hash, "component.wasm")));
});
