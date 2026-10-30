import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { apiFixture } from "./helpers/local-api.js";
import { schemaValidator } from "./helpers/openapi-schemas.js";
import { generateOpenApi } from "../src/openapi.js";
import { apiLimits } from "../src/local-api-contract.js";

const envelope = (args) => ({ arguments: args });
const code = (response, expected, status) => {
  assert.equal(response.status, status);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, expected);
  assert.ok(response.body.error.message.length > 0);
};

test("Production startup enables HTTP explicitly and closes with the native parent", async (t) => {
  const { dir, connection } = await apiFixture(t, false);
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      BUDGET_DATA_DIR: dir,
      BUDGET_LOCAL_API: "1",
      BUDGET_DESKTOP: "1",
      PORT: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("No startup URL: " + errors)),
        15000,
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = /BUDGET_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error("Startup exited: " + errors));
      });
    });
    const response = await fetch(url + "/api/v1/permissions", {
      signal: AbortSignal.timeout(2000),
      method: "POST",
      headers: {
        Authorization: "Bearer " + connection.token,
        "Content-Type": "application/json",
      },
      body: '{"arguments":{}}',
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.connection_id, connection.id);
  } finally {
    child.stdin.end();
    assert.equal(await exited, 0, errors);
  }
});

test("API is opt-in; its document and all operations require a connection", async (t) => {
  const disabled = await apiFixture(t, false);
  code(
    await disabled.send("openapi.json", {}, { method: "GET" }),
    "API_DISABLED",
    404,
  );
  const { send, connection, budget, rule } = await apiFixture(t);
  const absent = await send(
    "openapi.json",
    {},
    { method: "GET", headers: { Authorization: "" } },
  );
  code(absent, "AUTH_REQUIRED", 401);
  assert.equal(absent.headers["www-authenticate"], "Bearer");
  code(await send("snapshot"), "PERMISSION_DENIED", 403);
  const permissions = await send("permissions");
  assert.equal(permissions.body.result.connection_id, connection.id);
  assert.ok(
    Object.values(permissions.body.result.actions).every(
      (p) => p.decision === "deny",
    ),
  );
  rule("event-snapshot");
  const state = await send("event-snapshot", envelope({ month: "2026-10" }));
  assert.equal(state.status, 200);
  assert.ok(state.body.result.cursor);
  assert.equal(state.headers["cache-control"], "no-store");
  assert.equal(state.headers["x-content-type-options"], "nosniff");
  assert.equal(state.headers["referrer-policy"], "no-referrer");
  assert.equal(state.headers["access-control-allow-origin"], undefined);
  budget.rotateConnection(connection.id);
  code(await send("permissions"), "AUTH_REQUIRED", 401);
});

test("Host/Origin guard applies to GET and POST, ignores proxy headers, has no CORS", async (t) => {
  const { send, port } = await apiFixture(t);
  for (const method of ["GET", "POST"]) {
    const action = method === "GET" ? "openapi.json" : "permissions";
    for (const Host of [
      "localhost:" + port,
      "127.0.0.2:" + port,
      "evil.example:" + port,
      "127.0.0.1:1",
      "[::1]:" + port,
    ])
      code(
        await send(action, envelope({}), {
          method,
          headers: { Host, "X-Forwarded-Host": "127.0.0.1:" + port },
        }),
        "INVALID_HOST",
        403,
      );
    for (const Origin of [
      "null",
      "https://127.0.0.1:" + port,
      "http://evil.example",
      "http://127.0.0.1:" + port + "/",
      "http://127.0.0.1:1",
    ])
      code(
        await send(action, envelope({}), { method, headers: { Origin } }),
        "INVALID_ORIGIN",
        403,
      );
    assert.equal(
      (
        await send(action, envelope({}), {
          method,
          headers: { Origin: "http://127.0.0.1:" + port },
        })
      ).status,
      200,
    );
  }
  const preflight = await send(
    "permissions",
    {},
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://remote.example",
        "Access-Control-Request-Headers": "authorization",
      },
    },
  );
  code(preflight, "INVALID_ORIGIN", 403);
  assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  code(
    await send("permissions", {}, { method: "OPTIONS" }),
    "METHOD_NOT_ALLOWED",
    405,
  );
});

