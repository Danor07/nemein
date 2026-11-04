import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
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
import { LIMITS } from "../src/connector-runner.js";
import { CONNECTOR_LIMITS, decodeBase64, sha256 } from "../src/connectors.js";
import { signComponent } from "../src/connector-signature.js";
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
  b.enableConnector({ acknowledge_unsigned: true, hash: entry.hash });
  return entry.hash;
}
const audits = (b, action) =>
  b.db
    .prepare("SELECT * FROM agent_audit WHERE action=? ORDER BY sequence")
    .all(action);
// The owner's audit rows for one action, as {args, decision, reason}.
const trail = (b, action) =>
  audits(b, action).map((a) => {
    assert.equal(a.actor, "owner");
    return {
      args: JSON.parse(a.args),
      decision: a.decision,
      reason: a.reason,
    };
  });
const inventoryOf = (dir) =>
  JSON.parse(
    readFileSync(path.join(dir, "connectors", "inventory.json"), "utf8"),
  );

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
  assert.equal(run.calls[1].accountId, "1", "describe names a valid account");
  const installedRow = {
    args: { hash: entry.hash, manifest, signature: "absent" },
    decision: "allow",
    reason: "Conector instalado, deshabilitado",
  };
  assert.deepEqual(trail(b, "connector-install"), [installedRow, installedRow]);
  // Strict base64 and the component limit; each refusal is audited.
  const refusals = [];
  for (const bad of ["no es base64!", "QQ", 1, "Q".repeat(23_000_000)])
    await assert.rejects(b.installConnector({ component_base64: bad }), (e) => {
      coded("CONNECTOR_REQUEST_INVALID")(e);
      assert.match(e.message, /^El componente /);
      refusals.push({ args: {}, decision: "error", reason: e.message });
      return true;
    });
  assert.deepEqual(trail(b, "connector-install").slice(2), refusals);
  assert.equal(run.calls.length, 2, "nothing invalid reached the worker");
});

test("a failed install is audited with its reason, or a generic one", async (t) => {
  const failures = [
    Object.assign(new Error("El componente no responde."), { code: "X" }),
    new Error(""),
  ];
  const run = fakeRunner(async () => {
    throw failures.shift();
  });
  const { b, dir } = fixture(t, { runConnector: run });
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      b.installConnector({
        component_base64: base64(component),
      }),
    );
  assert.deepEqual(trail(b, "connector-install"), [
    { args: {}, decision: "error", reason: "El componente no responde." },
    { args: {}, decision: "error", reason: "La operación falló" },
  ]);
  assert.equal(existsSync(path.join(dir, "connectors")), false);
});

