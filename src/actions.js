export const actions = Object.freeze({
  export: {
    method: "exportData",
    label: "Exportar datos financieros completos",
  },
  snapshot: {
    method: "snapshot",
    label: "Consultar presupuesto y movimientos",
    mode: "month",
  },
  overview: {
    method: "overview",
    label: "Consultar resumen mensual",
    mode: "month",
  },
  account: {
    method: "createAccount",
    label: "Crear cuenta y saldo inicial",
    write: true,
    money: "balance",
  },
  transaction: {
    method: "addTransaction",
    label: "Registrar ingreso o gasto",
    write: true,
    money: "amount",
    account: "account_id",
  },
  allocate: {
    method: "allocate",
    label: "Asignar presupuesto",
    write: true,
    money: "amount",
  },
  transfer: {
    method: "transfer",
    label: "Transferir entre cuentas",
    write: true,
    money: "amount",
    account: "from",
  },
  import: {
    method: "importCsv",
    label: "Confirmar importación CSV",
    write: true,
  },
  reconcile: {
    method: "reconcile",
    label: "Calcular o confirmar conciliación",
    write: true,
    money: "balance",
    account: "account_id",
    mode: "reconcile",
  },
  reports: { method: "reports", label: "Consultar reportes", mode: "month" },
  backup: { method: "backup", label: "Crear respaldo local", async: true },
  categorize: {
    method: "categorize",
    label: "Cambiar categoría de movimiento",
    write: true,
  },
  category: { method: "createCategory", label: "Crear categoría", write: true },
  group: {
    method: "createGroup",
    label: "Crear grupo de categorías",
    write: true,
  },
  goals: { method: "listGoals", label: "Consultar metas", mode: "month" },
  "goal-set": {
    method: "setGoal",
    label: "Guardar meta",
    write: true,
    money: "amount",
  },
  "goal-remove": { method: "removeGoal", label: "Eliminar meta", write: true },
  recurring: { method: "listRecurring", label: "Consultar recurrentes" },
  "recurring-create": {
    method: "createRecurring",
    label: "Crear recurrente",
    write: true,
    money: "amount",
    account: "account_id",
  },
  "recurring-post": {
    method: "postRecurring",
    label: "Registrar un vencimiento",
    write: true,
  },
  "recurring-toggle": {
    method: "toggleRecurring",
    label: "Pausar o activar recurrente",
    write: true,
  },
  search: { method: "searchTransactions", label: "Buscar movimientos" },
  cube: { method: "cube", label: "Analizar gastos" },
  "event-snapshot": {
    method: "eventSnapshot",
    label: "Consultar snapshot y cursor",
  },
  events: { method: "readEvents", label: "Leer historial de eventos" },
  "transaction-delete": {
    method: "deleteTransaction",
    label: "Borrar movimiento no conciliado",
    write: true,
    mode: "id",
  },
  "import-preview": {
    method: "csvPreview",
    label: "Revisar archivo CSV",
    mode: "csv",
  },
  "import-mapping": {
    method: "mapping",
    label: "Consultar mapeo CSV",
    mode: "account",
  },
  "account-transactions": {
    method: "accountTransactions",
    label: "Consultar movimientos de una cuenta",
    mode: "account",
  },
});
export const actionVersion = 1;
export function callArgs(action, p = {}) {
  switch (actions[action]?.mode) {
    case "month":
      return [p.month];
    case "reconcile":
      return [p, p.commit === true];
    case "id":
      return [p.id];
    case "account":
      return [p.account_id];
    case "csv":
      return [p.content, p.config, p.account_id];
    default:
      return [p];
  }
}
export function payload(action, args) {
  switch (actions[action].mode) {
    case "month":
      return args[0] === undefined ? {} : { month: args[0] };
    case "reconcile":
      return { ...args[0], commit: args[1] === true };
    case "id":
      return { id: args[0] };
    case "account":
      return { account_id: args[0] };
    case "csv":
      return { content: args[0], config: args[1], account_id: args[2] };
    default:
      return args[0] ?? {};
  }
}
