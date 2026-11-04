import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBudget } from "../../src/core.js";
import { proposalFile } from "../../src/commands.js";
import { actions } from "../../src/actions.js";

// Portable oracle for ADR-0003: each scenario drives the real engine step by step and
// records what it did. Values that change between runs (UUIDs, tokens, cursors, clock
// times) are replaced by stable aliases so another implementation can compare outcomes.

const cash = { account_id: "$cash", date: "2026-10-24", payee: "Fixture", category_id: 1 };
const spend = (amount, extra = {}) => ({ ...cash, amount, ...extra });
const foreignBase = Buffer.from(
  JSON.stringify({ version: 1, source: "00000000-0000-4000-8000-000000000000", sequence: 0, id: null }),
).toString("base64url");

export const scenarios = [
  {
    name: "authentication",
    description: "No rule denies; bad, revoked, rotated and outdated credentials fail before any rule is read.",
    steps: [
      { op: "connect", as: "agent" },
      { op: "request", conn: "agent", action: "overview", args: { month: "2026-10" } },
      { op: "request", conn: "agent", token: "invalid", action: "overview", args: { month: "2026-10" } },
      { op: "rule", conn: "agent", action: "overview", decision: "allow" },
      { op: "request", conn: "agent", action: "overview", args: { month: "2026-10" } },
      { op: "rotate", conn: "agent" },
      { op: "request", conn: "agent", token: "previous", action: "overview", args: { month: "2026-10" } },
      { op: "request", conn: "agent", action: "overview", args: { month: "2026-10" } },
      { op: "version", conn: "agent", version: "2" },
      { op: "request", conn: "agent", version: "1", action: "overview", args: { month: "2026-10" } },
      { op: "request", conn: "agent", action: "overview", args: { month: "2026-10" } },
      { op: "rule", conn: "agent", action: "overview", decision: "allow" },
      { op: "request", conn: "agent", action: "overview", args: { month: "2026-10" } },
      { op: "revoke", conn: "agent" },
      { op: "request", conn: "agent", action: "overview", args: { month: "2026-10" } },
    ],
  },
  {
    name: "idempotency",
    description: "A request_id replays its stored result, rejects other input, and never outranks a deny.",
    steps: [
      { op: "account", as: "cash" },
      { op: "connect", as: "agent" },
      { op: "rule", conn: "agent", action: "transaction", decision: "allow" },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { request_id: "r1" } },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { request_id: "r1" } },
      { op: "request", conn: "agent", action: "transaction", args: spend(-6), meta: { request_id: "r1" } },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { request_id: "bad id!" } },
      { op: "rule", conn: "agent", action: "transaction", decision: "deny" },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { request_id: "r1" } },
      { op: "request", conn: "agent", action: "transaction", args: spend(-7), meta: { request_id: "r2" } },
      { op: "rule", conn: "agent", action: "transaction", decision: "allow" },
      { op: "request", conn: "agent", action: "transaction", args: spend(-7), meta: { request_id: "r2" } },
    ],
  },
  {
    name: "proposals",
    description: "Ask stores a proposal without writing; the owner accepts, modifies or rejects it once.",
    steps: [
      { op: "account", as: "cash" },
      { op: "connect", as: "agent" },
      { op: "connect", as: "other" },
      { op: "rule", conn: "agent", action: "transaction", decision: "ask" },
      { op: "base", as: "b1" },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { request_id: "p1" } },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { request_id: "p1", purpose: "Gasto" } },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { request_id: "p1", purpose: "Gasto", base: "$b1" }, as: "accept-me" },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { request_id: "p1", purpose: "Gasto", base: "$b1" } },
      { op: "status", conn: "agent", proposal: "accept-me" },
      { op: "status", conn: "other", proposal: "accept-me" },
      { op: "resolve", proposal: "accept-me", decision: "accept" },
      { op: "status", conn: "agent", proposal: "accept-me" },
      { op: "resolve", proposal: "accept-me", decision: "accept" },
      { op: "base", as: "b2" },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { purpose: "Gasto", base: "$b2" }, as: "modify-me" },
      { op: "resolve", proposal: "modify-me", decision: "modify", args: spend(-3) },
      { op: "resolve", proposal: "modify-me", decision: "modify", args: spend(-3), reason: "Importe corregido" },
      { op: "status", conn: "agent", proposal: "modify-me" },
      { op: "base", as: "b3" },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { purpose: "Gasto", base: "$b3" }, as: "reject-me" },
      { op: "resolve", proposal: "reject-me", decision: "reject" },
      { op: "resolve", proposal: "reject-me", decision: "reject", reason: "No corresponde" },
      { op: "status", conn: "agent", proposal: "reject-me" },
    ],
  },
  {
    name: "base",
    description: "A proposal is applied only on the state it saw; conditional writes check the base under the write lock.",
    steps: [
      { op: "account", as: "cash" },
      { op: "connect", as: "agent" },
      { op: "rule", conn: "agent", action: "transaction", decision: "ask" },
      { op: "base", as: "seen" },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { purpose: "Gasto", base: "$seen" }, as: "stale" },
      { op: "owner", method: "allocate", args: { month: "2026-10", category_id: 1, amount: 10 } },
      { op: "status", conn: "agent", proposal: "stale" },
      { op: "resolve", proposal: "stale", decision: "accept" },
      { op: "status", conn: "agent", proposal: "stale" },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { purpose: "Gasto", base: foreignBase } },
      { op: "rule", conn: "agent", action: "transaction", decision: "allow" },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { requireBase: true } },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { requireBase: true, base: "$seen" } },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { requireBase: true, base: foreignBase } },
      { op: "base", as: "now" },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { requireBase: true, base: "$now" } },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { requireBase: true, base: "$now" } },
    ],
  },
  {
    name: "revocation",
    description: "Permissions are re-read on every request, on acceptance and on reading an answered proposal.",
    steps: [
      { op: "account", as: "cash" },
      { op: "connect", as: "agent" },
      { op: "rule", conn: "agent", action: "transaction", decision: "ask" },
      { op: "base", as: "b1" },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { purpose: "Gasto", base: "$b1" }, as: "withdrawn" },
      { op: "rule", conn: "agent", action: "transaction", decision: "deny" },
      { op: "resolve", proposal: "withdrawn", decision: "accept" },
      { op: "rule", conn: "agent", action: "transaction", decision: "ask" },
      { op: "resolve", proposal: "withdrawn", decision: "accept" },
      { op: "status", conn: "agent", proposal: "withdrawn" },
      { op: "rule", conn: "agent", action: "transaction", decision: "deny" },
      { op: "status", conn: "agent", proposal: "withdrawn" },
      { op: "rule", conn: "agent", action: "transaction", decision: "ask" },
      { op: "base", as: "b2" },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5), meta: { purpose: "Gasto", base: "$b2" }, as: "revoked" },
      { op: "revoke", conn: "agent" },
      { op: "resolve", proposal: "revoked", decision: "accept" },
      { op: "connect", as: "versioned" },
      { op: "rule", conn: "versioned", action: "transaction", decision: "ask" },
      { op: "base", as: "b3" },
      { op: "request", conn: "versioned", action: "transaction", args: spend(-5), meta: { purpose: "Gasto", base: "$b3" }, as: "old-version" },
      { op: "version", conn: "versioned", version: "2" },
      { op: "status", conn: "versioned", proposal: "old-version" },
      { op: "resolve", proposal: "old-version", decision: "accept" },
    ],
  },
  {
    name: "conditions",
    description: "Amount and account limits fall back to ask or deny; actions without that field reject the rule.",
    steps: [
      { op: "account", as: "cash" },
      { op: "account", as: "bank" },
      { op: "connect", as: "agent" },
      { op: "rule", conn: "agent", action: "transaction", decision: "allow", conditions: { max_amount: 100, otherwise: "ask" } },
      { op: "request", conn: "agent", action: "transaction", args: spend(-100) },
      { op: "base", as: "b1" },
      { op: "request", conn: "agent", action: "transaction", args: spend(-101), meta: { purpose: "Gasto grande", base: "$b1" } },
      { op: "rule", conn: "agent", action: "transaction", decision: "allow", conditions: { account_id: "$cash" } },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5) },
      { op: "request", conn: "agent", action: "transaction", args: spend(-5, { account_id: "$bank" }) },
      { op: "rule", conn: "agent", action: "overview", decision: "allow", conditions: { max_amount: 1 } },
      { op: "rule", conn: "agent", action: "transaction", decision: "allow", conditions: { otherwise: "allow" } },
    ],
  },
  {
    name: "offline-and-async",
    description: "Delivered envelopes never apply by themselves; asynchronous backups never wait for approval.",
    steps: [
      { op: "account", as: "cash" },
      { op: "connect", as: "agent" },
      { op: "rule", conn: "agent", action: "transaction", decision: "allow" },
      { op: "base", as: "b1" },
      { op: "envelope", conn: "agent", action: "transaction", args: spend(-5), base: "$b1", purpose: "Gasto sin conexión", request_id: "e1", as: "delivered" },
      { op: "status", conn: "agent", proposal: "delivered" },
      { op: "envelope", conn: "agent", action: "transaction", args: spend(-5), purpose: "Sin base", request_id: "e2" },
      { op: "rule", conn: "agent", action: "backup", decision: "ask" },
      { op: "rule", conn: "agent", action: "backup", decision: "allow" },
      { op: "rule", conn: "agent", action: "backup", decision: "allow", conditions: { otherwise: "ask" } },
      { op: "envelope", conn: "agent", action: "backup", args: {}, purpose: "Respaldo", request_id: "e3" },
      { op: "request", conn: "agent", action: "backup", args: {}, meta: { purpose: "Respaldo", forceProposal: true } },
    ],
  },
  {
    name: "restoration",
    description: "Restoring a copy restores the connections, rules and revocations stored in it.",
    steps: [
      { op: "connect", as: "agent" },
      { op: "rule", conn: "agent", action: "overview", decision: "allow" },
      { op: "copy", as: "before" },
      { op: "rotate", conn: "agent" },
      { op: "revoke", conn: "agent" },
      { op: "request", conn: "agent", action: "overview", args: { month: "2026-10" } },
      { op: "restore", from: "before" },
      { op: "request", conn: "agent", action: "overview", args: { month: "2026-10" } },
      { op: "request", conn: "agent", token: "previous", action: "overview", args: { month: "2026-10" } },
    ],
  },
];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export async function runScenario({ name, description, steps }) {
  const dirs = [];
  const open = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-scenario-"));
    dirs.push(dir);
    return { dir, b: openBudget(dir) };
  };
  let { dir, b } = open();
  const refs = {},
    conns = {},
    aliases = new Map();
  let lastAudit = 0;
  const alias = (value, label) => {
    if (!aliases.has(value)) aliases.set(value, label);
    return aliases.get(value);
  };
  const resolve = (value) =>
    typeof value === "string" && value.startsWith("$")
      ? refs[value.slice(1)]
      : Array.isArray(value)
        ? value.map(resolve)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]))
          : value;
  const normalize = (value) => {
    if (typeof value === "string") {
      if (aliases.has(value)) return aliases.get(value);
      if (uuid.test(value)) return alias(value, "uuid#" + aliases.size);
      if (isoTime.test(value)) return "<time>";
      return value;
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
    return value;
  };
  const audit = () => {
    const rows = b.db
      .prepare("SELECT sequence,actor,action,decision FROM agent_audit WHERE sequence>? ORDER BY sequence")
      .all(lastAudit);
    if (rows.length) lastAudit = rows.at(-1).sequence;
    return rows.map(({ actor, action, decision }) => ({ actor: normalize(actor), action, decision }));
  };
  const token = (step) => {
    const c = conns[step.conn];
    return step.token === "invalid" ? "0".repeat(64) : step.token === "previous" ? c.previous : c.token;
  };
  const agent = (step) => b.forAgent(token(step), step.version ?? conns[step.conn].version);
  const perform = {
    connect: (s) => {
      const c = b.createConnection({ label: s.as });
      conns[s.as] = { id: c.id, token: c.token, version: c.version };
      alias(c.id, s.as);
    },
    account: (s) => {
      refs[s.as] = b.createAccount({ name: s.as, type: "efectivo" });
    },
    rule: (s) =>
      b.setRule({
        connection_id: conns[s.conn].id,
        action: s.action,
        decision: s.decision,
        conditions: resolve(s.conditions || {}),
      }),
    rotate: (s) => {
      const c = conns[s.conn];
      c.previous = c.token;
      c.token = b.rotateConnection(c.id).token;
    },
    revoke: (s) => b.revokeConnection(conns[s.conn].id),
    version: (s) => {
      b.changeConnectionVersion({ id: conns[s.conn].id, version: s.version });
      conns[s.conn].version = s.version;
    },
    owner: (s) => b[s.method](resolve(s.args)),
    base: (s) => {
      refs[s.as] = b.eventSnapshot().cursor;
      alias(refs[s.as], "$" + s.as);
    },
    // A read's payload is domain data, not a permission outcome.
    request: (s) => {
      const value = agent(s).request(s.action, resolve(s.args), resolve(s.meta || {}));
      return actions[s.action].write || value?.status === "pending" ? value : "<read>";
    },
    status: (s) => agent(s).proposalStatus({ id: refs[s.proposal] }),
    resolve: (s) =>
      b.resolveProposal({
        id: refs[s.proposal],
        decision: s.decision,
        ...(s.args ? { args: resolve(s.args) } : {}),
        ...(s.reason ? { reason: s.reason } : {}),
      }),
    envelope: (s) =>
      agent(s).submitProposal(
        proposalFile(
          resolve({ action: s.action, args: s.args, base: s.base, purpose: s.purpose, request_id: s.request_id }),
        ),
      ),
    copy: async (s) => {
      refs[s.as] = path.join(dir, s.as + ".db");
      await b.db.backup(refs[s.as]);
    },
    restore: (s) => {
      b.close();
      ({ dir, b } = open());
      b.close();
      copyFileSync(refs[s.from], path.join(dir, "budget.db"));
      b = openBudget(dir);
      lastAudit = b.db.prepare("SELECT COALESCE(MAX(sequence),0) n FROM agent_audit").get().n;
    },
  };
  const recorded = [];
  try {
    for (const step of steps) {
      if (step.op === "base") {
        perform.base(step);
        audit(); // The owner's own snapshot read is how the base was obtained, not a step outcome.
        recorded.push({ step });
        continue;
      }
      let outcome;
      try {
        const value = await perform[step.op](step);
        outcome = { outcome: "ok", ...(value === undefined ? {} : { result: normalize(value) }) };
        if (step.as && value?.proposal_id) {
          refs[step.as] = value.proposal_id;
          outcome.result = normalize(value);
          alias(value.proposal_id, step.as);
          outcome.result.proposal_id = step.as;
        }
      } catch (e) {
        outcome = { outcome: "error", code: e.code ?? null };
      }
      recorded.push({
        step,
        ...outcome,
        audit: audit(),
        transactions: b.db.prepare("SELECT COUNT(*) n FROM transactions").get().n,
      });
    }
  } finally {
    if (b.db.open) b.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
  return { name, description, steps: recorded };
}