test("base64 is bounded by its length before it is decoded", () => {
  // Longer than any encoding within the limit: refused as too long,
  // whatever it holds.
  assert.throws(() => decodeBase64("!".repeat(8), 3, "El archivo"), {
    code: "CONNECTOR_REQUEST_INVALID",
    message: "El archivo supera su límite.",
  });
  // Short enough to be read, but more bytes than the limit.
  assert.throws(
    () => decodeBase64(Buffer.alloc(5).toString("base64"), 4, "El archivo"),
    {
      code: "CONNECTOR_REQUEST_INVALID",
      message: "El archivo supera su límite.",
    },
  );
  assert.deepEqual(
    decodeBase64(Buffer.alloc(4).toString("base64"), 4, "El archivo"),
    Buffer.alloc(4),
  );
  assert.throws(() => decodeBase64("QQ", 4, "El archivo"), {
    code: "CONNECTOR_REQUEST_INVALID",
    message: "El archivo no es base64 válido.",
  });
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
  // A day to review it, also as a proposal.
  assert.equal(prepared.expires_at, "2026-11-05T12:00:00.000Z");
  assert.deepEqual(prepared.connector, { hash, manifest });
  assert.equal(prepared.account_id, accountId);
  const row = b.db
    .prepare("SELECT * FROM connector_batches WHERE id=?")
    .get(prepared.id);
  assert.equal(row.actor, "owner");
  assert.equal(row.config, "perfil=ficticio");
  assert.equal(row.component_hash, hash);
  // Nothing reached the budget yet.
  assert.equal(b.accountTransactions(accountId).length, 0);
  // Without config the worker gets an empty one; the limit is in bytes.
  run.calls.length = 0;
  await prepare(b, hash, accountId, { category_id: category });
  await prepare(b, hash, accountId, {
    category_id: category,
    config: "c".repeat(LIMITS.config),
  });
  assert.deepEqual(
    run.calls.map((c) => c.config.length),
    [0, LIMITS.config],
  );
  // Expenses without memory need the owner's default category: none given,
  // or none on purpose.
  for (const category_id of [undefined, null])
    await assert.rejects(
      prepare(b, hash, accountId, { category_id }),
      /categoría inicial/,
    );
  // Requests are checked before anything runs.
  run.calls.length = 0;
  await assert.rejects(prepare(b, hash, 999), /cuenta/);
  await assert.rejects(
    prepare(b, hash, accountId, { content_base64: "%%%" }),
    (e) =>
      coded("CONNECTOR_REQUEST_INVALID")(e) &&
      e.message === "El archivo no es base64 válido.",
  );
  for (const config of ["c".repeat(LIMITS.config + 1), "ñ".repeat(8193), 5])
    await assert.rejects(
      prepare(b, hash, accountId, { config }),
      coded("CONNECTOR_REQUEST_INVALID"),
    );
  await assert.rejects(
    prepare(b, "a".repeat(64), accountId, { category_id: category }),
    coded("CONNECTOR_UNKNOWN"),
  );
  // Exactly a lowercase SHA-256, nothing around it.
  for (const bad of ["no-es-hash", "x" + hash, hash + "0", [hash]])
    await assert.rejects(
      prepare(b, bad, accountId, { category_id: category }),
      coded("CONNECTOR_REQUEST_INVALID"),
    );
  await assert.rejects(
    prepare(b, hash, accountId, { category_id: 999 }),
    /categoría no existe/,
  );
  assert.equal(run.calls.length, 0);
});

