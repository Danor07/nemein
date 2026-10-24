import { execute } from "./commands.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openBudget } from "./core.js";
const b = openBudget();
await b.backup();
const server = new McpServer({ name: "nemein", version: "0.1.0" });
const out = (fn) => async (p) => {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn(p)) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: e.message }] };
  }
};
server.tool(
  "presupuesto",
  "Consultar presupuesto, cuentas y movimientos",
  { month: z.string().optional() },
  out((p) => b.snapshot(p.month)),
);
server.tool(
  "reportes",
  "Gastos y patrimonio",
  { month: z.string() },
  out((p) => b.reports(p.month)),
);
server.tool(
  "resumen",
  "Ingresos y gastos del mes, categorías sin cubrir, metas y próximos vencimientos",
  { month: z.string().optional() },
  out((p) => b.overview(p.month)),
);
server.tool(
  "buscar_movimientos",
  "Buscar movimientos por mes, texto, cuenta o categoría",
  {
    month: z.string().optional(),
    query: z.string().optional(),
    account_id: z.number().int().optional(),
    category_id: z.number().int().optional(),
  },
  out((p) => b.searchTransactions(p)),
);
server.tool(
  "metas",
  "Consultar metas y progreso con el saldo disponible de la categoría",
  { month: z.string().optional() },
  out((p) => b.listGoals(p.month)),
);
server.tool(
  "recurrentes",
  "Consultar recurrentes activos y pausados con su próximo vencimiento",
  {},
  out(() => b.listRecurring()),
);
server.tool(
  "analizar_gastos",
  "Cruzar gastos por mes, día, categoría, cuenta o beneficiario. Excluye transferencias y saldos iniciales; reintegros reducen gastos.",
  {
    from: z.string(),
    to: z.string(),
    dimensions: z
      .array(z.enum(["month", "day", "category", "account", "payee"]))
      .min(1)
      .max(3)
      .optional(),
  },
  out((p) => b.cube(p)),
);
if (process.env.BUDGET_EVENTS_READ === "1") {
  server.tool(
    "snapshot_eventos",
    "Snapshot mensual consistente, metas, recurrentes y cursor para seguir cambios",
    { month: z.string().optional() },
    out((p) => execute(b, "event-snapshot", p)),
  );
  server.tool(
    "eventos",
    "Leer una página de eventos después de un cursor; guardar cursor tras procesar y deduplicar por source e id",
    {
      after: z.string().max(1024),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    out((p) => execute(b, "events", p)),
  );
}
if (process.env.BUDGET_MCP_WRITE === "1") {
  server.tool(
    "crear_cuenta",
    "Crear una cuenta con su saldo inicial",
    {
      name: z.string(),
      type: z.enum(["corriente", "credito", "efectivo"]),
      balance: z.number().int(),
      date: z.string(),
    },
    out((p) => ({ id: b.createAccount(p) })),
  );
  server.tool(
    "crear_categoria",
    "Crear una categoría dentro de un grupo existente",
    { name: z.string(), group_id: z.number().int() },
    out((p) => ({ id: b.createCategory(p) })),
  );
  server.tool(
    "transferir",
    "Transferir dinero entre cuentas sin duplicar gastos",
    {
      from: z.number().int(),
      to: z.number().int(),
      amount: z.number().int().positive(),
      date: z.string(),
    },
    out((p) => {
      b.transfer(p);
      return { ok: true };
    }),
  );
  server.tool(
    "guardar_meta",
    "Crear o actualizar una meta; no mueve dinero",
    {
      category_id: z.number().int(),
      amount: z.number().int().positive(),
      due_date: z.string(),
    },
    out((p) => b.setGoal(p)),
  );
  server.tool(
    "crear_recurrente",
    "Programar un ingreso o gasto; no lo registra todavía",
    {
      account_id: z.number().int(),
      category_id: z.number().int().optional(),
      payee: z.string(),
      amount: z.number().int(),
      next_date: z.string(),
      frequency: z.enum(["weekly", "monthly", "yearly"]),
    },
    out((p) => ({ id: b.createRecurring(p) })),
  );
  server.tool(
    "registrar_vencimiento",
    "Registrar una sola ocurrencia y avanzar al próximo vencimiento. due_date debe coincidir con el próximo vencimiento consultado.",
    { id: z.number().int(), due_date: z.string() },
    out((p) => b.postRecurring(p)),
  );
  server.tool(
    "activar_recurrente",
    "Pausar o reactivar un movimiento recurrente",
    { id: z.number().int(), active: z.boolean() },
    out((p) => b.toggleRecurring(p)),
  );
  server.tool(
    "registrar_movimiento",
    "Registrar ingreso o gasto en guaraníes enteros",
    {
      account_id: z.number().int(),
      date: z.string(),
      payee: z.string(),
      amount: z.number().int(),
      category_id: z.number().int().optional(),
    },
    out((p) => ({ id: b.addTransaction(p) })),
  );
  server.tool(
    "asignar_presupuesto",
    "Fijar el importe asignado a una categoría en un mes",
    {
      month: z.string(),
      category_id: z.number().int(),
      amount: z.number().int(),
    },
    out((p) => {
      b.allocate(p);
      return b.snapshot(p.month);
    }),
  );
}
await server.connect(new StdioServerTransport());
process.on("SIGINT", () => {
  b.close();
  process.exit(0);
});
