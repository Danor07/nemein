import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedAgentConfig } from "../src/agent-config.js";
import { openBudget } from "../src/core.js";
import { createApp } from "../src/server.js";
import { fakeInstall } from "./helpers/installed.js";
test("MCP config requires token and complete installed runtime outside development trees", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installed = path.join(dir, "Installed"),
    data = path.join(dir, "budget");
  fakeInstall(installed);
  const options = {
    installDirs: [installed],
    agentTokenFile: path.join(dir, "credential.env"),
  };
  assert.equal(installedAgentConfig(data, { installDirs: [installed] }), null);
  const cfg = installedAgentConfig(data, options);
  assert.equal(
    cfg.mcpServers.nemein.command,
    path.join(installed, "runtime", "node.exe"),
  );
  assert.deepEqual(cfg.mcpServers.nemein.args, [
    path.join(installed, "runtime", "src", "mcp.js"),
  ]);
  assert.equal(cfg.mcpServers.nemein.env.BUDGET_AGENT_TOKEN, undefined);
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
      installedAgentConfig(data, {
        installDirs: [dev],
        agentTokenFile: path.join(dir, "credential.env"),
      }),
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
      () =>
        budget
          .forAgent(
            readFileSync(cfg.env.BUDGET_AGENT_TOKEN_FILE, "utf8")
              .trim()
              .split("=")[1],
          )
          .snapshot(),
      (e) => e.code === "PERMISSION_DENIED",
    );
    const revisit = await (await fetch(base + "/?view=access")).text();
    assert.equal(cfg.env.BUDGET_AGENT_TOKEN, undefined);
    assert.ok(
      !html.includes(
        readFileSync(cfg.env.BUDGET_AGENT_TOKEN_FILE, "utf8")
          .trim()
          .split("=")[1],
      ),
    );
    assert.ok(!revisit.includes("connection.env"));
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

test("MCP refuses MSIX LocalCache installations", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-msix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installed = path.join(
    dir,
    "AppData",
    "Local",
    "Packages",
    "OpenAI.Codex_test",
    "LocalCache",
    "Local",
    "Nemein",
  );
  fakeInstall(installed);
  assert.equal(
    installedAgentConfig(dir, {
      installDirs: [installed],
      agentTokenFile: path.join(dir, "credential.env"),
    }),
    null,
  );
});

test("MCP config enforces all installed files and private-reader version", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-config-edges-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [i, missing] of [
    "nemein.exe",
    "uninstall.exe",
    "runtime/node.exe",
    "runtime/src/mcp.js",
    "runtime/src/access.js",
    "runtime/src/credentials.js",
  ].entries()) {
    const installed = path.join(dir, "missing-" + i);
    fakeInstall(installed);
    rmSync(path.join(installed, missing));
    assert.equal(
      installedAgentConfig(dir, {
        installDirs: [installed],
        agentTokenFile: "file",
      }),
      null,
      missing,
    );
  }
  for (const [version, expected] of [
    ["0.1.99", false],
    ["0.2.1", false],
    ["0.2.2", true],
    ["0.2.3", true],
    ["0.3.0", true],
    ["1.0.0", true],
    ["", false],
  ]) {
    const installed = path.join(dir, "version-" + (version || "empty"));
    fakeInstall(installed);
    writeFileSync(
      path.join(installed, "runtime", "package.json"),
      JSON.stringify({ name: "nemein", version }),
    );
    assert.equal(
      !!installedAgentConfig(dir, {
        installDirs: [installed],
        agentTokenFile: "file",
      }),
      expected,
      version,
    );
  }
  const nested = path.join(dir, "repo", "nested");
  fakeInstall(nested);
  mkdirSync(path.join(dir, "repo", ".git"));
  assert.equal(
    installedAgentConfig(dir, {
      installDirs: [nested],
      agentTokenFile: "file",
    }),
    null,
  );
  const bad = path.join(dir, "bad-json");
  fakeInstall(bad);
  writeFileSync(path.join(bad, "runtime", "package.json"), "not json");
  assert.equal(
    installedAgentConfig(dir, { installDirs: [bad], agentTokenFile: "file" }),
    null,
  );
});
test("Windows install discovery queries both registry hives without shell execution", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-registry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  fakeInstall(dir);
  const script =
    'import assert from "node:assert/strict";import child from "node:child_process";import {syncBuiltinESMExports} from "node:module";import path from "node:path";\nconst calls=[];\nchild.spawnSync=(command,args,options)=>{calls.push({command,args,options});return {stdout:args[1].startsWith("HKLM")?\'InstallLocation    REG_SZ    "\'+process.argv[2]+\'"\\r\\n\':""};};\nsyncBuiltinESMExports();Object.defineProperty(process,"platform",{value:"win32"});\nprocess.env.NEMEIN_INSTALL_DIR=path.join(process.argv[2],"missing");\nprocess.env.LOCALAPPDATA=path.join(process.argv[2],"missing");\nprocess.env.ProgramFiles=path.join(process.argv[2],"missing");\nconst {installedAgentConfig}=await import(process.argv[1]);\nconst cfg=installedAgentConfig(process.argv[2],{agentTokenFile:path.join(process.argv[2],"secret.env"),connectionVersion:"revision-2"});\nassert.ok(cfg);assert.equal(cfg.mcpServers.nemein.env.BUDGET_AGENT_VERSION,"revision-2");assert.equal(calls.length,2);\nfor(const call of calls){assert.equal(call.command,"reg.exe");assert.deepEqual(call.args.slice(0,1),["query"]);assert.equal(call.args[1].includes("\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\Nemein"),true);assert.deepEqual(call.args.slice(2),["/v","InstallLocation"]);assert.equal(call.options.windowsHide,true);assert.equal(call.options.timeout,2000);}\n';
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      new URL("../src/agent-config.js", import.meta.url).href,
      dir,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
});