test("a batch for another account than the one chosen is refused", async (t) => {
  const run = fakeRunner(async (request) =>
    request.op === "describe"
      ? { manifest }
      : { manifest, batch: batchFor(Number(request.accountId) + 1) },
  );
  const { b, accountId, category } = fixture(t, { runConnector: run });
  b.createAccount({ name: "Otra ficticia", type: "efectivo" });
  const hash = await installed(b);
  await assert.rejects(
    prepare(b, hash, accountId, { category_id: category }),
    (e) =>
      coded("CONNECTOR_ACCOUNT_MISMATCH")(e) &&
      e.message === "El lote declara otra cuenta.",
  );
  assert.equal(
    b.db.prepare("SELECT COUNT(*) n FROM connector_batches").get().n,
    0,
  );
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
  assert.throws(
    () =>
      b.confirmConnectorImport({
        id: prepared.id + "0".repeat(64),
        batch_sha256: prepared.batch_sha256,
      }),
    coded("CONNECTOR_BATCH_UNKNOWN"),
  );
  // A stored row moved to another account: the batch the owner reviewed
  // still names the first one.
  const other = b.createAccount({ name: "Otra ficticia", type: "efectivo" });
  const move = b.db.prepare(
    "UPDATE connector_batches SET account_id=? WHERE id=?",
  );
  move.run(other, prepared.id);
  assert.throws(
    () =>
      b.confirmConnectorImport({
        id: prepared.id,
        batch_sha256: prepared.batch_sha256,
      }),
    (e) =>
      coded("CONNECTOR_ACCOUNT_MISMATCH")(e) &&
      e.message === "El lote declara otra cuenta.",
  );
  assert.equal(b.accountTransactions(other).length, 0);
  move.run(accountId, prepared.id);
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
  b.enableConnector({ acknowledge_unsigned: true, hash });
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

test("enabling and revoking touch only their connector; audit rows record each step", async (t) => {
  const { b, dir, accountId, category } = fixture(t);
  const second = Buffer.from("segundo componente ficticio");
  const a = (await b.installConnector({ component_base64: base64(component) }))
    .hash;
  const c = (await b.installConnector({ component_base64: base64(second) }))
    .hash;
  const state = () =>
    Object.fromEntries(
      b.listConnectors().map((e) => [e.hash, [e.enabled, e.invalidated]]),
    );
  assert.deepEqual(b.enableConnector({ acknowledge_unsigned: true, hash: a }), {
    hash: a,
    enabled: true,
  });
  assert.deepEqual(state(), { [a]: [true, false], [c]: [false, false] });
  const token = (hash) =>
    inventoryOf(dir).connectors.find((e) => e.hash === hash).enablement.token;
  const tokenA = token(a);
  assert.match(tokenA, /^[0-9a-f]{64}$/);
  b.enableConnector({ acknowledge_unsigned: true, hash: c });
  assert.notEqual(token(c), tokenA, "every enablement has its own token");
  assert.deepEqual(b.revokeConnector({ hash: c }), { hash: c, enabled: false });
  // A later revocation of another connector leaves this one enabled.
  assert.deepEqual(state(), { [a]: [true, false], [c]: [false, false] });
  await prepare(b, a, accountId, { category_id: category });
  assert.deepEqual(trail(b, "connector-enable"), [
    {
      args: { hash: a, token: tokenA, signature: "absent" },
      decision: "allow",
      reason: "Conector habilitado",
    },
    {
      args: {
        hash: c,
        token: JSON.parse(audits(b, "connector-enable")[1].args).token,
        signature: "absent",
      },
      decision: "allow",
      reason: "Conector habilitado",
    },
  ]);
  assert.deepEqual(trail(b, "connector-revoke"), [
    { args: { hash: c }, decision: "allow", reason: "Conector revocado" },
  ]);
  // Failed enablements are audited with what was asked.
  assert.throws(
    () => b.enableConnector({ hash: "f".repeat(64) }),
    coded("CONNECTOR_UNKNOWN"),
  );
  assert.throws(() => b.enableConnector(), coded("CONNECTOR_REQUEST_INVALID"));
  assert.deepEqual(trail(b, "connector-enable").slice(2), [
    {
      args: { hash: "f".repeat(64) },
      decision: "error",
      reason: "El conector no está instalado.",
    },
    {
      args: { hash: null },
      decision: "error",
      reason: "El conector no es un hash válido.",
    },
  ]);
});

test("an inventory copied back after a revocation does not undo it", async (t) => {
  const { b, dir, accountId, category } = fixture(t);
  const hash = await installed(b);
  const file = path.join(dir, "connectors", "inventory.json");
  const enabled = readFileSync(file);
  b.revokeConnector({ hash });
  writeFileSync(file, enabled);
  assert.deepEqual(
    b.listConnectors().map(({ enabled, invalidated }) => ({
      enabled,
      invalidated,
    })),
    [{ enabled: false, invalidated: true }],
  );
  await assert.rejects(
    prepare(b, hash, accountId, { category_id: category }),
    coded("CONNECTOR_DISABLED"),
  );
  // Enabling again is a new audit row after the revocation: it holds.
  b.enableConnector({ acknowledge_unsigned: true, hash });
  await prepare(b, hash, accountId, { category_id: category });
});

test("an artifact changed in place is refused; installing the same bytes repairs it", async (t) => {
  const { b, dir, accountId, category } = fixture(t);
  const hash = await installed(b);
  const file = path.join(dir, "connectors", hash, "component.wasm");
  // Same size, other bytes.
  const tampered = Buffer.from(component);
  tampered[0] ^= 1;
  writeFileSync(file, tampered);
  await assert.rejects(
    prepare(b, hash, accountId, { category_id: category }),
    coded("CONNECTOR_ARTIFACT_CHANGED"),
  );
  const enables = audits(b, "connector-enable").length;
  assert.throws(
    () => b.enableConnector({ hash }),
    coded("CONNECTOR_ARTIFACT_CHANGED"),
  );
  assert.deepEqual(
    audits(b, "connector-enable")
      .slice(enables)
      .map((a) => a.decision),
    ["error"],
    "no enablement is recorded for bytes that changed",
  );
  await b.installConnector({ component_base64: base64(component) });
  assert.deepEqual(readFileSync(file), component);
  // The enablement was never lost: it was the bytes that failed.
  assert.equal(b.listConnectors()[0].enabled, true);
  await prepare(b, hash, accountId, { category_id: category });
});

test("code that runs during an agent's request cannot administer connectors", async (t) => {
  const state = { attempts: [] };
  const run = fakeRunner(async (request) => {
    if (request.op === "parse" && state.hash)
      for (const attempt of [
        () => state.budget.installConnector({ component_base64: base64("x") }),
        async () => state.budget.enableConnector({ hash: state.hash }),
        async () => state.budget.revokeConnector({ hash: state.hash }),
      ])
        await attempt().then(
          () => state.attempts.push("allowed"),
          (e) => state.attempts.push(e.code),
        );
    return request.op === "describe"
      ? { manifest }
      : { manifest, batch: batchFor(request.accountId) };
  });
  const { b, accountId, category } = fixture(t, { runConnector: run });
  state.budget = b;
  const hash = await installed(b);
  const connection = b.createConnection({ label: "Agente ficticio" });
  b.setRule({
    connection_id: connection.id,
    action: "connector-prepare",
    decision: "allow",
    conditions: {},
  });
  state.hash = hash;
  const prepared = await b.forAgent(connection.token).prepareConnectorImport({
    hash,
    account_id: accountId,
    content_base64: base64(statement),
    category_id: category,
  });
  assert.deepEqual(state.attempts, [
    "OWNER_REQUIRED",
    "OWNER_REQUIRED",
    "OWNER_REQUIRED",
  ]);
  // Nothing changed, and nothing was audited as the owner's.
  assert.equal(b.listConnectors().length, 1);
  assert.equal(b.listConnectors()[0].enabled, true);
  assert.equal(audits(b, "connector-install").length, 1);
  assert.equal(audits(b, "connector-enable").length, 1);
  assert.equal(audits(b, "connector-revoke").length, 0);
  // The agent's batch is stored under the agent, not the owner.
  assert.equal(
    b.db
      .prepare("SELECT actor FROM connector_batches WHERE id=?")
      .get(prepared.id).actor,
    String(connection.id),
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

test("pending batches are bounded in bytes across actors", async (t) => {
  const { b, accountId, category } = fixture(t);
  const hash = await installed(b);
  const first = await prepare(b, hash, accountId, { category_id: category });
  const size = b.db
    .prepare("SELECT octet_length(batch) n FROM connector_batches WHERE id=?")
    .get(first.id).n;
  assert.ok(size > 0);
  // Another actor's pending batch takes all the room but one more batch.
  b.db
    .prepare(
      "INSERT INTO connector_batches(id,actor,component_hash,input_hash,config,account_id,batch,batch_hash,created_at,expires_at) VALUES ('relleno','otro',?,?,'',?,zeroblob(?),?,?,?)",
    )
    .run(
      hash,
      hash,
      accountId,
      CONNECTOR_LIMITS.pendingBytes - 2 * size,
      "0".repeat(64),
      "2026-11-04T12:00:00.000Z",
      first.expires_at,
    );
  // Exactly at the limit is still within it.
  await prepare(b, hash, accountId, { category_id: category });
  await assert.rejects(
    prepare(b, hash, accountId, { category_id: category }),
    coded("CONNECTOR_BATCH_LIMIT"),
  );
  // A confirmed batch keeps no bytes.
  b.confirmConnectorImport({ id: first.id, batch_sha256: first.batch_sha256 });
  await prepare(b, hash, accountId, { category_id: category });
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
  b.enableConnector({ acknowledge_unsigned: true, hash: entry.hash });
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
  first.enableConnector({ acknowledge_unsigned: true, hash: entry.hash });
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

const signer = generateKeyPairSync("ed25519").privateKey;
const signatureFor = (bytes, key = signer) => signComponent(sha256(bytes), key);

test("without a valid signature, enabling needs the owner's explicit acknowledgement", async (t) => {
  const { b, accountId, category } = fixture(t);
  const signedBytes = Buffer.from("componente firmado ficticio");
  const wrong = Buffer.from("componente con firma ajena");
  const unsigned = (
    await b.installConnector({ component_base64: base64(component) })
  ).hash;
  const valid = await b.installConnector({
    component_base64: base64(signedBytes),
    signature: JSON.stringify(signatureFor(signedBytes)),
  });
  // A signature of another component informs, and is kept.
  const invalid = await b.installConnector({
    component_base64: base64(wrong),
    signature: signatureFor(component),
  });
  assert.equal(valid.signature.status, "valid");
  assert.match(valid.signature.key, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    { status: invalid.signature.status, reason: invalid.signature.reason },
    { status: "invalid", reason: "component" },
  );
  const before = audits(b, "connector-enable").length;
  for (const hash of [unsigned, invalid.hash])
    for (const acknowledge_unsigned of [undefined, false, "yes", 1])
      assert.throws(
        () => b.enableConnector({ hash, acknowledge_unsigned }),
        (e) =>
          coded("CONNECTOR_SIGNATURE_UNACKNOWLEDGED")(e) &&
          /firma válida/.test(e.message),
      );
  assert.ok(
    audits(b, "connector-enable")
      .slice(before)
      .every((a) => a.decision === "error"),
    "a refused enablement leaves no row that holds",
  );
  assert.ok(b.listConnectors().every((c) => !c.enabled));
  // A valid signature enables as before; the others with the acknowledgement.
  b.enableConnector({ hash: valid.hash });
  b.enableConnector({ hash: unsigned, acknowledge_unsigned: true });
  b.enableConnector({ hash: invalid.hash, acknowledge_unsigned: true });
  assert.deepEqual(
    trail(b, "connector-enable")
      .filter((a) => a.decision === "allow")
      .map((a) => [a.args.hash, a.args.signature]),
    [
      [valid.hash, "valid"],
      [unsigned, "absent"],
      [invalid.hash, "invalid"],
    ],
  );
  assert.deepEqual(
    trail(b, "connector-install").map((a) => a.args.signature),
    ["absent", "valid", "invalid"],
  );
  await prepare(b, valid.hash, accountId, { category_id: category });
});

test("a signature given when reinstalling replaces the stored one and keeps the enablement", async (t) => {
  const { b, run } = fixture(t);
  const hash = (
    await b.installConnector({ component_base64: base64(component) })
  ).hash;
  b.enableConnector({ hash, acknowledge_unsigned: true });
  const added = await b.installConnector({
    component_base64: base64(component),
    signature: signatureFor(component),
  });
  assert.equal(added.signature.status, "valid");
  assert.equal(added.enabled, true, "the enablement belongs to the bytes");
  // Without a signature, reinstalling keeps the stored one.
  const again = await b.installConnector({
    component_base64: base64(component),
  });
  assert.deepEqual(again.signature, added.signature);
  // Another key replaces it.
  const other = generateKeyPairSync("ed25519").privateKey;
  const replaced = await b.installConnector({
    component_base64: base64(component),
    signature: signatureFor(component, other),
  });
  assert.notEqual(replaced.signature.key, added.signature.key);
  assert.equal(b.listConnectors().length, 1);
  assert.equal(b.listConnectors()[0].enabled, true);
  // A malformed signature file is refused before anything runs.
  const calls = run.calls.length;
  for (const signature of ["{", { x: 1 }, "x".repeat(5000)])
    await assert.rejects(
      b.installConnector({ component_base64: base64("otro"), signature }),
      coded("CONNECTOR_REQUEST_INVALID"),
    );
  assert.equal(run.calls.length, calls);
  assert.equal(b.listConnectors().length, 1);
});

test("an inventory with a damaged signature fails closed", async (t) => {
  const { b, dir } = fixture(t);
  await b.installConnector({
    component_base64: base64(component),
    signature: signatureFor(component),
  });
  const file = path.join(dir, "connectors", "inventory.json");
  const inventory = inventoryOf(dir);
  assert.equal(
    inventory.connectors[0].signature.format,
    "nemein-connector-signature",
  );
  // Written before signatures: the field is absent, and the entry is unsigned.
  delete inventory.connectors[0].signature;
  writeFileSync(file, JSON.stringify(inventory));
  assert.equal(b.listConnectors()[0].signature.status, "absent");
  inventory.connectors[0].signature = { format: "otra" };
  writeFileSync(file, JSON.stringify(inventory));
  assert.throws(() => b.listConnectors(), coded("CONNECTOR_INVENTORY_INVALID"));
});

test("the screen reads a batch back only for its actor, with duplicates marked", async (t) => {
  const { b, accountId, category } = fixture(t);
  const hash = await installed(b);
  const first = await prepare(b, hash, accountId, { category_id: category });
  const review = b.connectorBatch({ id: first.id });
  assert.deepEqual(
    {
      id: review.id,
      batch_sha256: review.batch_sha256,
      expires_at: review.expires_at,
      account_id: review.account_id,
      connector: review.connector,
      confirmed: review.confirmed,
    },
    {
      id: first.id,
      batch_sha256: first.batch_sha256,
      expires_at: first.expires_at,
      account_id: accountId,
      connector: hash,
      confirmed: false,
    },
  );
  // The same rows the preparation answered.
  assert.deepEqual(
    review.rows,
    first.rows.map((r) => ({
      date: r.date,
      payee: r.payee,
      amount: r.amount,
      category_id: r.category_id,
      import_key: r.import_key,
      duplicate: r.duplicate,
    })),
  );
  const second = await prepare(b, hash, accountId, { category_id: category });
  b.confirmConnectorImport({ id: first.id, batch_sha256: first.batch_sha256 });
  assert.deepEqual(b.connectorBatch({ id: first.id }), {
    id: first.id,
    batch_sha256: first.batch_sha256,
    expires_at: first.expires_at,
    account_id: accountId,
    connector: hash,
    confirmed: true,
    result: { added: 5, duplicates: 0 },
  });
  // Now in the budget: the other batch shows its rows as duplicates.
  assert.ok(b.connectorBatch({ id: second.id }).rows.every((r) => r.duplicate));
  for (const id of ["otro", 7, undefined])
    assert.throws(
      () => b.connectorBatch({ id }),
      coded("CONNECTOR_BATCH_UNKNOWN"),
    );
  assert.throws(() => b.connectorBatch(), coded("CONNECTOR_BATCH_UNKNOWN"));
  // An agent's batch is not the owner's to read.
  const connection = b.createConnection({ label: "Agente ficticio" });
  b.setRule({
    connection_id: connection.id,
    action: "connector-prepare",
    decision: "allow",
    conditions: {},
  });
  const theirs = await b.forAgent(connection.token).prepareConnectorImport({
    hash,
    account_id: accountId,
    content_base64: base64(statement),
    category_id: category,
  });
  assert.throws(
    () => b.connectorBatch({ id: theirs.id }),
    coded("CONNECTOR_BATCH_UNKNOWN"),
  );
});

test("the audit keeps the digest and size of a prepared file, not its content", async (t) => {
  const { b, accountId, category } = fixture(t);
  const hash = await installed(b);
  const owner = await prepare(b, hash, accountId, { category_id: category });
  const connection = b.createConnection({ label: "Agente ficticio" });
  b.setRule({
    connection_id: connection.id,
    action: "connector-prepare",
    decision: "allow",
    conditions: {},
  });
  const agent = await b.forAgent(connection.token).prepareConnectorImport({
    hash,
    account_id: accountId,
    content_base64: base64(statement),
    category_id: category,
  });
  const rows = audits(b, "connector-prepare");
  assert.equal(rows.length, 2);
  const input = b.db
    .prepare("SELECT input_hash FROM connector_batches WHERE id=?")
    .get(owner.id).input_hash;
  assert.equal(
    b.db
      .prepare("SELECT input_hash FROM connector_batches WHERE id=?")
      .get(agent.id).input_hash,
    input,
  );
  for (const row of rows) {
    const args = JSON.parse(row.args);
    assert.deepEqual(args.content_base64, {
      sha256: input,
      bytes: statement.length,
    });
    assert.equal(args.hash, hash);
    assert.equal(args.account_id, accountId);
    assert.ok(!row.args.includes(base64(statement)));
  }
  // Other actions keep their arguments as they were.
  const enable = JSON.parse(audits(b, "connector-enable")[0].args);
  assert.equal(enable.hash, hash);
});