test("No ambient credentials, duplicate headers, version ambiguity or query strings", async (t) => {
  const { send, connection, port, budget } = await apiFixture(t);
  for (const Authorization of [
    "",
    connection.token,
    "Basic " + connection.token,
    "Bearer " + "0".repeat(64),
    "Bearer " + connection.token + ", Bearer " + connection.token,
  ])
    code(
      await send(
        "permissions",
        { arguments: {}, token: connection.token },
        { headers: { Authorization, Cookie: "token=" + connection.token } },
      ),
      "AUTH_REQUIRED",
      401,
    );
  code(
    await send("permissions?token=" + connection.token),
    "INVALID_REQUEST",
    400,
  );
  code(await send("permissions?"), "INVALID_REQUEST", 400);
  code(
    await send("permissions", envelope({}), {
      headers: { "Nemein-Connection-Version": "2" },
    }),
    "VERSION_MISMATCH",
    409,
  );
  code(
    await send("permissions", envelope({}), {
      headers: { "Nemein-Connection-Version": "bad version" },
    }),
    "VERSION_MISMATCH",
    409,
  );
  for (const name of [
    "Host",
    "Authorization",
    "Origin",
    "Nemein-Connection-Version",
    "Content-Type",
    "Content-Encoding",
  ]) {
    const headers = [
      "Host",
      "127.0.0.1:" + port,
      "Authorization",
      "Bearer " + connection.token,
      "Content-Type",
      "application/json",
    ];
    if (!headers.includes(name))
      headers.push(name, name === "Origin" ? "http://127.0.0.1:" + port : "1");
    headers.push(name, "duplicate");
    code(
      await send("permissions", envelope({}), { rawHeaders: headers }),
      "INVALID_REQUEST",
      400,
    );
  }
  budget.changeConnectionVersion({ id: connection.id, version: "2.1" });
  assert.equal(
    (
      await send("permissions", envelope({}), {
        headers: { "Nemein-Connection-Version": "2.1" },
      })
    ).status,
    200,
  );
  budget.revokeConnection(connection.id);
  code(
    await send("permissions", envelope({}), {
      headers: { "Nemein-Connection-Version": "2.1" },
    }),
    "AUTH_REQUIRED",
    401,
  );
});

test("Malformed, compressed, enormous and non-JSON bodies never reach an action", async (t) => {
  const { send, budget, rule } = await apiFixture(t);
  rule("group");
  const before = budget.eventSnapshot().cursor;
  const json = JSON.stringify(envelope({}));
  const atLimit =
    json + " ".repeat(apiLimits.bodyBytes - Buffer.byteLength(json));
  assert.equal((await send("permissions", {}, { raw: atLimit })).status, 200);
  code(
    await send("permissions", {}, { raw: atLimit + " " }),
    "BODY_TOO_LARGE",
    413,
  );
  for (const raw of ["{", "null", "true", '"text"', '{"arguments":{},}'])
    code(await send("group", {}, { raw }), "INVALID_JSON", 400);
  for (const body of [
    [],
    {},
    { arguments: [] },
    { arguments: null },
    { arguments: {}, _csrf: "fake" },
    { arguments: {}, base: "a".repeat(1025) },
  ])
    code(await send("group", body), "INVALID_REQUEST", 400);
  code(
    await send("group", envelope({ name: "fixture" }), {
      headers: { "Content-Type": "text/plain" },
    }),
    "UNSUPPORTED_MEDIA_TYPE",
    415,
  );
  code(
    await send("group", envelope({ name: "fixture" }), {
      headers: { "Content-Type": "application/json; charset=iso-8859-1" },
    }),
    "UNSUPPORTED_MEDIA_TYPE",
    415,
  );
  code(
    await send("group", envelope({ name: "fixture" }), {
      headers: { "Content-Encoding": "gzip" },
    }),
    "UNSUPPORTED_MEDIA_TYPE",
    415,
  );
  code(
    await send("group", envelope({ name: "x".repeat(apiLimits.bodyBytes) })),
    "BODY_TOO_LARGE",
    413,
  );
  code(
    await send("group", envelope({ name: "ok", requireBase: false })),
    "INVALID_ARGUMENTS",
    400,
  );
  code(await send("nonexistent"), "NOT_FOUND", 404);
  code(
    await send("permissions", {}, { method: "GET" }),
    "METHOD_NOT_ALLOWED",
    405,
  );
  code(await send("openapi.json"), "METHOD_NOT_ALLOWED", 405);
  assert.equal(budget.eventSnapshot().cursor, before);
});