test("install discovery handles each fallback and missing registry output", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-fallback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const relative of [
    "Installed",
    "Local/Nemein",
    "Programs/Nemein",
    "Stryker was here",
  ])
    fakeInstall(path.join(dir, relative));
  const script =
    'import assert from "node:assert/strict";import child from "node:child_process";import {syncBuiltinESMExports} from "node:module";import path from "node:path";\nlet stdout="";\nconst calls=[];child.spawnSync=(command,args,options)=>{calls.push({command,args,options});return {stdout};};syncBuiltinESMExports();\nObject.defineProperty(process,"platform",{value:"win32",configurable:true});\nconst {installedAgentConfig}=await import(process.argv[1]),dir=process.argv[2];\nconst resolve=options=>installedAgentConfig(dir,{agentTokenFile:"file",...options});\nfunction reset(){delete process.env.NEMEIN_INSTALL_DIR;delete process.env.LOCALAPPDATA;delete process.env.ProgramFiles;stdout=undefined;calls.length=0;}\nreset();assert.ok(resolve({runtimeRoot:path.join(dir,"Installed","runtime")}));\nreset();process.env.NEMEIN_INSTALL_DIR=path.join(dir,"Installed");assert.ok(resolve({}));\nreset();process.env.LOCALAPPDATA=path.join(dir,"Local");assert.ok(resolve({}));\nreset();process.env.ProgramFiles=path.join(dir,"Programs");assert.ok(resolve({}));\nreset();stdout=\'InstallLocation    REG_SZ    "\'+path.join(dir,"Installed")+\'"  \\r\\n\';assert.ok(resolve({}));\nassert.deepEqual(calls.map(c=>c.args[1].split("\\\\")[0]),["HKCU","HKLM"]);assert.ok(calls.every(c=>c.options.encoding==="utf8"));\nreset();Object.defineProperty(process,"platform",{value:"linux"});assert.equal(resolve({}),null);assert.equal(calls.length,0);';
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      new URL("../src/agent-config.js", import.meta.url).href,
      dir,
    ],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
});
test("config rejects redirected runtime, source directories and wrong package identity", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-redirect-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outside = path.join(dir, "outside");
  fakeInstall(outside);
  for (const component of ["runtime", "runtime/src"]) {
    const installed = path.join(dir, component.replace("/", "-"));
    fakeInstall(installed);
    const target = path.join(installed, component);
    rmSync(target, { recursive: true, force: true });
    symlinkSync(
      path.join(outside, component),
      target,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(
      installedAgentConfig(dir, {
        installDirs: [installed],
        agentTokenFile: "file",
      }),
      null,
      component,
    );
  }
  const wrong = path.join(dir, "wrong");
  fakeInstall(wrong);
  writeFileSync(
    path.join(wrong, "runtime", "package.json"),
    JSON.stringify({ name: "other", version: "0.2.2" }),
  );
  assert.equal(
    installedAgentConfig(dir, { installDirs: [wrong], agentTokenFile: "file" }),
    null,
  );
  for (const version of ["-1.2.2", "-1.3.0", "0.0.2", "0.1.2"]) {
    writeFileSync(
      path.join(wrong, "runtime", "package.json"),
      JSON.stringify({ name: "nemein", version }),
    );
    assert.equal(
      installedAgentConfig(dir, {
        installDirs: [wrong],
        agentTokenFile: "file",
      }),
      null,
    );
  }
});

test("config rejects a Node executable symlink outside its runtime", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-node-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installed = path.join(dir, "Installed");
  fakeInstall(installed);
  const outside = path.join(dir, "node.exe");
  writeFileSync(outside, "fixture");
  rmSync(path.join(installed, "runtime", "node.exe"));
  try {
    symlinkSync(outside, path.join(installed, "runtime", "node.exe"), "file");
  } catch (e) {
    if (process.platform === "win32" && e.code === "EPERM") {
      t.skip(
        "Windows does not grant file-symlink creation; Linux CI covers this boundary.",
      );
      return;
    }
    throw e;
  }
  assert.equal(
    installedAgentConfig(dir, {
      installDirs: [installed],
      agentTokenFile: "file",
    }),
    null,
  );
});
