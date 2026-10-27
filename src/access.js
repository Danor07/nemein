import {decide,evaluatePolicy} from "./policy.js";
export {decide,evaluatePolicy} from "./policy.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { actions, actionVersion, callArgs, payload } from "./actions.js";
import { reviewedReadContext, decodeCursor } from "./event-reads.js";

const context = new AsyncLocalStorage();
const hash = (text) => createHash("sha256").update(text).digest("hex");
const error = (code, message) => Object.assign(new Error(message), { code });
function json(value) {
  const serialized = JSON.stringify(value ?? null, (_key, v) => {
    if (typeof v === "number" && !Number.isFinite(v))
      throw error("INVALID_ARGUMENTS", "Número inválido.");
    return v;
  });
  if (!serialized || Buffer.byteLength(serialized) > 12e6)
    throw error(
      "INVALID_ARGUMENTS",
      "La solicitud supera el tamaño permitido.",
    );
  return serialized;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export function attachAccess(budget) {
  const db = budget.db,
    originals = {};
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const audit = (
    actor,
    action,
    args,
    decision,
    reason,
    reviewer = null,
    policy = null,
  ) =>
    run(
      "INSERT INTO agent_audit(at,actor,action,args,decision,reason,reviewer,policy) VALUES (?,?,?,?,?,?,?,?)",
      new Date().toISOString(),
      actor,
      action,
      json(args),
      decision,
      reason,
      reviewer,
      policy ? json(policy) : null,
    );
  const owner = () => {
    if (context.getStore()?.actor)
      throw error("OWNER_REQUIRED", "Esta acción se administra desde Nemein.");
  };
  budget.reviewAuthor = () => context.getStore()?.actor?.id || context.getStore()?.reviewActor || "owner";
  const markReview = budget.markReview;
  budget.markReview = p => {
    owner();
    return db.transaction(() => {
      const result = markReview(p);
      audit("owner", "review-mark", p, "allow", "Revisión del propietario");
      return result;
    }).immediate();
  };
  function authenticate(token, version) {
    if (typeof token !== "string" || token.length < 32)
      throw error(
        "AUTH_REQUIRED",
        "Configurá el token de conexión generado en Permisos y propuestas.",
      );
    const actor = one(
      "SELECT * FROM agent_connections WHERE token_hash=?",
      hash(token),
    );
    if (!actor || !actor.active)
      throw error("AUTH_REQUIRED", "La conexión no existe o fue revocada.");
    if (actor.version !== version)
      throw error(
        "VERSION_MISMATCH",
        "La versión de la conexión cambió. Revisá sus permisos.",
      );
    return actor;
  }
  const revision = () => {
    const source = one(
      "SELECT source FROM event_identity WHERE singleton=1",
    ).source;
    const last = one(
      "SELECT sequence,id FROM budget_events ORDER BY sequence DESC LIMIT 1",
    ) || { sequence: 0, id: null };
    return Buffer.from(
      JSON.stringify({ version: 1, source, ...last }),
    ).toString("base64url");
  };
  function ruleFor(actor, action) {
    const r = one(
      "SELECT * FROM agent_rules WHERE connection_id=? AND connection_version=? AND action=?",
      actor.id,
      actor.version,
      action,
    );
    return r ? { ...r, conditions: JSON.parse(r.conditions) } : null;
  }
  function invoke(action, args, meta = {}) {
    const store = context.getStore();
    if (store?.internal) return originals[action](...args);
    const p = JSON.parse(json(payload(action, args)));
    if (!p || typeof p !== "object" || Array.isArray(p))
      throw error(
        "INVALID_ARGUMENTS",
        "Los argumentos deben ser un objeto JSON.",
      );
    delete p._csrf;
    const auth = store?.actor;
    const internal = () =>
      context.run({ ...store, internal: true }, () =>
        originals[action](...args),
      );
    if (!auth) {
      const perform = () => {
        const result = internal();
        audit("owner", action, p, "allow", "Acción del propietario");
        return result;
      };
      try {
        return actions[action].write
          ? db.transaction(perform).immediate()
          : perform();
      } catch (e) {
        audit("owner", action, p, "error", e.message || "La operación falló");
        throw e;
      }
    }
    const write = !!actions[action].write;
    let outcome;
    try {
      outcome = db
        .transaction(() => {
          const actor = authenticate(auth.token, auth.version);
          const requestId = meta.request_id;
          if (
            requestId !== undefined &&
            (typeof requestId !== "string" ||
              !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId))
          )
            throw error(
              "INVALID_REQUEST_ID",
              "El identificador de solicitud no es válido.",
            );
          const fingerprint = hash(
            json(
              canonical({
                action,
                p,
                connection_version: actor.version,
                action_version: actionVersion,
                base: meta.base ?? null,
                force: meta.forceProposal === true,
              }),
            ),
          );
          const rule = ruleFor(actor, action),
            decision = evaluatePolicy({ actor, rule, action, args: p });
          audit(
            actor.id,
            action,
            p,
            decision.decision,
            decision.reason,
            null,
            rule,
          );
          if (decision.decision === "deny") return { kind: "denied" };
          if (requestId) {
            const old = one(
              "SELECT * FROM agent_requests WHERE actor=? AND request_id=?",
              actor.id,
              requestId,
            );
            if (old) {
              if (old.fingerprint !== fingerprint)
                throw error(
                  "REQUEST_ID_REUSED",
                  "Ese identificador ya corresponde a otra solicitud.",
                );
              return { kind: "result", value: JSON.parse(old.result) };
            }
          }
          if (decision.decision === "ask" || meta.forceProposal) {
            if (actions[action].async)
              throw error(
                "ASYNC_PROPOSAL_UNSUPPORTED",
                "Los respaldos no admiten aprobación diferida.",
              );
            if (
              typeof meta.purpose !== "string" ||
              !meta.purpose.trim() ||
              meta.purpose.length > 500
            )
              throw error(
                "PURPOSE_REQUIRED",
                "Explicá para qué solicitás esta acción (máximo 500 caracteres).",
              );
            const base = meta.base;
            if (write && (typeof base !== "string" || base.length > 1024))
              throw error(
                "BASE_REQUIRED",
                "La propuesta necesita el cursor base que acompañaba al estado consultado.",
              );
            if (
              base !== undefined &&
              decodeCursor(base).source !==
                one("SELECT source FROM event_identity WHERE singleton=1")
                  .source
            )
              throw error(
                "CURSOR_MISMATCH",
                "La propuesta pertenece a otro presupuesto.",
              );
            const id = randomUUID(),
              rid = requestId || randomUUID();
            run(
              "INSERT INTO agent_proposals(id,actor,connection_version,request_id,action,action_version,args,base,purpose,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',?)",
              id,
              actor.id,
              actor.version,
              rid,
              action,
              actionVersion,
              json(p),
              base ?? revision(),
              meta.purpose.trim(),
              new Date().toISOString(),
            );
            const value = {
              status: "pending",
              proposal_id: id,
              request_id: rid,
              delivery: "delivered",
            };
            run(
              "INSERT INTO agent_requests VALUES (?,?,?,?)",
              actor.id,
              rid,
              fingerprint,
              json(value),
            );
            return { kind: "result", value };
          }
          // Read methods run after this short permission transaction, to keep event snapshots read-only.
          if (!write) return { kind: "read" };
          const value = internal() ?? null;
          if (value?.then)
            throw error("INVALID_ACTION", "La mutación debe ser síncrona.");
          if (requestId)
            run(
              "INSERT INTO agent_requests VALUES (?,?,?,?)",
              actor.id,
              requestId,
              fingerprint,
              json(value),
            );
          return { kind: "result", value };
        })
        .immediate();
    } catch (e) {
      audit(auth.id, action, p, "error", e.message || "La operación falló");
      throw e;
    }
    if (outcome.kind === "denied")
      throw error(
        "PERMISSION_DENIED",
        "La conexión no tiene permiso para " +
          actions[action].label.toLocaleLowerCase("es") +
          ".",
      );
    return outcome.kind === "read" ? internal() : outcome.value;
  }
  for (const [action, spec] of Object.entries(actions)) {
    originals[action] = budget[spec.method];
    if (typeof originals[action] !== "function")
      throw Error("Missing guarded method: " + spec.method);
    budget[spec.method] = (...args) =>
      invoke(action, args, context.getStore()?.meta);
  }
  budget.createConnection = (p) => {
    owner();
    if (typeof p.label !== "string" || !p.label.trim() || p.label.length > 100)
      throw error(
        "INVALID_CONNECTION",
        "Indicá un nombre de hasta 100 caracteres.",
      );
    const version = p.version || "1";
    if (typeof version !== "string" || !/^[a-zA-Z0-9._-]{1,40}$/.test(version))
      throw error("INVALID_CONNECTION", "Versión inválida.");
    const token = randomBytes(32).toString("hex"),
      id = randomUUID();
    run(
      "INSERT INTO agent_connections VALUES (?,?,?,?,1,?)",
      id,
      p.label.trim(),
      version,
      hash(token),
      new Date().toISOString(),
    );
    audit(
      "owner",
      "connection-create",
      { id, label: p.label, version },
      "allow",
      "Conexión creada sin permisos",
    );
    return { id, label: p.label.trim(), version, token };
  };
  budget.setRule = (p) => {
    owner();
    const connection = one(
      "SELECT * FROM agent_connections WHERE id=?",
      p.connection_id,
    );
    if (
      !connection ||
      !Object.hasOwn(actions, p.action) ||
      !["allow", "ask", "deny"].includes(p.decision)
    )
      throw error("INVALID_RULE", "Conexión, acción o decisión inválida.");
    const conditions = p.conditions || {};
    if (
      !conditions ||
      typeof conditions !== "object" ||
      Array.isArray(conditions) ||
      Object.keys(conditions).some(
        (k) => !["max_amount", "account_id", "otherwise"].includes(k),
      )
    )
      throw error("INVALID_RULE", "Condiciones inválidas.");
    if (
      conditions.max_amount !== undefined &&
      (!actions[p.action].money ||
        !Number.isSafeInteger(conditions.max_amount) ||
        conditions.max_amount < 0 ||
        conditions.max_amount > 1e12)
    )
      throw error(
        "INVALID_RULE",
        "El límite debe ser un importe entero no negativo para una acción con importe.",
      );
    if (
      conditions.account_id !== undefined &&
      (!actions[p.action].account ||
        !Number.isSafeInteger(conditions.account_id) ||
        conditions.account_id <= 0)
    )
      throw error("INVALID_RULE", "Esta acción no admite esa cuenta.");
    if (
      conditions.otherwise !== undefined &&
      !["ask", "deny"].includes(conditions.otherwise)
    )
      throw error(
        "INVALID_RULE",
        "Fuera de los límites se permite preguntar o negar.",
      );
    if (
      actions[p.action].async &&
      (p.decision === "ask" || conditions.otherwise === "ask")
    )
      throw error(
        "INVALID_RULE",
        "Los respaldos no admiten aprobación diferida.",
      );
    db.transaction(() => {
      run(
        "INSERT INTO agent_rules VALUES (?,?,?,?,?,?) ON CONFLICT(connection_id,connection_version,action) DO UPDATE SET action_version=excluded.action_version,decision=excluded.decision,conditions=excluded.conditions",
        connection.id,
        connection.version,
        p.action,
        actionVersion,
        p.decision,
        json(conditions),
      );
      audit(
        "owner",
        "permission-set",
        {
          connection_id: connection.id,
          action: p.action,
          decision: p.decision,
          conditions,
        },
        "allow",
        "Permiso actualizado",
      );
    }).immediate();
  };
  budget.revokeConnection = (id) => {
    owner();
    db.transaction(() => {
      if (!run("UPDATE agent_connections SET active=0 WHERE id=?", id).changes)
        throw error("INVALID_CONNECTION", "Conexión inexistente.");
      audit("owner", "connection-revoke", { id }, "allow", "Conexión revocada");
    }).immediate();
  };
  budget.changeConnectionVersion = (p) => {
    owner();
    if (
      typeof p.version !== "string" ||
      !/^[a-zA-Z0-9._-]{1,40}$/.test(p.version)
    )
      throw error("INVALID_CONNECTION", "Versión inválida.");
    db.transaction(() => {
      if (
        !run(
          "UPDATE agent_connections SET version=? WHERE id=?",
          p.version,
          p.id,
        ).changes
      )
        throw error("INVALID_CONNECTION", "Conexión inexistente.");
      run("DELETE FROM agent_rules WHERE connection_id=?", p.id);
      audit(
        "owner",
        "connection-version",
        { id: p.id, version: p.version },
        "allow",
        "Se retiraron todos los permisos",
      );
    }).immediate();
  };
  const proposalRow = (row) => ({
    ...row,
    args: JSON.parse(row.args),
    final_args: row.final_args ? JSON.parse(row.final_args) : null,
    result: row.result ? JSON.parse(row.result) : null,
  });
  budget.accessState = (options = {}) => {
    owner();
    const offset =
      Number.isSafeInteger(options.offset) && options.offset >= 0
        ? options.offset
        : 0;
    return {
      proposalOffset: offset,
      proposalTotal: one("SELECT COUNT(*) n FROM agent_proposals").n,
      connections: all(
        "SELECT id,label,version,active,created_at FROM agent_connections ORDER BY created_at",
      ),
      rules: all("SELECT * FROM agent_rules").map((r) => ({
        ...r,
        conditions: JSON.parse(r.conditions),
      })),
      proposals: all(
        "SELECT p.*,c.label FROM agent_proposals p JOIN agent_connections c ON c.id=p.actor ORDER BY (p.status='pending') DESC,p.created_at DESC,p.id LIMIT 50 OFFSET ?",
        offset,
      ).map((row) => ({
        ...proposalRow(row),
        conflict: row.status === "pending" && row.base !== revision(),
      })),
      audit: all(
        "SELECT * FROM agent_audit ORDER BY sequence DESC LIMIT 100",
      ).map((r) => ({
        ...r,
        args: JSON.parse(r.args),
        policy: r.policy ? JSON.parse(r.policy) : null,
      })),
      actions,
    };
  };
  budget.resolveProposal = (p) => {
    owner();
    if (db.inTransaction)
      throw error(
        "PROPOSAL_TRANSACTION",
        "Revisá propuestas fuera de otras transacciones.",
      );
    if (!["accept", "modify", "reject"].includes(p.decision))
      throw error("INVALID_PROPOSAL", "Decisión inválida.");
    const reason = typeof p.reason === "string" ? p.reason.trim() : "";
    if (reason.length > 500 || (p.decision !== "accept" && !reason))
      throw error(
        "REASON_REQUIRED",
        "Indicá un motivo de hasta 500 caracteres.",
      );
    try {
      return db
        .transaction(() => {
          const proposal = one(
            "SELECT * FROM agent_proposals WHERE id=?",
            p.id,
          );
          if (!proposal || proposal.status !== "pending")
            throw error(
              "PROPOSAL_CLOSED",
              "La propuesta no existe o ya fue respondida.",
            );
          if (p.decision === "reject") {
            run(
              "UPDATE agent_proposals SET status='rejected',reason=?,resolved_at=? WHERE id=?",
              reason,
              new Date().toISOString(),
              p.id,
            );
            audit(
              proposal.actor,
              proposal.action,
              JSON.parse(proposal.args),
              "rejected",
              reason,
              "owner",
            );
            return { status: "rejected" };
          }
          const connection = one(
            "SELECT * FROM agent_connections WHERE id=?",
            proposal.actor,
          );
          if (
            !connection?.active ||
            connection.version !== proposal.connection_version ||
            proposal.action_version !== actionVersion
          )
            throw error(
              "PERMISSION_DENIED",
              "La conexión fue revocada o cambió de versión.",
            );
          const args =
            p.decision === "modify"
              ? JSON.parse(json(p.args))
              : JSON.parse(proposal.args);
          if (!args || typeof args !== "object" || Array.isArray(args))
            throw error(
              "INVALID_ARGUMENTS",
              "Los argumentos deben ser un objeto.",
            );
          if (
            evaluatePolicy({
              actor: connection,
              rule: ruleFor(connection, proposal.action),
              action: proposal.action,
              args,
            }).decision === "deny"
          )
            throw error(
              "PERMISSION_DENIED",
              "El permiso fue revocado o la solicitud queda fuera de sus límites.",
            );
          if (proposal.base !== revision())
            throw error(
              "PROPOSAL_CONFLICT",
              "El presupuesto cambió desde la propuesta. Pedí una nueva propuesta con la base actual.",
            );
          const result = reviewedReadContext.run(true, () =>
            context.run({ internal: true, reviewActor: proposal.actor }, () =>
              originals[proposal.action](...callArgs(proposal.action, args)),
            ),
          );
          const status = p.decision === "modify" ? "modified" : "accepted";
          run(
            "UPDATE agent_proposals SET status=?,final_args=?,result=?,reason=?,resolved_at=? WHERE id=?",
            status,
            json(args),
            json(result),
            reason,
            new Date().toISOString(),
            p.id,
          );
          audit(
            proposal.actor,
            proposal.action,
            args,
            status,
            reason || "Aprobación manual",
            "owner",
          );
          return { status, result: result ?? null };
        })
        .immediate();
    } catch (e) {
      const proposal = one(
        "SELECT actor,action,args FROM agent_proposals WHERE id=?",
        p.id,
      );
      if (proposal)
        audit(
          proposal.actor,
          proposal.action,
          JSON.parse(proposal.args),
          "error",
          e.message,
          "owner",
        );
      throw e;
    }
  };
  budget.rotateConnection = (id) => {
    owner();
    const token = randomBytes(32).toString("hex");
    const c = one(
      "SELECT id,label,version FROM agent_connections WHERE id=? AND active=1",
      id,
    );
    if (!c)
      throw error("INVALID_CONNECTION", "Conexión inexistente o revocada.");
    db.transaction(() => {
      run(
        "UPDATE agent_connections SET token_hash=? WHERE id=?",
        hash(token),
        id,
      );
      audit("owner", "connection-rotate", { id }, "allow", "Token renovado");
    }).immediate();
    return { ...c, token };
  };
  budget.forAgent = (token, version = "1") => {
    const actor = authenticate(token, version);
    const scoped = {
      identity: { id: actor.id, label: actor.label, version: actor.version },
    };
    const runAs = (fn, meta = {}) =>
      context.run({ actor: { id: actor.id, token, version }, meta }, fn);
    for (const spec of Object.values(actions))
      scoped[spec.method] = (...args) =>
        runAs(() => budget[spec.method](...args));
    scoped.request = (action, p = {}, meta = {}) => {
      if (!Object.hasOwn(actions, action))
        throw error("INVALID_ACTION", "Acción desconocida.");
      return runAs(
        () => budget[actions[action].method](...callArgs(action, p)),
        meta,
      );
    };
    scoped.permissions = () =>
      runAs(() => {
        const current = authenticate(token, version);
        const permissions = Object.fromEntries(
          Object.entries(actions).map(([action, spec]) => {
            const rule = ruleFor(current, action);
            return [
              action,
              {
                label: spec.label,
                write: !!spec.write,
                action_version: actionVersion,
                decision:
                  rule?.action_version === actionVersion
                    ? rule.decision
                    : "deny",
                conditions: rule?.conditions || {},
              },
            ];
          }),
        );
        audit(
          current.id,
          "permissions",
          {},
          "allow",
          "Consultar permisos propios",
        );
        return {
          connection_id: current.id,
          version: current.version,
          actions: permissions,
        };
      });
    scoped.proposalStatus = ({ id }) =>
      runAs(() => {
        authenticate(token, version);
        const row = one(
          "SELECT * FROM agent_proposals WHERE id=? AND actor=? AND connection_version=?",
          id,
          actor.id,
          version,
        );
        if (!row)
          throw error(
            "PROPOSAL_NOT_FOUND",
            "Propuesta inexistente para esta conexión.",
          );
        const current = authenticate(token, version);
        if (
          row.result &&
          decide(
            ruleFor(current, row.action),
            row.action,
            JSON.parse(row.final_args || row.args),
          ).decision === "deny"
        )
          throw error(
            "PERMISSION_DENIED",
            "El permiso de esta respuesta fue retirado.",
          );
        const value = proposalRow(row);
        return {
          ...value,
          conflict: row.status === "pending" && row.base !== revision(),
          delivery: row.status === "pending" ? "delivered" : "responded",
        };
      });
    scoped.submitProposal = (envelope) => {
      if (
        envelope.version !== 1 ||
        (envelope.connection_id && envelope.connection_id !== actor.id)
      )
        throw error(
          "INVALID_PROPOSAL",
          "El archivo no corresponde a esta conexión o versión.",
        );
      return scoped.request(envelope.action, envelope.args, {
        request_id: envelope.request_id,
        base: envelope.base,
        purpose: envelope.purpose,
        forceProposal: true,
      });
    };
    return Object.freeze(scoped);
  };
  return budget;
}
