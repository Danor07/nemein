import { readAgentToken } from "./credentials.js";
import { readFileSync } from "node:fs";
import { execute } from "./commands.js";
import { actions } from "./actions.js";
import { descriptors } from "./action-schemas.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openBudget } from "./core.js";

const owner = openBudget();
const b = owner.forAgent(
  readAgentToken(),
  process.env.BUDGET_AGENT_VERSION || "1",
);
const server = new McpServer({
  name: "nemein",
  version: JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version,
});
const out = (fn) => async (p) => {
  try {
    return {
      content: [{ type: "text", text: JSON.stringify((await fn(p)) ?? null) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: e.code || "INVALID_REQUEST",
            error: e.message,
          }),
        },
      ],
    };
  }
};
const metadata = {
  _request_id: z.string().max(100).optional(),
  _base: z.string().max(1024).optional(),
  _purpose: z.string().max(500).optional(),
};
for (const [name, action, schema] of descriptors)
  server.tool(
    name,
    actions[action].label + "; sujeto a los permisos de esta conexión",
    { ...schema, ...metadata },
    out(async (p) => {
      const value = await execute(b, action, p);
      if (
        ["account", "category", "recurring-create"].includes(action) &&
        typeof value === "number"
      )
        return { id: value };
      return value === undefined ? { ok: true } : value;
    }),
  );
server.tool(
  "ejecutar_accion",
  "Ejecutar una acción autorizada o solicitar revisión; las conexiones nuevas no tienen permisos",
  {
    action: z.enum(Object.keys(actions)),
    arguments: z.record(z.string(), z.unknown()),
    request_id: z.string().max(100).optional(),
    base: z.string().max(1024).optional(),
    purpose: z.string().max(500).optional(),
  },
  out((p) =>
    b.request(p.action, p.arguments, {
      request_id: p.request_id,
      base: p.base,
      purpose: p.purpose,
    }),
  ),
);
server.tool(
  "estado_propuesta",
  "Consultar únicamente una propuesta propia y su respuesta",
  { id: z.string() },
  out((p) => b.proposalStatus(p)),
);
server.tool(
  "entregar_propuesta",
  "Entregar un archivo de propuesta preparado sin conexión; nunca lo aplica automáticamente",
  {
    version: z.literal(1),
    request_id: z.string(),
    action: z.enum(Object.keys(actions)),
    args: z.record(z.string(), z.unknown()),
    base: z.string().optional(),
    purpose: z.string(),
    connection_id: z.string().optional(),
    delivery: z.string().optional(),
  },
  out((p) => b.submitProposal(p)),
);
server.tool(
  "permisos_conexion",
  "Consultar los permisos propios sin acceder a datos financieros",
  {},
  out(() => b.permissions()),
);
await server.connect(new StdioServerTransport());
const stop = () => {
  owner.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.stdin.on("end", () => {
  if (owner.db.open) owner.close();
});
