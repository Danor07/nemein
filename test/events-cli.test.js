import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openBudget } from "../src/core.js";
import { watchEvents, parseWatchFlags } from "../src/watch.js";

const tokens = new Map();
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-watch-"));
  const b = openBudget(dir);
  const connection = b.createConnection({ label: "Event fixture" });
  tokens.set(dir, connection.token);
  for (const action of ["event-snapshot", "events"])
    b.setRule({ connection_id: connection.id, action, decision: "allow" });
  const agent = b.forAgent(connection.token);
  t.after(() => {
    if (b.db.open) b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, b, agent, connection };
}
const run = (dir, args, grant = "1", input) =>
  spawnSync(process.execPath, ["src/cli.js", ...args], {
    env: {
      ...process.env,
      BUDGET_DATA_DIR: dir,
      BUDGET_AGENT_TOKEN: grant === "1" ? tokens.get(dir) || "" : "",
      BUDGET_AGENT_VERSION: "1",
      BUDGET_MCP_WRITE: "1",
    },
    encoding: "utf8",
    timeout: 10000,
    input,
  });

test("CLI: events denied before opening data; explicit read grant and stable errors", (t) => {
  const { dir, b } = fixture(t);
  const missing = path.join(dir, "denied");
  const denied = run(missing, ["event-snapshot"], "0");
  assert.equal(denied.status, 1);
  assert.equal(JSON.parse(denied.stderr).code, "AUTH_REQUIRED");
  assert.equal(existsSync(missing), false);
  const snapshot = run(dir, ["event-snapshot", '{"month":"2026-01"}']);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  const cut = JSON.parse(snapshot.stdout).result;
  b.createGroup({ name: "After snapshot" });
  const page = run(dir, ["events", JSON.stringify({ after: cut.cursor })]);
  assert.equal(page.status, 0, page.stderr);
  assert.equal(JSON.parse(page.stdout).result.events.length, 1);
  const invalid = run(dir, ["events", '{"after":"bad!"}']);
  assert.equal(JSON.parse(invalid.stderr).code, "INVALID_CURSOR");
  const help = run(dir, ["help"], "0");
  assert.ok(JSON.parse(help.stdout).commands.includes("watch"));
});

test("CLI watch: NDJSON/JSON-seq, bounded once, file-compatible JSON and strict options", (t) => {
  const { dir, b } = fixture(t);
  const after = b.eventSnapshot().cursor;
  for (let i = 0; i < 3; i++) b.createGroup({ name: "Group " + i });
  const first = run(dir, ["watch", "--after", after, "--limit", "2", "--once"]);
  assert.equal(first.status, 0, first.stderr);
  const rows = first.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 2);
  const second = run(dir, [
    "watch",
    JSON.stringify({ after: rows[1].cursor, format: "json-seq", once: true }),
  ]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout[0], "\x1e");
  const tail = JSON.parse(second.stdout.slice(1));
  assert.notEqual(tail.event.id, rows[1].event.id);
  const request = JSON.stringify({ after: tail.cursor, once: true });
  const requestFile = path.join(dir, "watch-request.json");
  writeFileSync(requestFile, request);
  assert.equal(run(dir, ["watch", "--file", requestFile]).status, 0);
  assert.equal(run(dir, ["watch", "--stdin"], "1", request).status, 0);
  const empty = run(dir, ["watch", "--after", tail.cursor, "--once"]);
  assert.equal(empty.stdout, "");
  for (const args of [
    ["--after", after, "--unknown"],
    ["--after"],
    ["--after", after, "--limit", "1.5"],
    ["--after", after, "--poll-ms", "0"],
    ["--after", after, "--after", after],
  ]) {
    const result = run(dir, ["watch", ...args]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, "INVALID_WATCH_OPTIONS");
  }
  assert.throws(
    () => parseWatchFlags(["--once"]),
    (e) => e.code === "INVALID_WATCH_OPTIONS",
  );
});

