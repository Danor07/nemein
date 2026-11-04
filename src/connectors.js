import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { LIMITS, runConnector, validateManifest } from "./connector-runner.js";
import { validateImportBatch } from "./import-contract.js";

// Installed connectors, their enablement and the batches they prepare
// (docs/conectores.md, "Flujo y administración"). Artifacts and enablement
// live in <data>/connectors/, outside SQLite, so restoring a backup never
// revives an enablement; prepared batches live in SQLite (connector_batches).
// This module never decides money or categories: the budget's import domain
// projects, validates and inserts.

export const CONNECTOR_LIMITS = Object.freeze({
  // A prepared batch waits for review, also as a proposal.
  batchTtlMs: 24 * 60 * 60 * 1000,
  pendingPerActor: 4,
  pendingBytes: 64 * 1024 * 1024,
  // Confirmed batches keep only their result, for retries.
  confirmedTtlMs: 30 * 24 * 60 * 60 * 1000,
});

const HASH = /^[0-9a-f]{64}$/;
const fail = (code, message) => Object.assign(new Error(message), { code });
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

// Keys sorted at every level, so equal batches hash equally.
export function canonicalJson(value) {
  const sort = (v) =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort(v[k])]),
          )
        : v;
  return JSON.stringify(sort(value));
}

// Only the canonical base64 of some bytes, within a decoded size limit:
// Node's decoder skips junk and padding bits, so the text must re-encode to
// itself.
export function decodeBase64(text, limit, what) {
  if (typeof text !== "string" || text.length > Math.ceil(limit / 3) * 4)
    throw fail("CONNECTOR_REQUEST_INVALID", `${what} supera su límite.`);
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text)
    throw fail("CONNECTOR_REQUEST_INVALID", `${what} no es base64 válido.`);
  if (bytes.length > limit)
    throw fail("CONNECTOR_REQUEST_INVALID", `${what} supera su límite.`);
  return bytes;
}

const isHash = (value) => typeof value === "string" && HASH.test(value);
const isTime = (value) =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

// The inventory as stored; anything else fails closed.
export function validateInventory(inventory) {
  const invalid = () =>
    fail(
      "CONNECTOR_INVENTORY_INVALID",
      "El inventario de conectores está dañado. No se ejecuta ningún conector.",
    );
  if (
    !inventory ||
    inventory.version !== 1 ||
    typeof inventory.source !== "string" ||
    !Array.isArray(inventory.connectors)
  )
    throw invalid();
  const seen = new Set();
  for (const entry of inventory.connectors) {
    if (
      !entry ||
      !isHash(entry.hash) ||
      seen.has(entry.hash) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      entry.size > LIMITS.component ||
      !isTime(entry.installed_at)
    )
      throw invalid();
    seen.add(entry.hash);
    try {
      validateManifest(entry.manifest);
    } catch {
      throw invalid();
    }
    const enablement = entry.enablement;
    if (
      enablement !== null &&
      (!enablement ||
        !isHash(enablement.token) ||
        !Number.isSafeInteger(enablement.audit) ||
        enablement.audit < 1 ||
        !isTime(enablement.at))
    )
      throw invalid();
  }
  return inventory;
}

// An enablement counts only when this budget recorded it: the inventory
// belongs to this budget, the owner's audit row with that token exists, and
// no later revocation of the same connector does. A restored backup lacks
// the row, or has a different one at that sequence.
export function enablementHolds(
  entry,
  { inventorySource, source, enabled, revokedAfter },
) {
  const enablement = entry.enablement;
  if (!enablement || inventorySource !== source || revokedAfter) return false;
  if (
    !enabled ||
    enabled.actor !== "owner" ||
    enabled.action !== "connector-enable" ||
    enabled.decision !== "allow"
  )
    return false;
  let args;
  try {
    args = JSON.parse(enabled.args);
  } catch {
    return false;
  }
  return args?.hash === entry.hash && args?.token === enablement.token;
}