test("Conditional writes are guarded in the core; replay precedes base but follows permission", async (t) => {
  const { budget, rule, send, connection } = await apiFixture(t);
  rule("group");
  const base = budget.eventSnapshot().cursor;
  code(
    await send("group", envelope({ name: "missing base" })),
    "BASE_REQUIRED",
    400,
  );
  code(
    await send("group", { arguments: { name: "bad base" }, base: "bad" }),
    "INVALID_CURSOR",
    400,
  );
  const foreign = await apiFixture(t);
  code(
    await send("group", {
      arguments: { name: "foreign" },
      base: foreign.budget.eventSnapshot().cursor,
    }),
    "CURSOR_MISMATCH",
    409,
  );
  const call = {
    arguments: { name: "Fixture group" },
    base,
    request_id: "once",
  };
  const first = await send("group", call);
  assert.equal(first.status, 200);
  assert.deepEqual((await send("group", call)).body, first.body);
  code(
    await send("group", { ...call, arguments: { name: "different" } }),
    "REQUEST_ID_REUSED",
    409,
  );
  code(
    await send("group", { ...call, request_id: "stale" }),
    "STATE_CONFLICT",
    409,
  );
  const cursor = budget.eventSnapshot().cursor;
  const competing = await Promise.all(
    ["race-a", "race-b"].map((request_id) =>
      send("group", {
        ...call,
        arguments: { name: request_id },
        base: cursor,
        request_id,
      }),
    ),
  );
  assert.deepEqual(competing.map((r) => r.status).sort(), [200, 409]);
  rule("group", "deny");
  code(await send("group", call), "PERMISSION_DENIED", 403);
  const audit = budget.accessState().audit;
  assert.ok(
    audit.some(
      (a) =>
        a.actor === connection.id &&
        a.action === "group" &&
        a.decision === "deny",
    ),
  );
  assert.ok(
    audit.some(
      (a) =>
        a.actor === connection.id &&
        a.action === "group" &&
        a.decision === "error",
    ),
  );
  // Existing callers retain their optional-base contract and cannot reuse an HTTP ID.
  rule("group");
  const agent = budget.forAgent(connection.token);
  assert.equal(
    typeof agent.request("group", { name: "CLI compatibility" }),
    "number",
  );
  assert.throws(
    () =>
      agent.request("group", call.arguments, {
        base,
        request_id: call.request_id,
      }),
    (e) => e.code === "REQUEST_ID_REUSED",
  );
});

test("Conditions still produce proposals; only their connection can poll and owner can resolve", async (t) => {
  const { budget, rule, send, connection } = await apiFixture(t);
  const account_id = budget.createAccount({
    name: "Fixture cash",
    type: "efectivo",
  });
  rule("transaction", "allow", {
    max_amount: 10,
    account_id,
    otherwise: "ask",
  });
  const call = {
    arguments: {
      account_id,
      amount: -20,
      category_id: 1,
      date: "2026-10-20",
      payee: "Fixture",
    },
    base: budget.eventSnapshot().cursor,
    purpose: "Review fixture expense",
    request_id: "proposal",
  };
  const pending = (await send("transaction", call)).body.result;
  assert.equal(pending.status, "pending");
  assert.equal(budget.accountTransactions(account_id).length, 0);
  assert.deepEqual((await send("transaction", call)).body.result, pending);
  const own = await send(
    "proposal-status",
    envelope({ id: pending.proposal_id }),
  );
  assert.equal(own.body.result.status, "pending");
  const other = budget.createConnection({ label: "Other client" });
  code(
    await send("proposal-status", envelope({ id: pending.proposal_id }), {
      headers: { Authorization: "Bearer " + other.token },
    }),
    "PROPOSAL_NOT_FOUND",
    404,
  );
  code(
    await send("proposal-resolve", envelope({ id: pending.proposal_id })),
    "NOT_FOUND",
    404,
  );
  budget.resolveProposal({ id: pending.proposal_id, decision: "accept" });
  assert.equal(
    (await send("proposal-status", envelope({ id: pending.proposal_id }))).body
      .result.status,
    "accepted",
  );
  rule("transaction", "deny");
  code(
    await send("proposal-status", envelope({ id: pending.proposal_id })),
    "PERMISSION_DENIED",
    403,
  );
  budget.revokeConnection(connection.id);
  code(await send("transaction", call), "AUTH_REQUIRED", 401);
});

