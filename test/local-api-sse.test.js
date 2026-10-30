import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createEventStreams } from "../src/local-api-sse.js";
import { sseLimits } from "../src/local-api-contract.js";
import { apiFixture, apiDeadline } from "./helpers/local-api.js";

const records = (s) => s.frames.filter((f) => f.event === "budget-event");
const errorCode = (s) =>
  s.frames.find((f) => f.event === "stream-error")?.data.error.code;
// Fail before any mock-clock loop if a timing-limit mutant would schedule at zero.
assert.deepEqual(sseLimits, {
  streams: 8,
  eventsPerTurn: 100,
  pollMs: 1000,
  heartbeatMs: 15000,
  frameBytes: 65536,
});

function response(write = () => true) {
  const res = new EventEmitter();
  Object.assign(res, {
    frames: [],
    headers: {},
    ended: false,
    destroyed: false,
    set(name, value) {
      res.headers[name] = value;
    },
    write(frame) {
      res.frames.push(frame);
      return write(frame);
    },
    end() {
      res.ended = true;
      res.emit("close");
    },
    destroy() {
      res.destroyed = true;
      res.emit("close");
    },
  });
  return res;
}
function agentWith(events = []) {
  const calls = [];
  const position = (after) => (after === "start" ? 0 : Number(after) + 1);
  const agent = {
    decision: "allow",
    polls: 0,
    calls,
    eventStreamState(after) {
      agent.polls++;
      return {
        decision: agent.decision,
        pending: agent.decision === "allow" && position(after) < events.length,
      };
    },
    request(action, args) {
      if (agent.decision === "deny")
        throw Object.assign(Error("Denied fixture"), {
          code: "PERMISSION_DENIED",
        });
      calls.push({ action, ...args });
      const index = position(args.after);
      return {
        events: events
          .slice(index, index + 1)
          .map((event) => ({ cursor: String(index), event })),
      };
    },
  };
  return agent;
}

test("SSE polls, yields after 100 records, heartbeats without cursor and cancels timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const streams = createEventStreams();
  const agent = agentWith(Array.from({ length: 250 }, (_, id) => ({ id })));
  const res = response();
  streams.open(agent, "start", res);
  assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.equal(res.frames[0], ": connected\n\n");
  assert.equal(res.frames.length, 101);
  assert.equal(agent.calls.length, 101);
  assert.deepEqual(agent.calls[0], {
    action: "events",
    after: "start",
    limit: 1,
  });
  t.mock.timers.tick(1);
  assert.equal(res.frames.length, 201);
  t.mock.timers.tick(1);
  assert.equal(res.frames.length, 251);
  assert.equal(
    res.frames[250],
    'event: budget-event\nid: 249\ndata: {"version":1,"cursor":"249","event":{"id":249}}\n\n',
  );
  const reads = agent.polls;
  t.mock.timers.tick(999);
  assert.equal(agent.polls, reads);
  t.mock.timers.tick(1);
  assert.equal(agent.polls, reads + 1);
  // Tick individual polls: callbacks deliberately schedule relative to current time.
  for (let i = 0; i < 13; i++) t.mock.timers.tick(1000);
  assert.equal(res.frames.length, 251);
  t.mock.timers.tick(1000);
  assert.equal(res.frames.at(-1), ": heartbeat\n\n");
  t.mock.timers.tick(1000);
  assert.equal(res.frames.length, 252);
  streams.close();
  assert.ok(res.ended);
  const stopped = agent.polls;
  t.mock.timers.tick(60000);
  assert.equal(agent.polls, stopped);
  streams.close();
});