export function connectorStore(dir, db) {
  const root = path.join(dir, "connectors");
  const inventoryFile = path.join(root, "inventory.json");
  const source = () =>
    db.prepare("SELECT source FROM event_identity WHERE singleton=1").get()
      .source;
  const write = (file, bytes) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, file);
  };
  function read() {
    if (!existsSync(inventoryFile))
      return { version: 1, source: source(), connectors: [] };
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(inventoryFile, "utf8"));
    } catch {
      parsed = null;
    }
    return validateInventory(parsed);
  }
  // Writing rebinds the inventory to this budget. Enablements recorded for
  // another budget never held here, and are dropped explicitly.
  function save(inventory) {
    const current = source();
    const next =
      inventory.source === current
        ? inventory
        : {
            ...inventory,
            source: current,
            connectors: inventory.connectors.map((entry) => ({
              ...entry,
              enablement: null,
            })),
          };
    write(inventoryFile, JSON.stringify(validateInventory(next), null, 2));
  }
  const artifactFile = (hash) => path.join(root, hash, "component.wasm");
  function holds(inventory, entry) {
    const enabled = entry.enablement
      ? db
          .prepare(
            "SELECT actor,action,args,decision FROM agent_audit WHERE sequence=?",
          )
          .get(entry.enablement.audit)
      : undefined;
    const revokedAfter = entry.enablement
      ? db
          .prepare(
            "SELECT args FROM agent_audit WHERE action='connector-revoke' AND actor='owner' AND decision='allow' AND sequence>?",
          )
          .all(entry.enablement.audit)
          .some((row) => {
            try {
              return JSON.parse(row.args).hash === entry.hash;
            } catch {
              return false;
            }
          })
      : false;
    return enablementHolds(entry, {
      inventorySource: inventory.source,
      source: source(),
      enabled,
      revokedAfter,
    });
  }
  function find(hash) {
    if (!isHash(hash))
      throw fail(
        "CONNECTOR_REQUEST_INVALID",
        "El conector no es un hash válido.",
      );
    const inventory = read();
    const entry = inventory.connectors.find((c) => c.hash === hash);
    if (!entry)
      throw fail("CONNECTOR_UNKNOWN", "El conector no está instalado.");
    return { inventory, entry };
  }
  // The bytes the worker gets, checked against the hash the owner approved.
  function artifact(entry) {
    let bytes;
    try {
      bytes = readFileSync(artifactFile(entry.hash));
    } catch {
      throw fail(
        "CONNECTOR_ARTIFACT_CHANGED",
        "Falta el componente aprobado. Reinstalalo.",
      );
    }
    if (bytes.length !== entry.size || sha256(bytes) !== entry.hash)
      throw fail(
        "CONNECTOR_ARTIFACT_CHANGED",
        "El componente cambió después de aprobarlo. Reinstalalo.",
      );
    return bytes;
  }
  // The enabled connector and its approved bytes, or a refusal.
  function usable(hash) {
    const { inventory, entry } = find(hash);
    if (!holds(inventory, entry))
      throw fail("CONNECTOR_DISABLED", "El conector no está habilitado.");
    return { entry, bytes: artifact(entry) };
  }
  const summary = (inventory, entry) => ({
    hash: entry.hash,
    manifest: entry.manifest,
    size: entry.size,
    installed_at: entry.installed_at,
    enabled: holds(inventory, entry),
    // Recorded as enabled, but not by this budget's current history.
    invalidated: !!entry.enablement && !holds(inventory, entry),
  });
  return {
    root,
    list() {
      const inventory = read();
      return inventory.connectors.map((entry) => summary(inventory, entry));
    },
    find,
    usable,
    artifact,
    // Stores the component under its hash and lists it disabled.
    install(bytes, manifest, now) {
      const hash = sha256(bytes);
      const inventory = read();
      const known = inventory.connectors.find((c) => c.hash === hash);
      if (
        !existsSync(artifactFile(hash)) ||
        sha256(readFileSync(artifactFile(hash))) !== hash
      )
        write(artifactFile(hash), bytes);
      if (known) return summary(inventory, known);
      const entry = {
        hash,
        manifest: validateManifest(manifest),
        size: bytes.length,
        installed_at: now.toISOString(),
        enablement: null,
      };
      save({ ...inventory, connectors: [...inventory.connectors, entry] });
      return summary(read(), entry);
    },
    newToken: () => randomBytes(32).toString("hex"),
    enable(hash, token, audit, now) {
      const { inventory, entry } = find(hash);
      artifact(entry);
      save({
        ...inventory,
        connectors: inventory.connectors.map((c) =>
          c.hash === hash
            ? { ...c, enablement: { token, audit, at: now.toISOString() } }
            : c,
        ),
      });
    },
    revoke(hash) {
      const { inventory } = find(hash);
      save({
        ...inventory,
        connectors: inventory.connectors.map((c) =>
          c.hash === hash ? { ...c, enablement: null } : c,
        ),
      });
    },
  };
}

