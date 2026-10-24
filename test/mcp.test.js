import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("MCP real por stdio: lectura predeterminada y escritura explícita", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-mcp-"));
  try {
    for (const write of ["0", "1"]) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("src/mcp.js")],
        env: { ...process.env, BUDGET_DATA_DIR: dir, BUDGET_MCP_WRITE: write, BUDGET_EVENTS_READ: "0" },
      });
      const client = new Client({ name: "cero-test", version: "1.0" });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        assert.equal(tools.tools.length, write === "1" ? 16 : 7);
        const response = await client.callTool({
          name: "presupuesto",
          arguments: { month: "2026-10" },
        });
        assert.equal(response.isError, undefined);
        assert.equal(JSON.parse(response.content[0].text).ready, 0);
        if(write === '1') {
          const call = async(name,args) => {
            const r = await client.callTool({name,arguments:args});
            assert.equal(r.isError,undefined,r.content[0].text);
            return JSON.parse(r.content[0].text);
          };
          const account = await call('crear_cuenta',{name:'Cuenta MCP',type:'efectivo',balance:100000,date:'2026-10-01'});
          const recurring = await call('crear_recurrente',{account_id:account.id,category_id:1,payee:'Prueba recurrente',amount:-10000,next_date:'2026-10-23',frequency:'monthly'});
          await call('registrar_vencimiento',{id:recurring.id,due_date:'2026-10-23'});
          const duplicate = await client.callTool({name:'registrar_vencimiento',arguments:{id:recurring.id,due_date:'2026-10-23'}});
          assert.equal(duplicate.isError,true);
          const cube = await call('analizar_gastos',{from:'2026-10-01',to:'2026-10-31',dimensions:['account','category']});
          assert.equal(cube.totals.spending,10000);
        } else {
          assert.equal(tools.tools.some(t=>t.name==='registrar_vencimiento'),false);
        }
      } finally {
        await client.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
