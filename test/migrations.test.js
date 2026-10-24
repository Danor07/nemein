import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openBudget } from "../src/core.js";
import { schemaVersion } from "../src/migrations.js";

const oldSchema = (name) =>
  readFileSync(
    new URL("./fixtures/migrations/" + name + ".sql", import.meta.url),
    "utf8",
  );
const token = "migration-fixture-token-with-at-least-32-characters";
const source = "urn:uuid:migration-fixture";
const cursor = Buffer.from(
  JSON.stringify({ version: 1, source, sequence: 1, id: "old-event" }),
).toString("base64url");
function directory(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-migrations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function rows(db) {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name!='schema_migrations' ORDER BY name",
      )
      .all()
      .map(({ name }) => [
        name,
        db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all(),
      ]),
  );
}
function state(db) {
  return {
    version: db.pragma("user_version", { simple: true }),
    schema: db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name",
      )
      .all(),
    rows: rows(db),
    migrations: db
      .prepare("SELECT 1 FROM sqlite_schema WHERE name='schema_migrations'")
      .get()
      ? db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()
      : null,
  };
}
function legacy(t, version = "0.1.0") {
  const dir = directory(t),
    db = new Database(path.join(dir, "budget.db"));
  db.exec(oldSchema("v0.1.0"));
  db.exec(
    "INSERT INTO accounts VALUES (7,'Cuenta ficticia','corriente');" +
      "INSERT INTO groups_ VALUES (9,'Grupo propio'); INSERT INTO categories VALUES (20,9,'Categoría propia');" +
      "INSERT INTO allocations VALUES ('2026-10',1,400000);" +
      "INSERT INTO transactions(id,account_id,date,payee,amount,category_id,cleared,reconciled,import_key) VALUES (49,7,'2026-10-01','Ingreso ficticio',1000000,NULL,1,1,'original-income'),(50,7,'2026-10-02','Compra ficticia',-25000,1,1,1,'original-expense');" +
      "INSERT INTO memory VALUES ('Compra ficticia',1); INSERT INTO mappings VALUES (7,'{}');" +
      "INSERT INTO reconciliations VALUES (1,7,'2026-10-03',975000);" +
      "INSERT INTO goals VALUES (1,500000,'2026-12-01');" +
      "INSERT INTO recurring VALUES (8,7,1,'Pago ficticio',-25000,'2026-11-02','monthly',2,1);" +
      "INSERT INTO recurring_occurrences VALUES (8,'2026-10-02',50);",
  );
  if (version !== "0.1.0") {
    db.exec(oldSchema("v0.2.0"));
    db.prepare("INSERT INTO event_identity VALUES (1,?)").run(source);
    db.prepare(
      "INSERT INTO budget_events(sequence,id,envelope) VALUES (1,?,?)",
    ).run(
      "old-event",
      JSON.stringify({
        specversion: "1.0",
        id: "old-event",
        source,
        type: "io.nemein.budget.changed.v1",
        data: { operation: "addTransaction" },
      }),
    );
    if (version === "P4") {
      db.exec(
        "DROP TABLE agent_proposals; DROP TABLE agent_rules; DROP TABLE agent_requests; DROP TABLE agent_audit; DROP TABLE agent_connections;",
      );
    } else {
      db.prepare("INSERT INTO agent_connections VALUES (?,?,?,?,1,?)").run(
        "fixture",
        "Cliente ficticio",
        "1",
        createHash("sha256").update(token).digest("hex"),
        "2026-10-01",
      );
      db.exec(
        "INSERT INTO agent_rules VALUES ('fixture','1','snapshot',1,'allow','{}'),('fixture','1','group',1,'ask','{}');" +
          "INSERT INTO agent_audit(at,actor,action,args,decision,reason,policy) VALUES ('2026-10-01','fixture','snapshot','{}','allow','Regla anterior','{}');" +
          "INSERT INTO agent_requests VALUES ('fixture','saved-request','original-fingerprint','{\"status\":\"pending\"}');",
      );
      db.prepare(
        "INSERT INTO agent_proposals(id,actor,connection_version,request_id,action,action_version,args,base,purpose,status,created_at) VALUES ('pending-proposal','fixture','1','old-proposal','group',1,?,?,?,'pending','2026-10-01')",
      ).run(JSON.stringify({ name: "Grupo propuesto" }), cursor, "Organizar");
    }
  }
  return { dir, db };
}
function verifyHistory(db) {
  const history = db
    .prepare("SELECT * FROM schema_migrations ORDER BY version")
    .all();
  assert.equal(history.length, schemaVersion);
  assert.equal(db.pragma("user_version", { simple: true }), schemaVersion);
  assert.deepEqual(
    history.map((r) => r.version),
    Array.from({ length: schemaVersion }, (_, i) => i + 1),
  );
  assert.ok(
    history.every(
      (r) =>
        r.name.startsWith(String(r.version).padStart(3, "0")) &&
        /^[a-f0-9]{64}$/.test(r.checksum) &&
        !Number.isNaN(Date.parse(r.applied_at)),
    ),
  );
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  return history;
}
test("migrations: fresh database, numbered history and idempotent reopen", (t) => {
  const dir = directory(t),
    b = openBudget(dir);
  const history = verifyHistory(b.db),
    before = state(b.db);
  assert.equal(b.db.prepare("SELECT COUNT(*) n FROM categories").get().n, 7);
  assert.equal(b.db.prepare("SELECT COUNT(*) n FROM budget_events").get().n, 0);
  b.close();
  const reopened = openBudget(dir);
  try {
    assert.deepEqual(verifyHistory(reopened.db), history);
    assert.deepEqual(state(reopened.db), before);
  } finally {
    reopened.close();
  }
});
for (const version of ["0.1.0", "P4", "0.2.0"]) {
  test(
    "migrations: preserve historical " +
      version +
      " data, history and credentials",
    (t) => {
      const { dir, db } = legacy(t, version),
        before = rows(db);
      db.close();
      const b = openBudget(dir);
      try {
        verifyHistory(b.db);
        const after = rows(b.db);
        for (const [table, data] of Object.entries(before)) {
          // New AUTOINCREMENT tables start empty; existing sequence counters must retain their values.
          if (table === "sqlite_sequence") {
            for (const old of data)
              assert.ok(
                after[table].some(
                  (r) => r.name === old.name && r.seq === old.seq,
                ),
              );
          } else assert.deepEqual(after[table], data, table);
        }
        assert.equal(b.snapshot("2026-10").accounts[0].balance, 975000);
        assert.throws(() => b.deleteTransaction(50), /conciliado/);
        assert.equal(
          b.db.prepare("SELECT COUNT(*) n FROM categories").get().n,
          8,
        );
        if (version === "0.1.0")
          assert.equal(
            b.db.prepare("SELECT COUNT(*) n FROM budget_events").get().n,
            0,
          );
        else assert.equal(b.eventSnapshot({ month: "2026-10" }).cursor, cursor);
        if (version === "0.2.0") {
          const agent = b.forAgent(token);
          assert.equal(agent.snapshot("2026-10").accounts[0].balance, 975000);
          assert.equal(
            agent.proposalStatus({ id: "pending-proposal" }).status,
            "pending",
          );
          assert.equal(
            b.resolveProposal({ id: "pending-proposal", decision: "accept" })
              .status,
            "accepted",
          );
          assert.equal(
            agent.proposalStatus({ id: "pending-proposal" }).status,
            "accepted",
          );
          assert.equal(
            b.db
              .prepare(
                "SELECT fingerprint FROM agent_requests WHERE request_id='saved-request'",
              )
              .get().fingerprint,
            "original-fingerprint",
          );
        }
      } finally {
        b.close();
      }
    },
  );
}
test("migrations: numbered prefix upgrades only pending migrations", (t) => {
  const dir = directory(t),
    b = openBudget(dir);
  b.db.exec(
    "ALTER TABLE agent_audit DROP COLUMN policy; DELETE FROM schema_migrations WHERE version=5; PRAGMA user_version=4;",
  );
  const history = b.db
    .prepare("SELECT * FROM schema_migrations ORDER BY version")
    .all();
  b.close();
  const next = openBudget(dir);
  try {
    assert.deepEqual(verifyHistory(next.db).slice(0, 4), history);
    assert.ok(
      next.db
        .prepare("PRAGMA table_info(agent_audit)")
        .all()
        .some((c) => c.name === "policy"),
    );
  } finally {
    next.close();
  }
});
test("migrations: late failure rolls back schema, history and version; retry succeeds", (t) => {
  const { dir, db } = legacy(t);
  db.exec(
    "CREATE TABLE agent_audit(sequence INTEGER PRIMARY KEY,at TEXT); INSERT INTO agent_audit VALUES (3,'original');",
  );
  const before = state(db);
  db.close();
  assert.throws(() => openBudget(dir), { code: "SCHEMA_INCOMPATIBLE" });
  const inspect = new Database(path.join(dir, "budget.db"));
  try {
    assert.deepEqual(state(inspect), before);
    inspect.exec(
      "ALTER TABLE agent_audit ADD COLUMN actor TEXT; ALTER TABLE agent_audit ADD COLUMN action TEXT; ALTER TABLE agent_audit ADD COLUMN args TEXT; ALTER TABLE agent_audit ADD COLUMN decision TEXT; ALTER TABLE agent_audit ADD COLUMN reason TEXT; ALTER TABLE agent_audit ADD COLUMN reviewer TEXT;",
    );
  } finally {
    inspect.close();
  }
  const retry = openBudget(dir);
  try {
    verifyHistory(retry.db);
    assert.equal(
      retry.db.prepare("SELECT at FROM agent_audit WHERE sequence=3").get().at,
      "original",
    );
  } finally {
    retry.close();
  }
});
test("migrations: future schemas and changed history are rejected without writes", (t) => {
  const dir = directory(t),
    b = openBudget(dir);
  b.createAccount({ name: "Preservar", type: "efectivo", balance: 10 });
  b.db.pragma("user_version=" + (schemaVersion + 1));
  let before = state(b.db);
  b.close();
  assert.throws(() => openBudget(dir), { code: "SCHEMA_TOO_NEW" });
  const db = new Database(path.join(dir, "budget.db"));
  assert.deepEqual(state(db), before);
  db.pragma("user_version=" + schemaVersion);
  db.exec("UPDATE schema_migrations SET checksum='changed' WHERE version=2");
  before = state(db);
  db.close();
  assert.throws(() => openBudget(dir), { code: "MIGRATION_HISTORY_MISMATCH" });
  const final = new Database(path.join(dir, "budget.db"));
  try {
    assert.deepEqual(state(final), before);
  } finally {
    final.close();
  }
});
test("migrations: unversioned nonempty databases are not adopted", (t) => {
  const dir = directory(t),
    db = new Database(path.join(dir, "budget.db"));
  db.exec(
    "CREATE TABLE private_data(value TEXT); INSERT INTO private_data VALUES ('preserve');",
  );
  const before = state(db);
  db.close();
  assert.throws(() => openBudget(dir), { code: "SCHEMA_INCOMPATIBLE" });
  const reopened = new Database(path.join(dir, "budget.db"));
  try {
    assert.deepEqual(state(reopened), before);
  } finally {
    reopened.close();
  }
});
test("migrations: never invent a new identity for an existing event history", (t) => {
  const { dir, db } = legacy(t, "P4");
  db.exec("DELETE FROM event_identity");
  const before = state(db);
  db.close();
  assert.throws(() => openBudget(dir), { code: "SCHEMA_INCOMPATIBLE" });
  const inspect = new Database(path.join(dir, "budget.db"));
  try {
    assert.deepEqual(state(inspect), before);
  } finally {
    inspect.close();
  }
});
test("migrations: concurrent processes adopt the same legacy budget once", async (t) => {
  const { dir, db } = legacy(t, "0.2.0");
  const before = rows(db);
  db.close();
  const script =
    "import {openBudget} from " +
    JSON.stringify(new URL("../src/core.js", import.meta.url).href) +
    "; const b=openBudget(process.argv[1]);b.close();";
  await Promise.all(
    [0, 1, 2].map(
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
  const b = openBudget(dir);
  try {
    verifyHistory(b.db);
    assert.deepEqual(rows(b.db), before);
  } finally {
    b.close();
  }
});