// Prepare and confirm, attached to the budget. `domain` is the budget's import
// domain: project(batch, cfg) fixes categories and duplicates; insert(account,
// rows) writes; account(id) and category(id) validate.
export function connectorImports(budget, domain, options = {}) {
  const db = budget.db;
  const store = connectorStore(budget.dir, db);
  const run = options.runConnector ?? runConnector;
  const now = options.now ?? (() => new Date());
  const actor = () => budget.reviewAuthor?.() ?? "owner";
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const purge = (at) => {
    db.prepare(
      "DELETE FROM connector_batches WHERE confirmed_at IS NULL AND expires_at<=?",
    ).run(at.toISOString());
    db.prepare(
      "DELETE FROM connector_batches WHERE confirmed_at IS NOT NULL AND confirmed_at<=?",
    ).run(
      new Date(at.getTime() - CONNECTOR_LIMITS.confirmedTtlMs).toISOString(),
    );
  };

  async function prepareConnectorImport(p = {}) {
    const account = domain.account(p.account_id).id;
    const config = p.config ?? "";
    if (typeof config !== "string" || Buffer.byteLength(config) > LIMITS.config)
      throw fail(
        "CONNECTOR_REQUEST_INVALID",
        "La configuración supera su límite.",
      );
    const input = decodeBase64(p.content_base64, LIMITS.input, "El archivo");
    const category =
      p.category_id === undefined || p.category_id === null
        ? undefined
        : domain.category(p.category_id);
    const { entry, bytes } = store.usable(p.hash);
    const who = actor();
    // Third-party code runs here, outside every transaction.
    const { batch } = await run({
      op: "parse",
      component: bytes,
      input,
      config,
      accountId: String(account),
      expectedManifest: entry.manifest,
    });
    // Revoked or changed while it ran: nothing is kept.
    store.usable(p.hash);
    // The runner already checked these; this module does not rely on it.
    validateImportBatch(batch);
    if (batch.account_id !== account)
      throw fail("CONNECTOR_ACCOUNT_MISMATCH", "El lote declara otra cuenta.");
    const rows = domain.project(batch, { category_id: category });
    const stored = {
      ...batch,
      entries: rows.map((row) => ({
        id: row.import_key,
        date: row.date,
        payee: row.payee,
        amount: row.amount,
        category_id: row.category_id,
      })),
    };
    validateImportBatch(stored);
    const text = canonicalJson(stored);
    const batchHash = sha256(text);
    const at = now();
    const id = randomUUID();
    const expires = new Date(at.getTime() + CONNECTOR_LIMITS.batchTtlMs);
    db.transaction(() => {
      purge(at);
      const pending = one(
        "SELECT COUNT(*) n, COALESCE(SUM(LENGTH(batch)),0) bytes FROM connector_batches WHERE confirmed_at IS NULL",
      );
      const mine = one(
        "SELECT COUNT(*) n FROM connector_batches WHERE confirmed_at IS NULL AND actor=?",
        who,
      ).n;
      if (
        mine >= CONNECTOR_LIMITS.pendingPerActor ||
        pending.bytes + Buffer.byteLength(text) > CONNECTOR_LIMITS.pendingBytes
      )
        throw fail(
          "CONNECTOR_BATCH_LIMIT",
          "Hay demasiados lotes sin confirmar. Confirmalos o esperá a que venzan.",
        );
      db.prepare(
        "INSERT INTO connector_batches(id,actor,component_hash,input_hash,config,account_id,batch,batch_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        who,
        entry.hash,
        sha256(input),
        config,
        account,
        text,
        batchHash,
        at.toISOString(),
        expires.toISOString(),
      );
    }).immediate();
    return {
      id,
      batch_sha256: batchHash,
      expires_at: expires.toISOString(),
      connector: { hash: entry.hash, manifest: entry.manifest },
      account_id: account,
      rows,
    };
  }

  // Confirms the stored batch, never rows from the caller, in one short
  // transaction: the reviewed hash, the actor, the expiry, the connector's
  // enablement and bytes, the batch contract and categories, and duplicates
  // are all checked again. A retry returns the stored result.
  function confirmConnectorImport(p = {}) {
    const unknown = () =>
      fail("CONNECTOR_BATCH_UNKNOWN", "El lote no existe o no es tuyo.");
    if (typeof p.id !== "string" || p.id.length > 64) throw unknown();
    if (!isHash(p.batch_sha256))
      throw fail(
        "CONNECTOR_REQUEST_INVALID",
        "Falta el hash del lote revisado.",
      );
    const row = one("SELECT * FROM connector_batches WHERE id=?", p.id);
    if (!row || row.actor !== actor()) throw unknown();
    if (row.batch_hash !== p.batch_sha256)
      throw fail(
        "CONNECTOR_BATCH_MISMATCH",
        "El lote confirmado no es el que se revisó.",
      );
    if (row.confirmed_at) return JSON.parse(row.result);
    if (Date.parse(row.expires_at) <= now().getTime())
      throw fail(
        "CONNECTOR_BATCH_EXPIRED",
        "El lote venció. Prepará uno nuevo desde el archivo.",
      );
    if (sha256(row.batch) !== row.batch_hash)
      throw fail(
        "CONNECTOR_BATCH_MISMATCH",
        "El lote guardado no coincide con el revisado.",
      );
    store.usable(row.component_hash);
    const batch = validateImportBatch(JSON.parse(row.batch));
    if (batch.account_id !== row.account_id)
      throw fail("CONNECTOR_ACCOUNT_MISMATCH", "El lote declara otra cuenta.");
    domain.account(row.account_id);
    for (const e of batch.entries)
      if (e.category_id !== null) domain.category(e.category_id);
    const result = domain.insert(
      row.account_id,
      batch.entries.map((e) => ({
        date: e.date,
        payee: e.payee,
        amount: e.amount,
        category_id: e.category_id,
        import_key: e.id,
      })),
    );
    db.prepare(
      "UPDATE connector_batches SET confirmed_at=?,result=?,batch=NULL WHERE id=?",
    ).run(now().toISOString(), JSON.stringify(result), row.id);
    return result;
  }

  // Owner operations, unguarded here: access.js wraps them with the owner
  // guard and audits them.
  async function installConnector(p = {}) {
    const bytes = decodeBase64(
      p.component_base64,
      LIMITS.component,
      "El componente",
    );
    // describe runs the connector's code too: enclosed, outside transactions.
    const { manifest } = await run({
      op: "describe",
      component: bytes,
      accountId: "1",
    });
    return store.install(bytes, manifest, now());
  }
  // `record(args)` audits the enablement and returns its audit sequence.
  function enableConnector(p = {}, record) {
    const { entry } = store.find(p.hash);
    store.artifact(entry);
    const token = store.newToken();
    store.enable(entry.hash, token, record({ hash: entry.hash, token }), now());
    return { hash: entry.hash, enabled: true };
  }
  function revokeConnector(p = {}) {
    const { entry } = store.find(p.hash);
    store.revoke(entry.hash);
    return { hash: entry.hash, enabled: false };
  }

  return {
    store,
    methods: {
      listConnectors: () => store.list(),
      prepareConnectorImport,
      confirmConnectorImport,
      installConnector,
      enableConnector,
      revokeConnector,
    },
  };
}
