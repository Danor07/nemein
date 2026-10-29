import { z } from "zod";

const month = { month: z.string().optional() };
const id = z.number().int().positive(),
  amount = z.number().int();
export const descriptors = [
  [
    "exportar_presupuesto",
    "export",
    { format: z.enum(["json", "csv"]).optional() },
  ],
  ["presupuesto", "snapshot", month],
  ["reportes", "reports", month],
  ["resumen", "overview", month],
  [
    "buscar_movimientos",
    "search",
    {
      ...month,
      query: z.string().optional(),
      account_id: id.optional(),
      category_id: id.optional(),
    },
  ],
  ["metas", "goals", month],
  ["recurrentes", "recurring", {}],
  [
    "analizar_gastos",
    "cube",
    {
      from: z.string(),
      to: z.string(),
      dimensions: z
        .array(z.enum(["month", "day", "category", "account", "payee"]))
        .min(1)
        .max(3)
        .optional(),
    },
  ],
  ["snapshot_eventos", "event-snapshot", month],
  [
    "eventos",
    "events",
    { after: z.string().max(1024), limit: id.max(1000).optional() },
  ],
  [
    "crear_cuenta",
    "account",
    {
      name: z.string(),
      type: z.enum(["corriente", "credito", "efectivo"]),
      balance: amount,
      date: z.string(),
    },
  ],
  ["crear_categoria", "category", { name: z.string(), group_id: id }],
  [
    "transferir",
    "transfer",
    { from: id, to: id, amount: amount.positive(), date: z.string() },
  ],
  [
    "guardar_meta",
    "goal-set",
    { category_id: id, amount: amount.positive(), due_date: z.string() },
  ],
  [
    "crear_recurrente",
    "recurring-create",
    {
      account_id: id,
      category_id: id.optional(),
      payee: z.string(),
      amount,
      next_date: z.string(),
      frequency: z.enum(["weekly", "monthly", "yearly"]),
    },
  ],
  ["registrar_vencimiento", "recurring-post", { id, due_date: z.string() }],
  ["activar_recurrente", "recurring-toggle", { id, active: z.boolean() }],
  [
    "registrar_movimiento",
    "transaction",
    {
      account_id: id,
      date: z.string(),
      payee: z.string(),
      amount,
      category_id: id.optional(),
    },
  ],
  [
    "asignar_presupuesto",
    "allocate",
    { month: z.string(), category_id: id, amount },
  ],
];

// These shapes describe transport structure; domain semantics stay in the core.
export const actionShapes = Object.freeze({
  ...Object.fromEntries(
    descriptors.map(([, action, shape]) => [action, shape]),
  ),
  group: { name: z.string() },
  categorize: { id, category_id: id.nullable().optional() },
  "goal-remove": { category_id: id },
  "transaction-delete": { id },
  "import-mapping": { account_id: id },
  "account-transactions": { account_id: id },
  "import-preview": {
    account_id: id,
    content: z.string(),
    config: z.record(z.string(), z.unknown()),
  },
  import: {
    account_id: id,
    content: z.string(),
    config: z.record(z.string(), z.unknown()),
  },
  reconcile: {
    account_id: id,
    date: z.string(),
    balance: amount,
    ids: z.array(id).optional(),
    commit: z.boolean().optional(),
  },
  backup: {},
  "review-package": { from: z.string(), to: z.string(), as_of: z.string() },
  "review-save": {
    id: z.string(),
    package: z.record(z.string(), z.unknown()),
    report: z.string(),
    generator: z.string(),
  },
  "review-list": { offset: z.number().int().nonnegative().optional() },
  "review-get": { id: z.string() },
  permissions: {},
  "proposal-status": { id: z.string() },
});
