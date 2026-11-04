import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";

// Runs only in the `Connector sandbox (Windows)` CI job, which builds the real
// supervisor and a hostile component and points these variables at them.
const binary = process.env.NEMEIN_CONNECTOR_CHAIN_BIN;
const component = process.env.NEMEIN_CONNECTOR_CHAIN_COMPONENT;
const runner = new URL("../src/connector-runner.js", import.meta.url).href;

function children(parent) {
  const out = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent} AND Name='nemein-connector.exe'" | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  return out.split(/\s+/).filter(Boolean).map(Number);
}

async function child(parent) {
  for (let i = 0; i < 100; i++) {
    const [pid] = children(parent);
    if (pid) return pid;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("no apareció el proceso hijo de " + parent);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid, ms) {
  for (let waited = 0; waited < ms; waited += 100) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

test(
  "connector chain: killing Node ends the supervisor and the enclosed worker",
  { skip: !binary && "sólo en el job Connector sandbox (Windows)" },
  async () => {
    const script = `
      import { readFileSync } from "node:fs";
      import { runConnector } from ${JSON.stringify(runner)};
      runConnector({
        op: "parse",
        component: readFileSync(${JSON.stringify(component)}),
        config: "hang",
        accountId: "1",
        command: ${JSON.stringify(binary)},
        timeoutMs: 600000,
      }).catch(() => {});
      setInterval(() => {}, 1000);`;
    const node = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    try {
      const supervisor = await child(node.pid);
      const worker = await child(supervisor);
      assert.ok(alive(supervisor) && alive(worker));
      node.kill();
      assert.ok(
        await gone(supervisor, 5000),
        "the supervisor saw EOF and ended",
      );
      assert.ok(await gone(worker, 5000), "KILL_ON_JOB_CLOSE ended the worker");
    } finally {
      node.kill();
    }
  },
);