test("SSE caps simultaneous streams and releases them on disconnect, response error and shutdown", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const streams = createEventStreams(),
    agent = agentWith();
  const responses = Array.from({ length: 8 }, () => response());
  for (const res of responses) streams.open(agent, "start", res);
  assert.throws(() => streams.open(agent, "start", response()), {
    code: "STREAM_LIMIT",
  });
  responses[0].emit("close");
  const replacement = response();
  streams.open(agent, "start", replacement);
  responses[1].emit("error", Error("closed pipe"));
  assert.ok(responses[1].destroyed);
  const last = response();
  streams.open(agent, "start", last);
  streams.close();
  assert.ok(responses.slice(2).every((r) => r.ended));
  assert.ok(replacement.ended && last.ended);
  const count = agent.polls;
  t.mock.timers.tick(1000);
  assert.equal(agent.polls, count);
});

test("SSE bounds bytes and immediately disconnects every kind of blocked write", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  for (const prefix of [
    ": connected",
    "event: budget-event",
    ": heartbeat",
    "event: stream-error",
  ]) {
    const streams = createEventStreams(),
      agent = agentWith([{ id: "one" }]);
    const res = response((frame) => !frame.startsWith(prefix));
    streams.open(agent, "start", res);
    if (prefix === ": heartbeat") {
      t.mock.timers.tick(15000);
    } else if (prefix === "event: stream-error") {
      agent.decision = "deny";
      t.mock.timers.tick(1000);
    }
    assert.ok(res.destroyed, prefix);
    const count = agent.polls;
    t.mock.timers.tick(1000);
    assert.equal(agent.polls, count);
    streams.close();
  }
  for (const excess of [0, 1]) {
    const base =
      'event: budget-event\nid: 0\ndata: {"version":1,"cursor":"0","event":{"text":""}}\n\n';
    const event = {
      text: "é".repeat(Math.floor((65536 - Buffer.byteLength(base)) / 2)),
    };
    event.text += "x".repeat(
      65536 + excess - Buffer.byteLength(base) - Buffer.byteLength(event.text),
    );
    const streams = createEventStreams(),
      res = response();
    streams.open(agentWith([event]), "start", res);
    if (excess) {
      assert.match(res.frames.at(-1), /STREAM_EVENT_TOO_LARGE/);
      assert.ok(res.ended);
      assert.equal(res.frames.length, 2);
    } else {
      assert.equal(Buffer.byteLength(res.frames[1]), 65536);
      assert.ok(!res.ended);
    }
    streams.close();
  }
});

test("SSE checks permissions while idle and before each record, sanitizes failures and never advances error IDs", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const decision of ["deny", "ask"]) {
    const streams = createEventStreams(),
      agent = agentWith(),
      res = response();
    agent.decision = decision;
    assert.throws(() => streams.open(agent, "start", res), {
      code: decision === "ask" ? "APPROVAL_REQUIRED" : "PERMISSION_DENIED",
    });
    assert.equal(agent.calls.length, 0);
    agent.decision = "allow";
    streams.open(agent, "start", res);
    agent.decision = decision;
    t.mock.timers.tick(1000);
    assert.ok(res.ended);
    assert.match(res.frames.at(-1), /event: stream-error\ndata: /);
    assert.ok(!res.frames.at(-1).includes("\nid:"));
    assert.equal(agent.calls.length, 1);
  }
  for (const failure of [
    new TypeError("private path"),
    Object.assign(Error("SQL secret"), { code: "SQLITE_ERROR" }),
    { status: "pending" },
  ]) {
    const agent = agentWith([{ id: "first" }, { id: "never" }]);
    const original = agent.request;
    agent.request = (...args) => {
      if (agent.calls.length) {
        if (failure.status) return failure;
        throw failure;
      }
      return original(...args);
    };
    const streams = createEventStreams(),
      res = response();
    streams.open(agent, "start", res);
    assert.equal(res.frames.length, 3);
    assert.ok(res.ended);
    assert.match(
      res.frames[2],
      failure.status ? /APPROVAL_REQUIRED/ : /INTERNAL_ERROR/,
    );
    assert.doesNotMatch(res.frames[2], /private path|SQL secret|\nid:/);
  }
  const agent = agentWith([{ id: "first" }]);
  const streams = createEventStreams(),
    res = response((frame) => {
      if (frame.startsWith("event: budget-event")) throw Error("broken write");
      return true;
    });
  streams.open(agent, "start", res);
  assert.ok(res.ended);
});

