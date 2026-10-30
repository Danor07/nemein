import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { apiFixture, apiDeadline } from "../helpers/local-api.js";
import { decodeCursor } from "../../src/event-reads.js";

test("Hostile Last-Event-ID inputs and duplicate headers cannot open SSE or change financial history", async (t) => {
  const { budget, rule, send, connection, port } = await apiFixture(t);
  rule("events");
  const before = budget.eventSnapshot().cursor;
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc.string({ maxLength: 200 }).map((s) => "!" + s),
        fc
          .jsonValue()
          .map((value) =>
            Buffer.from(JSON.stringify({ hostile: value })).toString(
              "base64url",
            ),
          ),
        fc.integer({ min: 1025, max: 5000 }).map((n) => "x".repeat(n)),
      ),
      async (hostile) => {
        assert.throws(() => decodeCursor(hostile), { code: "INVALID_CURSOR" });
        try {
          const r = await send(
            "events/stream",
            {},
            { method: "GET", headers: { "Last-Event-ID": hostile } },
          );
          assert.equal(r.status, 400);
          assert.equal(r.body.error.code, "INVALID_CURSOR");
          assert.match(r.headers["content-type"], /application\/json/);
        } catch (error) {
          assert.ok(
            ["ERR_INVALID_CHAR", "ERR_HTTP_INVALID_HEADER_VALUE"].includes(
              error.code,
            ),
            error.message,
          );
        }
        const r = await send(
          "events/stream",
          {},
          {
            method: "GET",
            rawHeaders: [
              "Host",
              "127.0.0.1:" + port,
              "Authorization",
              "Bearer " + connection.token,
              "Last-Event-ID",
              before,
              "lAsT-eVeNt-Id",
              before,
            ],
          },
        );
        assert.equal(r.status, 400);
        assert.equal(r.body.error.code, "INVALID_REQUEST");
      },
    ),
    { seed: 903002, numRuns: 60 },
  );
  assert.equal(budget.eventSnapshot().cursor, before);
  assert.equal(budget.accessState().proposals.length, 0);
});

test("Adversarial reconnects and mid-stream revocation never disclose the next event", async (t) => {
  const { budget, rule, stream, send } = await apiFixture(t);
  rule("events");
  let serial = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 4 }),
      async (reconnects) => {
        const base = budget.eventSnapshot().cursor;
        for (let i = 0; i < 4; i++)
          budget.createGroup({ name: "Fictional reconnect " + serial++ });
        const expected = budget.readEvents({ after: base }).events;
        for (const index of reconnects) {
          const after = index === 4 ? base : expected[index - 1].cursor;
          const suffix = index === 4 ? expected : expected.slice(index);
          const s = await stream(after);
          try {
            await s.waitFor(
              (frames) =>
                frames.filter((f) => f.event === "budget-event").length >=
                suffix.length,
            );
            assert.deepEqual(
              s.frames
                .filter((f) => f.event === "budget-event")
                .map((f) => f.data.event),
              suffix.map((e) => e.event),
            );
          } finally {
            s.close();
            await s.finished;
          }
        }
      },
    ),
    { seed: 903003, numRuns: 12 },
  );

  // Revoke several generated connection/rule variants at once, including idle streams.
  const modes = fc.sample(fc.constantFrom("revoke", "deny", "ask", "version"), {
    seed: 903004,
    numRuns: 6,
  });
  const active = [];
  const base = budget.eventSnapshot().cursor;
  for (const mode of modes) {
    const c = budget.createConnection({ label: "Fictional fuzz " + serial++ });
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
    active.push({ mode, c, s });
  }
  for (const { mode, c } of active) {
    if (mode === "revoke") budget.revokeConnection(c.id);
    else if (mode === "version")
      budget.changeConnectionVersion({ id: c.id, version: "fuzz-v2" });
    else
      budget.setRule({ connection_id: c.id, action: "events", decision: mode });
  }
  budget.createGroup({ name: "Fictional hidden after revoke" });
  await Promise.all(active.map(({ s }) => apiDeadline(s.finished, s.close)));
  for (const { mode, c, s } of active) {
    assert.equal(s.frames.filter((f) => f.event === "budget-event").length, 0);
    const error = s.frames.find((f) => f.event === "stream-error");
    assert.ok(error);
    assert.equal(error.id, undefined);
    assert.equal(
      error.data.error.code,
      {
        revoke: "AUTH_REQUIRED",
        deny: "PERMISSION_DENIED",
        ask: "APPROVAL_REQUIRED",
        version: "VERSION_MISMATCH",
      }[mode],
    );
    const r = await send(
      "events/stream",
      {},
      {
        method: "GET",
        headers: { Authorization: "Bearer " + c.token, "Last-Event-ID": base },
      },
    );
    assert.ok(r.status >= 400);
    assert.equal(r.body.error.code, error.data.error.code);
  }
});
