import { randomUUID } from "node:crypto";
import { actions, callArgs } from "./actions.js";
export const commands = Object.fromEntries(
  Object.entries(actions).map(([key, spec]) => [key, spec.method]),
);
export function proposalFile(p) {
  if (
    !p ||
    !Object.hasOwn(actions, p.action) ||
    actions[p.action].async ||
    !p.args ||
    typeof p.args !== "object" ||
    Array.isArray(p.args)
  )
    throw Error("Indicá una acción y un objeto de argumentos válidos.");
  if (
    typeof p.purpose !== "string" ||
    !p.purpose.trim() ||
    p.purpose.length > 500
  )
    throw Error("Indicá para qué proponés la acción.");
  if (
    actions[p.action].write &&
    (typeof p.base !== "string" || p.base.length > 1024)
  )
    throw Error("Incluí el cursor base del último snapshot consultado.");
  const request_id = p.request_id || randomUUID();
  if (
    typeof request_id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(request_id)
  )
    throw Error("Identificador de solicitud inválido.");
  return {
    version: 1,
    request_id,
    action: p.action,
    args: p.args,
    ...(p.base ? { base: p.base } : {}),
    purpose: p.purpose.trim(),
    delivery: "undelivered",
  };
}
export async function execute(b, command, p = {}) {
  if (command === "permissions") {
    if (!b.permissions) throw Error("La consulta requiere una conexión.");
    return b.permissions();
  }
  if (command === "proposal-status") {
    if (!b.proposalStatus)
      throw Error("Esta consulta requiere una conexión de agente.");
    return b.proposalStatus(p);
  }
  if (command === "proposal-submit") {
    if (!b.submitProposal)
      throw Error("La entrega requiere una conexión de agente.");
    return b.submitProposal(p);
  }
  if (!Object.hasOwn(commands, command))
    throw Error("Comando desconocido. Usá help.");
  const { _request_id, _base, _purpose, ...args } = p;
  if (b.request)
    return b.request(command, args, {
      request_id: _request_id,
      base: _base,
      purpose: _purpose,
    });
  return b[commands[command]](...callArgs(command, args));
}