test("HTTP SSE preserves CloudEvents and interoperable cursors, catches up and closes cleanly", async (t) => {
  const { budget, rule, stream, app, send } = await apiFixture(t);
  rule("events");
  const base = budget.eventSnapshot().cursor;
  budget.createGroup({ name: "Fictional stream group" });
  const expected = budget.readEvents({ after: base });
  const s = await stream(base);
  t.after(s.close);
  await s.waitFor((frames) => frames.some((f) => f.event === "budget-event"));
  assert.equal(s.status, 200);
  assert.equal(s.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(s.headers["cache-control"], "no-store");
  assert.equal(s.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(records(s)[0].data, { version: 1, ...expected.events[0] });
  assert.equal(records(s)[0].id, expected.cursor);
  budget.createGroup({ name: "Fictional later group" });
  await s.waitFor(
    (frames) => frames.filter((f) => f.event === "budget-event").length === 2,
  );
  assert.deepEqual(
    records(s).map((f) => f.data),
    budget
      .readEvents({ after: base })
      .events.map((e) => ({ version: 1, ...e })),
  );
  assert.equal((await send("permissions")).status, 200);
  app.locals.closeLocalApi();
  await apiDeadline(s.finished, s.close);
  assert.equal(errorCode(s), undefined);
});

test("HTTP SSE rejects hostile security headers, missing/foreign/future cursors and non-GET methods before opening", async (t) => {
  const { budget, rule, send, port } = await apiFixture(t);
  rule("events");
  const base = budget.eventSnapshot().cursor;
  const get = (headers = {}) =>
    send(
      "events/stream",
      {},
      { method: "GET", headers: { "Last-Event-ID": base, ...headers } },
    );
  for (const [headers, code, status] of [
    [{ "Last-Event-ID": "" }, "INVALID_CURSOR", 400],
    [{ "Last-Event-ID": "x".repeat(1025) }, "INVALID_CURSOR", 400],
    [{ Host: "localhost:" + port }, "INVALID_HOST", 403],
    [{ Origin: "https://hostile.example" }, "INVALID_ORIGIN", 403],
    [{ Authorization: "" }, "AUTH_REQUIRED", 401],
  ]) {
    const r = await get(headers);
    assert.equal(r.status, status);
    assert.equal(r.body.error.code, code);
    assert.match(r.headers["content-type"], /application\/json/);
  }
  assert.equal(
    (await send("events/stream", {}, { method: "GET" })).body.error.code,
    "INVALID_CURSOR",
  );
  assert.equal(
    (await send("events/stream")).body.error.code,
    "METHOD_NOT_ALLOWED",
  );
  assert.equal(
    (await send("events/stream", {}, { method: "HEAD" })).status,
    405,
  );
  assert.equal(
    (await send("events/stream?access_token=fake", {}, { method: "GET" })).body
      .error.code,
    "INVALID_REQUEST",
  );
  const position = JSON.parse(Buffer.from(base, "base64url"));
  for (const p of [
    { ...position, source: "foreign" },
    { ...position, sequence: position.sequence + 1, id: "future" },
  ]) {
    const r = await get({
      "Last-Event-ID": Buffer.from(JSON.stringify(p)).toString("base64url"),
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "CURSOR_MISMATCH");
  }
});

test("HTTP SSE revocation, token rotation and reduced rules stop open streams before subsequent events", async (t) => {
  const { budget, stream } = await apiFixture(t);
  const base = budget.eventSnapshot().cursor;
  const cases = [];
  for (const mode of ["revoke", "rotate", "deny", "ask"]) {
    const c = budget.createConnection({ label: "Fictional " + mode });
    budget.setRule({
      connection_id: c.id,
      action: "events",
      decision: "allow",
    });
    const s = await stream(base, {
      headers: { Authorization: "Bearer " + c.token },
    });
    t.after(s.close);
    await s.waitFor((frames) => frames.some((f) => f.raw === ": connected"));
    cases.push({ mode, c, s });
  }
  for (const { mode, c } of cases) {
    if (mode === "revoke") budget.revokeConnection(c.id);
    else if (mode === "rotate") budget.rotateConnection(c.id);
    else
      budget.setRule({ connection_id: c.id, action: "events", decision: mode });
  }
  budget.createGroup({ name: "Fictional change after revoke" });
  await Promise.all(cases.map(({ s }) => apiDeadline(s.finished, s.close)));
  for (const { mode, s } of cases) {
    assert.equal(records(s).length, 0);
    assert.equal(
      errorCode(s),
      mode === "ask"
        ? "APPROVAL_REQUIRED"
        : mode === "deny"
          ? "PERMISSION_DENIED"
          : "AUTH_REQUIRED",
    );
    assert.ok(
      s.frames
        .filter((f) => f.event === "stream-error")
        .every((f) => f.id === undefined),
    );
  }
  assert.equal(budget.accessState().proposals.length, 0);
});

test("HTTP SSE needs its own allow rule and enforces a global reusable eight-stream cap", async (t) => {
  const { budget, rule, send, stream, app } = await apiFixture(t);
  const base = budget.eventSnapshot().cursor;
  const get = () =>
    send(
      "events/stream",
      {},
      { method: "GET", headers: { "Last-Event-ID": base } },
    );
  rule("event-snapshot");
  assert.equal((await get()).body.error.code, "PERMISSION_DENIED");
  rule("events", "ask");
  assert.equal((await get()).body.error.code, "APPROVAL_REQUIRED");
  assert.equal(budget.accessState().proposals.length, 0);
  rule("events");
  const active = [];
  for (let i = 0; i < 8; i++) {
    const c = budget.createConnection({ label: "Fictional cap " + i });
    budget.setRule({
      connection_id: c.id,
      action: "events",
      decision: "allow",
    });
    const s = await stream(base, {
      headers: { Authorization: "Bearer " + c.token },
    });
    t.after(s.close);
    await s.waitFor((frames) => frames.some((f) => f.raw === ": connected"));
    active.push(s);
  }
  const rejected = await get();
  assert.equal(rejected.status, 429);
  assert.equal(rejected.body.error.code, "STREAM_LIMIT");
  app.locals.closeLocalApi();
  await Promise.all(active.map((s) => apiDeadline(s.finished, s.close)));
  const reopened = await stream(base);
  t.after(reopened.close);
  await reopened.waitFor((frames) =>
    frames.some((f) => f.raw === ": connected"),
  );
  assert.equal(reopened.status, 200);
});

test("An idle stream polls without growing the audit, and a delivered read stays audited", async (t) => {
  const { budget, connection, rule } = await apiFixture(t);
  rule("events");
  const auditRows = () =>
    budget.db.prepare("SELECT count(*) AS rows FROM agent_audit").get().rows;
  const agent = budget.forAgent(connection.token);
  const after = budget.eventSnapshot().cursor;
  const before = auditRows();
  assert.deepEqual(agent.eventStreamState(after), {
    decision: "allow",
    pending: false,
  });
  assert.equal(auditRows(), before);
  budget.createGroup({ name: "Fixture" });
  const written = auditRows();
  assert.equal(agent.eventStreamState(after).pending, true);
  assert.equal(auditRows(), written);
  rule("events", "deny");
  assert.deepEqual(agent.eventStreamState(after), {
    decision: "deny",
    pending: false,
  });
  budget.revokeConnection(connection.id);
  assert.throws(() => agent.eventStreamState(after));
});
