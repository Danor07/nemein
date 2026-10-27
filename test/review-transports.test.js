import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openBudget } from "../src/core.js";
import { createApp } from "../src/server.js";
const options = { from: "2026-01-01", to: "2026-01-15", as_of: "2026-01-15" };
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "review-transport-")),
    b = openBudget(dir),
    c = b.createConnection({ label: "Workflow" });
  t.after(() => {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    BUDGET_DATA_DIR: dir,
    BUDGET_AGENT_TOKEN: c.token,
    BUDGET_AGENT_TOKEN_FILE: "",
    BUDGET_AGENT_VERSION: "1",
  };
  return { b, c, env };
}
test("review workflow runs through installed-style CLI and MCP generic actions", async (t) => {
  const { b, c, env } = fixture(t);
  const run = (action, args) =>
    spawnSync(process.execPath, ["src/cli.js", action, "--stdin"], {
      env,
      input: JSON.stringify(args),
      encoding: "utf8",
      timeout: 15000,
    });
  assert.equal(run("review-package", options).status, 1);
  for (const action of [
    "review-package",
    "review-save",
    "review-list",
    "review-get",
  ])
    b.setRule({ connection_id: c.id, action, decision: "allow" });
  const result = run("review-package", options);
  assert.equal(result.status, 0, result.stderr);
  const p = JSON.parse(result.stdout).result;
  const saved = run("review-save", {
    id: "cli",
    package: p,
    report: "CLI report",
    generator: "Fixture",
  });
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(
    JSON.parse(run("review-get", { id: "cli" }).stdout).result.reviewed_at,
    null,
  );
  assert.equal(run("review-mark", { id: "cli" }).status, 1);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/mcp.js"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "review-test", version: "1" });
  try {
    await client.connect(transport);
    const call = async (action, args) =>
      client.callTool({
        name: "ejecutar_accion",
        arguments: { action, arguments: args },
      });
    const packet = await call("review-package", options);
    assert.equal(packet.isError, undefined);
    assert.deepEqual(JSON.parse(packet.content[0].text), p);
    const report = await call("review-save", {
      id: "mcp",
      package: p,
      report: "MCP report",
      generator: "Fixture",
    });
    assert.equal(report.isError, undefined);
    const got = await call("review-get", { id: "mcp" });
    assert.equal(JSON.parse(got.content[0].text).generated_by, c.id);
    b.revokeConnection(c.id);
    assert.equal((await call("review-get", { id: "mcp" })).isError, true);
  } finally {
    await client.close();
  }
});
test("review window escapes AI text, shows evidence, and marks only on explicit CSRF-protected POST", async (t) => {
  const { b } = fixture(t),
    packageData = b.reviewPackage(options);
  b.saveReview({
    id: "hostile",
    package: packageData,
    report:
      "<script>alert(1)</script> https://evil.example [link](https://evil.example)",
    generator: "<b>model</b>",
  });
  const server = createApp(b).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    const response = await fetch(base + "/?view=reviews&review=hostile");
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;b&gt;model/);
    assert.equal(html.includes("<script>alert"), false);
    assert.equal(html.includes('href="https://evil'), false);
    assert.match(html, /Cobertura de extractos no declarada/);
    assert.match(html, /Paquete completo conservado/);
    assert.equal(b.getReview({ id: "hostile" }).reviewed_at, null);
    const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
    const post = (body) =>
      fetch(base + "/action/review-mark", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: base,
        },
        body: new URLSearchParams(body),
        redirect: "manual",
      });
    assert.equal((await post({ id: "hostile" })).status, 403);
    assert.equal(
      (await post({ id: "hostile", _csrf: csrf, view: "reviews" })).status,
      302,
    );
    assert.ok(b.getReview({ id: "hostile" }).reviewed_at);
    const list = await (await fetch(base + "/?view=reviews")).text();
    assert.match(list, /Historial/);
    assert.match(list, /Revisado/);
    const created = await fetch(base + "/action/review-create", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: base,
      },
      body: new URLSearchParams({ ...options, _csrf: csrf, view: "reviews" }),
      redirect: "manual",
    });
    assert.equal(created.status, 302);
    assert.equal(b.listReviews().total, 2);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