test(
  "CLI watch: sees commits from another process while polling, then stops",
  { timeout: 10000 },
  async (t) => {
    const { dir, b } = fixture(t),
      after = b.eventSnapshot().cursor;
    b.createGroup({ name: "First" });
    const child = spawn(
      process.execPath,
      ["src/cli.js", "watch", "--after", after, "--poll-ms", "100"],
      {
        env: {
          ...process.env,
          BUDGET_DATA_DIR: dir,
          BUDGET_AGENT_TOKEN: tokens.get(dir),
          BUDGET_AGENT_VERSION: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const closed = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    let stopped = false;
    t.after(async () => {
      if (!stopped) {
        child.kill();
        await closed;
      }
    });
    let output = "",
      stderr = "",
      secondWritten = false;
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const received = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const lines = output.trim().split("\n").filter(Boolean);
        if (lines.length >= 1 && !secondWritten) {
          secondWritten = true;
          b.createGroup({ name: "Second" });
        }
        if (lines.length >= 2) resolve(lines.map(JSON.parse));
      });
      child.once("close", () =>
        reject(Error("watch terminó antes de recibir eventos: " + stderr)),
      );
    });
    const rows = await received;
    assert.equal(new Set(rows.map((x) => x.event.id)).size, 2);
    child.kill("SIGTERM");
    await closed;
    stopped = true;
  },
);

test("watch: slow output, cancellation and policy checked every page", async (t) => {
  const { b, agent, connection } = fixture(t),
    after = b.eventSnapshot().cursor;
  for (let i = 0; i < 3; i++) b.createGroup({ name: "Slow " + i });
  const controller = new AbortController();
  let release,
    calls = 0;
  const watching = watchEvents(
    agent,
    { after, limit: 1, poll_ms: 100 },
    {
      signal: controller.signal,
      write: () => {
        calls++;
        return new Promise((resolve) => (release = resolve));
      },
    },
  );
  await setTimeout(20);
  assert.equal(calls, 1);
  controller.abort();
  release();
  await watching;
  await assert.rejects(
    watchEvents(
      agent,
      { after, limit: 1 },
      {
        write: async () =>
          b.setRule({
            connection_id: connection.id,
            action: "events",
            decision: "deny",
          }),
      },
    ),
    (e) => e.code === "PERMISSION_DENIED",
  );
});
test("MCP: event tools require a separate read grant and do not enable mutations", async (t) => {
  const { b, dir } = fixture(t);
  const client = new Client({ name: "event-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("src/mcp.js")],
    env: {
      ...process.env,
      BUDGET_DATA_DIR: dir,
      BUDGET_AGENT_TOKEN: tokens.get(dir),
      BUDGET_AGENT_VERSION: "1",
      BUDGET_MCP_WRITE: "0",
    },
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some((x) => x.name === "snapshot_eventos"));
    assert.ok(tools.some((x) => x.name === "eventos"));
    const denied = await client.callTool({
      name: "registrar_movimiento",
      arguments: {
        account_id: 1,
        date: "2026-01-01",
        payee: "Denied",
        amount: 1,
      },
    });
    assert.equal(denied.isError, true);
    const snap = await client.callTool({
      name: "snapshot_eventos",
      arguments: { month: "2026-01" },
    });
    assert.equal(snap.isError, undefined);
    const cut = JSON.parse(snap.content[0].text);
    b.createGroup({ name: "MCP event" });
    const page = await client.callTool({
      name: "eventos",
      arguments: { after: cut.cursor, limit: 1 },
    });
    assert.equal(page.isError, undefined);
    assert.equal(
      JSON.parse(page.content[0].text).events[0].event.data.operation,
      "createGroup",
    );
  } finally {
    await client.close();
  }
});

test(
  "CLI watch: closed output pipe exits without error or further delivery",
  { timeout: 10000 },
  async (t) => {
    const { dir, b } = fixture(t),
      after = b.eventSnapshot().cursor;
    b.createGroup({ name: "Before closed pipe" });
    const child = spawn(
      process.execPath,
      ["src/cli.js", "watch", "--after", after, "--poll-ms", "100"],
      {
        env: {
          ...process.env,
          BUDGET_DATA_DIR: dir,
          BUDGET_AGENT_TOKEN: tokens.get(dir),
          BUDGET_AGENT_VERSION: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const timer = globalThis.setTimeout(() => child.kill(), 5000);
    try {
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () => {
          child.stdout.destroy();
          resolve();
        });
      });
      b.createGroup({ name: "After closed pipe" });
      const result = await closed;
      assert.equal(result.code, 0, stderr);
      assert.equal(stderr, "");
    } finally {
      globalThis.clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await closed;
      }
    }
  },
);
