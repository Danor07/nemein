// Upgrade smoke for an ephemeral GitHub Windows runner, in two phases:
//   seed   <install> <data> <state>: fictitious data written by the installed old runtime;
//   verify <install> <data> <state>: the installed new runtime migrates it and keeps every row.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const [phase, installRoot, dataDir, stateFile] = process.argv.slice(2);
if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "win32")
  throw Error("The upgrade smoke runs only on an ephemeral GitHub Windows runner.");
if (!["seed", "verify"].includes(phase) || !installRoot || !dataDir || !stateFile)
  throw Error("Usage: smoke-upgrade.mjs seed|verify <install> <data> <state>");
const runtime = path.join(path.resolve(installRoot), "runtime", "src");
const { openBudget } = await import(pathToFileURL(path.join(runtime, "core.js")));

const tables = (db) =>
  Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY name",
      )
      .all()
      .map(({ name }) => [
        name,
        db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      ]),
  );
const migrations = (db) =>
  db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
const connectorActions = ["connectors", "connector-prepare", "connector-import"];

const b = openBudget(dataDir);
try {
  if (phase === "seed") {
    const bank = b.createAccount({ name: "Banco ficticio", type: "corriente", balance: 1000000, date: "2026-01-01" }),
      card = b.createAccount({ name: "Tarjeta ficticia", type: "credito", balance: -200000, date: "2026-01-01" });
    b.allocate({ month: "2026-01", category_id: 1, amount: 300000 });
    b.addTransaction({ account_id: bank, date: "2026-01-02", payee: "Mercado ficticio", amount: -80000, category_id: 1 });
    b.transfer({ from: bank, to: card, date: "2026-01-03", amount: 50000 });
    const connection = b.createConnection({ label: "Upgrade CI fixture" });
    b.setRule({ connection_id: connection.id, action: "snapshot", decision: "allow", conditions: {} });
    b.setRule({ connection_id: connection.id, action: "transaction", decision: "ask", conditions: {} });
    const agent = b.forAgent(connection.token),
      { actions } = agent.permissions();
    assert.equal(actions.snapshot.decision, "allow");
    for (const action of connectorActions) assert.equal(actions[action], undefined);
    // Agent reads write audit rows: take the agent's view before the table copy.
    const snapshot = agent.snapshot("2026-01");
    writeFileSync(
      stateFile,
      JSON.stringify({ token: connection.token, tables: tables(b.db), migrations: migrations(b.db), snapshot }),
    );
    console.log(`SEEDED schema ${migrations(b.db).length}`);
  } else {
    const before = JSON.parse(readFileSync(stateFile, "utf8")),
      after = tables(b.db),
      applied = migrations(b.db);
    assert.deepEqual(applied.slice(0, before.migrations.length), before.migrations, "published migrations changed");
    assert.equal(applied.length, 7);
    assert.equal(applied[6].name, "007-connector-batches.sql");
    for (const [name, rows] of Object.entries(before.tables))
      assert.deepEqual(after[name], rows, `table ${name} changed during the upgrade`);
    assert.deepEqual(after.connector_batches, []);
    const agent = b.forAgent(before.token),
      permissions = agent.permissions().actions;
    assert.equal(permissions.snapshot.decision, "allow");
    assert.equal(permissions.transaction.decision, "ask");
    for (const action of connectorActions) assert.equal(permissions[action].decision, "deny", `${action} must start denied`);
    assert.deepEqual(agent.snapshot("2026-01"), before.snapshot);
    console.log(`UPGRADE OK: schema ${before.migrations.length} -> ${applied.length}, ${Object.keys(before.tables).length} tables unchanged, connection and rules kept, connector actions denied.`);
  }
} finally {
  b.close();
}
