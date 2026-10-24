import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedAgentConfig } from "../src/agent-config.js";
import { openBudget } from "../src/core.js";
import { createApp } from "../src/server.js";
import { fakeInstall } from "./helpers/installed.js";
const token = "a".repeat(64);
test("MCP config requires token and complete installed runtime outside development trees", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installed = path.join(dir, "Installed"),
    data = path.join(dir, "budget");
  fakeInstall(installed);
  const options = { installDirs: [installed], agentToken: token };
  assert.equal(installedAgentConfig(data, { installDirs: [installed] }), null);
  const cfg = installedAgentConfig(data, options);
  assert.equal(
    cfg.mcpServers.nemein.command,
    path.join(installed, "runtime", "node.exe"),
  );
  assert.equal(cfg.mcpServers.nemein.env.BUDGET_AGENT_TOKEN, token);
  assert.equal(cfg.mcpServers.nemein.env.BUDGET_AGENT_VERSION, "1");
  for (const folder of [
    "src-tauri/target/release",
    "desktop-resources",
    "repo",
  ]) {
    const dev = path.join(dir, folder);
    fakeInstall(dev);
    if (folder === "repo") mkdirSync(path.join(dev, ".git"));
    assert.equal(
      installedAgentConfig(data, { installDirs: [dev], agentToken: token }),
      null,
    );
  }
  rmSync(path.join(installed, "uninstall.exe"));
  assert.equal(installedAgentConfig(data, options), null);
});
test("UI creates a default-deny connection and downloads its one-time configuration with CSRF", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-connection-")),
    budget = openBudget(dir),
    installed = path.join(dir, "Installed");
  fakeInstall(installed);
  const server = createApp(budget, { installationRoots: [installed] }).listen(
    0,
    "127.0.0.1",
  );
  await new Promise((resolve) => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    let html = await (await fetch(base + "/?view=access")).text();
    const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
    assert.equal((await fetch(base + "/agent-config")).status, 400);
    assert.equal(
      (
        await fetch(base + "/action/connection-create", {
          method: "POST",
          body: new URLSearchParams({ label: "Denied" }),
        })
      ).status,
      403,
    );
    const response = await fetch(base + "/action/connection-create", {
      method: "POST",
      body: new URLSearchParams({
        _csrf: csrf,
        view: "access",
        label: "My client",
        version: "1",
      }),
    });
    assert.equal(response.status, 200);
    html = await response.text();
    const exportId = html.match(/name="export_id" value="([^"]+)"/)[1];
    const download = await fetch(base + "/agent-config", {
      method: "POST",
      body: new URLSearchParams({ _csrf: csrf, export_id: exportId }),
    });
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition"), /attachment/);
    const cfg = (await download.json()).mcpServers.nemein;
    assert.equal(cfg.command, path.join(installed, "runtime", "node.exe"));
    assert.equal(cfg.env.BUDGET_DATA_DIR, dir);
    assert.throws(
      () => budget.forAgent(cfg.env.BUDGET_AGENT_TOKEN).snapshot(),
      (e) => e.code === "PERMISSION_DENIED",
    );
    const revisit = await (await fetch(base + "/?view=access")).text();
    assert.ok(!revisit.includes(cfg.env.BUDGET_AGENT_TOKEN));
    assert.equal(
      (
        await fetch(base + "/agent-config", {
          method: "POST",
          body: new URLSearchParams({ _csrf: csrf, export_id: "missing" }),
        })
      ).status,
      410,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    budget.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("UI explains upgrade when a connection has no supported installation", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-not-installed-")),
    budget = openBudget(dir);
  const server = createApp(budget, { installationRoots: [] }).listen(
    0,
    "127.0.0.1",
  );
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    const page = await (await fetch(base + "/?view=access")).text(),
      csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
    const response = await fetch(base + "/action/connection-create", {
      method: "POST",
      body: new URLSearchParams({
        _csrf: csrf,
        view: "access",
        label: "Needs installation",
      }),
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(html.includes("Instalá o actualizá Nemein"));
    assert.ok(!html.includes('name="export_id"'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    budget.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
