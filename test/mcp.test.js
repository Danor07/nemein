import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openBudget } from "../src/core.js";

test("MCP real: default deny, explicit grants, proposals and live revocation", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-mcp-")),
    b = openBudget(dir);
  const connection = b.createConnection({ label: "MCP fixture" }),
    client = new Client({ name: "fixture", version: "1" });
  const grant = (action, decision = "allow") =>
    b.setRule({ connection_id: connection.id, action, decision });
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, undefined, r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("src/mcp.js")],
        env: {
          ...process.env,
          BUDGET_DATA_DIR: dir,
          BUDGET_AGENT_TOKEN: connection.token,
          BUDGET_AGENT_VERSION: "1",
          BUDGET_MCP_WRITE: "1",
          BUDGET_EVENTS_READ: "1",
        },
      }),
    );
    const denied = await client.callTool({
      name: "presupuesto",
      arguments: { month: "2026-10" },
    });
    assert.equal(JSON.parse(denied.content[0].text).code, "PERMISSION_DENIED");
    for (const a of [
      "snapshot",
      "event-snapshot",
      "account",
      "recurring-create",
      "recurring-post",
      "cube",
    ])
      grant(a);
    assert.equal((await call("presupuesto", { month: "2026-10" })).ready, 0);
    const account = await call("crear_cuenta", {
      name: "MCP cash",
      type: "efectivo",
      balance: 100000,
      date: "2026-10-01",
    });
    const recurring = await call("crear_recurrente", {
      account_id: account.id,
      category_id: 1,
      payee: "Fixture",
      amount: -10000,
      next_date: "2026-10-23",
      frequency: "monthly",
    });
    await call("registrar_vencimiento", {
      id: recurring.id,
      due_date: "2026-10-23",
    });
    assert.equal(
      (
        await client.callTool({
          name: "registrar_vencimiento",
          arguments: { id: recurring.id, due_date: "2026-10-23" },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await call("analizar_gastos", {
          from: "2026-10-01",
          to: "2026-10-31",
          dimensions: ["account", "category"],
        })
      ).totals.spending,
      10000,
    );
    grant("transaction", "ask");
    const base = (await call("snapshot_eventos", { month: "2026-10" })).cursor;
    const proposed = await call("registrar_movimiento", {
      account_id: account.id,
      date: "2026-10-24",
      payee: "Review",
      amount: -5,
      category_id: 1,
      _base: base,
      _purpose: "Registrar gasto con aprobación",
      _request_id: "mcp-review",
    });
    assert.equal(proposed.status, "pending");
    b.resolveProposal({ id: proposed.proposal_id, decision: "accept" });
    assert.equal(
      (await call("estado_propuesta", { id: proposed.proposal_id })).status,
      "accepted",
    );
    grant("snapshot", "deny");
    assert.equal(
      (
        await client.callTool({
          name: "presupuesto",
          arguments: { month: "2026-10" },
        })
      ).isError,
      true,
    );
  } finally {
    await client.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
