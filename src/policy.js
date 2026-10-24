import { actions, actionVersion } from "./actions.js";
export function decide(rule, action, p) {
  if (
    !Object.hasOwn(actions, action) ||
    !rule ||
    rule.action_version !== actionVersion
  )
    return { decision: "deny", reason: "Sin permiso vigente" };
  if (
    !["allow", "ask", "deny"].includes(rule.decision) ||
    rule.decision === "deny"
  )
    return { decision: "deny", reason: "Permiso negado por el propietario" };
  const c = rule.conditions || {};
  let matches = true;
  if (c.max_amount !== undefined) {
    const field = actions[action].money,
      v = p[field] ?? (field === "balance" ? 0 : undefined);
    matches =
      matches &&
      /^-?\d+$/.test(String(v)) &&
      Number.isSafeInteger(Number(v)) &&
      Math.abs(Number(v)) <= c.max_amount;
  }
  if (c.account_id !== undefined)
    matches = matches && Number(p[actions[action].account]) === c.account_id;
  return {
    decision: matches ? rule.decision : c.otherwise || "deny",
    reason: matches
      ? "Regla de la conexión"
      : "Fuera de los límites de la regla",
  };
}

export function evaluatePolicy({ actor, rule, action, args }) {
  if (
    !actor ||
    ![true, 1].includes(actor.active) ||
    !rule ||
    rule.connection_id !== actor.id ||
    rule.connection_version !== actor.version
  )
    return {
      decision: "deny",
      reason: "Conexión o versión sin permiso vigente",
    };
  return decide(rule, action, args);
}
