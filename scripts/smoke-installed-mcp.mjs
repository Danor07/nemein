import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(process.argv[2]);
const runtime = path.join(root, "runtime");
const load = (name) => import(pathToFileURL(path.join(runtime, "src", name)));
const { openBudget } = await load("core.js");
const { saveCredential, readAgentToken } = await load("credentials.js");
const { installedAgentConfig } = await load("agent-config.js");
const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-installed-smoke-"));
const budget = openBudget(dir);
const connection = budget.createConnection({ label: "Installed CI fixture" });
const client = new Client({ name: "installed-smoke", version: "1" });
try {
  const file = saveCredential(dir, connection.token);
  assert.equal(
    readAgentToken({ BUDGET_AGENT_TOKEN_FILE: file }),
    connection.token,
  );
  const config = installedAgentConfig(dir, {
    installDirs: [root],
    agentTokenFile: file,
    connectionVersion: "1",
  });
  assert.ok(config, "Installed configuration must resolve");
  const server = config.mcpServers.nemein;
  assert.equal(server.command, path.join(runtime, "node.exe"));
  assert.equal(server.env.BUDGET_AGENT_TOKEN, undefined);
  assert.equal(JSON.stringify(config).includes(connection.token), false);
  assert.equal(server.env.BUDGET_AGENT_TOKEN_FILE, file);
  await client.connect(
    new StdioClientTransport({
      ...server,
      env: {
        ...server.env,
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        BUDGET_AGENT_TOKEN: "invalid-inherited-token",
      },
    }),
  );
  const version = JSON.parse(
    readFileSync(path.join(runtime, "package.json"), "utf8"),
  ).version;
  assert.equal(client.getServerVersion().version, version);
  assert.equal((await client.listTools()).tools.length, 23);
  const call = () =>
    client.callTool({ name: "presupuesto", arguments: { month: "2026-10" } });
  let response = await call();
  assert.equal(JSON.parse(response.content[0].text).code, "PERMISSION_DENIED");
  budget.setRule({
    connection_id: connection.id,
    action: "snapshot",
    decision: "allow",
  });
  response = await call();
  assert.equal(response.isError, undefined);
  assert.equal(JSON.parse(response.content[0].text).ready, 0);
  budget.setRule({
    connection_id: connection.id,
    action: "snapshot",
    decision: "deny",
  });
  response = await call();
  assert.equal(JSON.parse(response.content[0].text).code, "PERMISSION_DENIED");
  const deniedExport = await client.callTool({
    name: "exportar_presupuesto",
    arguments: { format: "json" },
  });
  assert.equal(
    JSON.parse(deniedExport.content[0].text).code,
    "PERMISSION_DENIED",
  );
  budget.setRule({
    connection_id: connection.id,
    action: "export",
    decision: "allow",
  });
  const exported = await client.callTool({
    name: "exportar_presupuesto",
    arguments: { format: "json" },
  });
  assert.equal(exported.isError, undefined);
  assert.equal(
    JSON.parse(JSON.parse(exported.content[0].text).content).currency,
    "PYG",
  );
  for (const folder of ["src", "public", "views"])
    for (const file of readdirSync(folder, { recursive: true })) {
      const source = path.join(folder, file);
      if (statSync(source).isFile())
        assert.deepEqual(
          readFileSync(source),
          readFileSync(path.join(runtime, source)),
          source,
        );
    }
  console.log(
    "INSTALLED MCP OK: " +
      version +
      ", 23 tools, private credential, default deny, explicit read, live denial, installed application matches checkout.",
  );
} finally {
  await client.close();
  budget.close();
  rmSync(dir, { recursive: true, force: true });
}