test("Batches validate structure up front, retain ordering and isolate call failures", async (t) => {
  const { budget, rule, send } = await apiFixture(t);
  rule("group");
  rule("event-snapshot");
  const base = budget.eventSnapshot().cursor;
  const write = {
    id: "first",
    action: "group",
    arguments: { name: "Batch fixture" },
    base,
    request_id: "batch-once",
  };
  for (const calls of [
    [write, { id: "invalid" }],
    [write, { ...write }],
    Array(17).fill(write),
  ]) {
    code(await send("calls", { calls }), "INVALID_REQUEST", 400);
    assert.equal(budget.eventSnapshot().cursor, base);
  }
  const response = await send("calls", {
    calls: [
      write,
      { ...write, id: "replay" },
      { ...write, id: "conflict", request_id: "next-write" },
      { id: "unknown", action: "__proto__", arguments: {} },
      { id: "bad-args", action: "group", arguments: {} },
      { id: "read", action: "event-snapshot", arguments: { month: "2026-10" } },
    ],
  });
  assert.equal(response.status, 200);
  const r = response.body.results;
  assert.deepEqual(
    r.map((v) => v.id),
    ["first", "replay", "conflict", "unknown", "bad-args", "read"],
  );
  assert.deepEqual(r[0].result, r[1].result);
  assert.equal(r[2].error.code, "STATE_CONFLICT");
  assert.equal(r[3].error.code, "INVALID_ACTION");
  assert.equal(r[4].error.code, "INVALID_ARGUMENTS");
  assert.equal(r[5].ok, true);
  assert.notEqual(r[5].result.cursor, base);
  assert.equal(
    (
      await send("calls", {
        calls: Array.from({ length: 16 }, (_, i) => ({
          id: String(i),
          action: "permissions",
          arguments: {},
        })),
      })
    ).body.results.length,
    16,
  );
});

test("State/changes retain P4a cursor semantics and explicit export permission", async (t) => {
  const { send, budget, rule } = await apiFixture(t);
  rule("event-snapshot");
  rule("events");
  const state = (await send("event-snapshot", envelope({ month: "2026-10" })))
    .body.result;
  assert.deepEqual(
    (await send("events", envelope({ after: state.cursor }))).body.result,
    { version: 1, events: [], cursor: state.cursor, hasMore: false },
  );
  budget.createGroup({ name: "Event fixture" });
  const page = (
    await send("events", envelope({ after: state.cursor, limit: 1 }))
  ).body.result;
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].event.type, "io.nemein.budget.changed.v1");
  assert.ok(page.events[0].event.source);
  assert.equal(page.cursor, budget.eventSnapshot().cursor);
  rule("events", "deny");
  code(
    await send("events", envelope({ after: page.cursor })),
    "PERMISSION_DENIED",
    403,
  );
  code(await send("export"), "PERMISSION_DENIED", 403);
  rule("export");
  const exported = (await send("export", envelope({ format: "json" }))).body
    .result;
  assert.ok(!JSON.stringify(exported).includes("token_hash"));
  assert.equal(exported.cursor, page.cursor);
});

test("The served OpenAPI document and batch results match the published schemas", async (t) => {
  const document = generateOpenApi();
  const compile = schemaValidator(document);
  const { send } = await apiFixture(t);
  const wire = await send("openapi.json", {}, { method: "GET" });
  assert.equal(wire.status, 200);
  assert.deepEqual(wire.body, document);
  const batchResult = compile("BatchResult");
  const batch = await send("calls", {
    calls: [
      { id: "denied", action: "snapshot", arguments: {} },
      { id: "own", action: "permissions", arguments: {} },
    ],
  });
  assert.ok(batchResult(batch.body), JSON.stringify(batchResult.errors));
});

test("Routing, encoding and defaults keep the API closed outside its exact contract", async (t) => {
  const byDefault = await apiFixture(t, null);
  code(await byDefault.send("permissions"), "API_DISABLED", 404);
  const { send, budget, connection, rule } = await apiFixture(t);
  code(await send("Permissions"), "NOT_FOUND", 404);
  code(await send("permissions/"), "NOT_FOUND", 404);
  const identity = await send(
    "permissions",
    { arguments: {} },
    { headers: { "Content-Encoding": "identity" } },
  );
  assert.equal(identity.status, 200);
  const denied = await send("snapshot");
  code(denied, "PERMISSION_DENIED", 403);
  assert.equal(denied.headers["www-authenticate"], undefined);
  rule("group");
  const agent = budget.forAgent(connection.token);
  const write = (base) =>
    agent.request("group", { name: "Fixture" }, { base, requireBase: true });
  assert.throws(() => write("a".repeat(1025)), { code: "BASE_REQUIRED" });
  assert.throws(
    () => write("a".repeat(1024)),
    (error) => error.code !== "BASE_REQUIRED",
  );
});
