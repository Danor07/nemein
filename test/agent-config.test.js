import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedAgentConfig } from "../src/agent-config.js";
function fakeInstall(root) {
  mkdirSync(path.join(root, "runtime", "src"), { recursive: true });
  for (const f of [
    "nemein.exe",
    "uninstall.exe",
    "runtime/node.exe",
    "runtime/src/mcp.js",
  ])
    writeFileSync(path.join(root, f), "fixture");
  writeFileSync(
    path.join(root, "runtime", "package.json"),
    JSON.stringify({ name: "nemein" }),
  );
}
test("MCP exports complete installed runtimes and rejects development trees", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installed = path.join(dir, "Installed"),
    data = path.join(dir, "budget");
  fakeInstall(installed);
  const cfg = installedAgentConfig(data, { installDirs: [installed] });
  assert.equal(
    cfg.mcpServers.nemein.command,
    path.join(installed, "runtime", "node.exe"),
  );
  assert.deepEqual(cfg.mcpServers.nemein.args, [
    path.join(installed, "runtime", "src", "mcp.js"),
  ]);
  assert.equal(cfg.mcpServers.nemein.env.BUDGET_DATA_DIR, data);
  for (const folder of [
    "src-tauri/target/release",
    "desktop-resources",
    "repo",
  ]) {
    const development = path.join(dir, folder);
    fakeInstall(development);
    if (folder === "repo") mkdirSync(path.join(development, ".git"));
    assert.equal(
      installedAgentConfig(data, { installDirs: [development] }),
      null,
    );
  }
  rmSync(path.join(installed, "uninstall.exe"));
  assert.equal(installedAgentConfig(data, { installDirs: [installed] }), null);
  assert.equal(
    installedAgentConfig(data, { installDirs: [path.join(dir, "missing")] }),
    null,
  );
});

import { openBudget } from "../src/core.js";
import { createApp } from "../src/server.js";
test("MCP export is unavailable without installation and UI explains how to proceed", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-not-installed-"));
  const budget = openBudget(dir),
    server = createApp(budget, { installationRoots: [] }).listen(
      0,
      "127.0.0.1",
    );
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    const response = await fetch(base + "/agent-config");
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "NEMEIN_NOT_INSTALLED");
    const page = await fetch(base + "/?view=agents");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes("Instalá Nemein con su instalador"));
    assert.ok(!html.includes("data-mcp-download"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    budget.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
