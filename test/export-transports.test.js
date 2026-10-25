import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openBudget } from "../src/core.js";
import { saveCredential } from "../src/credentials.js";
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-export-transport-")),
    b = openBudget(dir);
  const connection = b.createConnection({ label: "Export transport fixture" });
  const tokenFile = saveCredential(dir, connection.token);
  const env = {
    ...process.env,
    BUDGET_DATA_DIR: dir,
    BUDGET_AGENT_TOKEN_FILE: tokenFile,
    BUDGET_AGENT_TOKEN: "wrong-inherited-token",
    BUDGET_AGENT_VERSION: "1",
  };
  t.after(() => {
    if (b.db.open) b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (args, input) =>
    spawnSync(process.execPath, ["src/cli.js", ...args], {
      env,
      encoding: "utf8",
      timeout: 15000,
      input,
    });
  return { dir, b, connection, env, run };
}
test("CLI export requires its own grant and keeps JSON/file/stdin responses portable", (t) => {
  const { dir, b, connection, run } = fixture(t);
  let r = run(["export"]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).code, "PERMISSION_DENIED");
  assert.equal(r.stdout, "");
  b.setRule({
    connection_id: connection.id,
    action: "export",
    decision: "allow",
  });
  const a = b.createAccount({
    name: "CLI",
    type: "efectivo",
    balance: 100,
    date: "2026-01-01",
  });
  b.addTransaction({
    account_id: a,
    date: "2026-01-02",
    payee: "CLI expense",
    amount: -5,
    category_id: 1,
  });
  r = run(["export"]);
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout).result,
    doc = JSON.parse(json.content);
  assert.equal(json.format, "json");
  assert.equal(doc.data.transactions.length, 2);
  assert.equal(json.content.includes(connection.token), false);
  const request = path.join(dir, "request.json");
  writeFileSync(request, '\uFEFF{"format":"csv"}');
  r = run(["export", "--file", request]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).result.format, "csv");
  r = run(["export", "--stdin"], '{"format":"json"}');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    JSON.parse(JSON.parse(r.stdout).result.content).data,
    doc.data,
  );
  const destination = path.join(dir, "must-not-exist.csv");
  r = run(["export", JSON.stringify({ format: "csv", destination })]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).code, "INVALID_EXPORT_OPTIONS");
  assert.equal(existsSync(destination), false);
  b.revokeConnection(connection.id);
  r = run(["export"]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).code, "AUTH_REQUIRED");
  assert.equal(r.stdout, "");
});
test("MCP advertises export and enforces format, its own grant, both formats and live revocation", async (t) => {
  const { b, connection, env } = fixture(t),
    client = new Client({ name: "export-fixture", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("src/mcp.js")],
        env,
      }),
    );
    assert.ok(
      (await client.listTools()).tools.some(
        (tool) => tool.name === "exportar_presupuesto",
      ),
    );
    const call = (format) =>
      client.callTool({ name: "exportar_presupuesto", arguments: { format } });
    let response = await call("json");
    assert.equal(
      JSON.parse(response.content[0].text).code,
      "PERMISSION_DENIED",
    );
    b.setRule({
      connection_id: connection.id,
      action: "export",
      decision: "allow",
    });
    for (const format of ["json", "csv"]) {
      response = await call(format);
      assert.equal(response.isError, undefined, response.content[0].text);
      const result = JSON.parse(response.content[0].text);
      assert.equal(result.format, format);
      assert.equal(result.currency, "PYG");
      assert.ok(result.content.length > 0);
      if (format === "json")
        assert.equal(JSON.parse(result.content).data.accounts.length, 0);
    }
    response = await call("xml");
    assert.equal(response.isError, true);
    b.revokeConnection(connection.id);
    response = await call("json");
    assert.equal(JSON.parse(response.content[0].text).code, "AUTH_REQUIRED");
  } finally {
    await client.close();
  }
});
