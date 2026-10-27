import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const files = [
  "001-budget.sql",
  "002-planning.sql",
  "003-events.sql",
  "004-agent-access.sql",
  "005-audit-policy.sql",
  "006-reviews.sql",
];
export const schemaVersion = files.length;
const migrations = files.map((name, i) => {
  const sql = readFileSync(
    new URL("./migrations/" + name, import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  return {
    version: i + 1,
    name,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
  };
});
const fail = (code, message) => Object.assign(new Error(message), { code });
const exists = (db, name) =>
  !!db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
    .get(name);
const columns = (db, table) =>
  db
    .prepare("PRAGMA table_info(" + table + ")")
    .all()
    .map((c) => c.name);
const required = {
  reviews: "id,package_json,report,generated_by,generator,created_at,reviewed_at",
  accounts: "id,name,type",
  groups_: "id,name",
  categories: "id,group_id,name",
  allocations: "month,category_id,amount",
  transactions:
    "id,account_id,date,payee,amount,category_id,kind,cleared,reconciled,import_key,transfer_key",
  memory: "payee,category_id",
  mappings: "account_id,config",
  reconciliations: "id,account_id,date,balance",
  goals: "category_id,amount,due_date",
  recurring:
    "id,account_id,category_id,payee,amount,next_date,frequency,anchor_day,active",
  recurring_occurrences: "recurring_id,due_date,transaction_id",
  event_identity: "singleton,source",
  budget_events: "sequence,id,envelope",
  agent_connections: "id,label,version,token_hash,active,created_at",
  agent_rules:
    "connection_id,connection_version,action,action_version,decision,conditions",
  agent_audit: "sequence,at,actor,action,args,decision,reason,reviewer,policy",
  agent_requests: "actor,request_id,fingerprint,result",
  agent_proposals:
    "id,actor,connection_version,request_id,action,action_version,args,base,purpose,status,created_at,final_args,result,reason,resolved_at",
};
function validateSchema(db) {
  for (const [table, names] of Object.entries(required)) {
    const actual = columns(db, table);
    if (names.split(",").some((name) => !actual.includes(name)))
      throw fail(
        "SCHEMA_INCOMPATIBLE",
        "El esquema de " +
          table +
          " está incompleto. No se modificó el presupuesto.",
      );
  }
  if (
    !db.prepare("SELECT source FROM event_identity WHERE singleton=1").get()
      ?.source
  )
    throw fail(
      "SCHEMA_INCOMPATIBLE",
      "Falta la identidad del historial de eventos.",
    );
}
function checkVersion(version) {
  if (version > schemaVersion)
    throw fail(
      "SCHEMA_TOO_NEW",
      "Esta base requiere una versión más nueva de Nemein. No se modificó el presupuesto.",
    );
}

// The legacy releases all report user_version=1, despite having different optional tables.
export function migrate(db) {
  checkVersion(db.pragma("user_version", { simple: true }));
  db.transaction(() => {
    const version = db.pragma("user_version", { simple: true });
    checkVersion(version);
    const numbered = exists(db, "schema_migrations");
    let applied = [];
    if (numbered) {
      applied = db
        .prepare(
          "SELECT version,name,checksum FROM schema_migrations ORDER BY version",
        )
        .all();
      if (
        applied.length !== version ||
        applied.some((row, i) => {
          const expected = migrations[i];
          return (
            !expected ||
            row.version !== expected.version ||
            row.name !== expected.name ||
            row.checksum !== expected.checksum
          );
        })
      )
        throw fail(
          "MIGRATION_HISTORY_MISMATCH",
          "El registro de migraciones no coincide con esta versión de Nemein.",
        );
    } else {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      if ((version === 0 && tables.length) || ![0, 1].includes(version))
        throw fail(
          "SCHEMA_INCOMPATIBLE",
          "La base no corresponde a un esquema anterior reconocido de Nemein.",
        );
    }
    const legacy = !numbered && version === 1;
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)",
    );
    const record = db.prepare("INSERT INTO schema_migrations VALUES (?,?,?,?)");
    for (const migration of migrations.slice(applied.length)) {
      if (
        !(migration.version === 1 && legacy) &&
        !(
          migration.version === 5 &&
          columns(db, "agent_audit").includes("policy")
        )
      ) {
        db.exec(migration.sql);
      }
      if (migration.version === 3) {
        const identity = db
          .prepare("SELECT source FROM event_identity WHERE singleton=1")
          .get();
        if (!identity) {
          if (db.prepare("SELECT 1 FROM budget_events LIMIT 1").get())
            throw fail(
              "SCHEMA_INCOMPATIBLE",
              "El historial existente perdió su identidad; se requiere recuperar la base.",
            );
          db.prepare("INSERT INTO event_identity VALUES (1,?)").run(
            "urn:uuid:" + randomUUID(),
          );
        }
      }
      record.run(
        migration.version,
        migration.name,
        migration.checksum,
        new Date().toISOString(),
      );
    }
    validateSchema(db);
    db.pragma("user_version = " + schemaVersion);
  }).immediate();
}
