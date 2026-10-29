import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { openBudget } from "../src/core.js";
import { createApp } from "../src/server.js";
import { actions } from "../src/actions.js";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-permissions-")),
    b = openBudget(dir);
  t.after(() => {
    if (b.db.open) b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const connection = b.createConnection({ label: "Batch fixture" });
  const decisions = () =>
    Object.fromEntries(
      Object.entries(b.forAgent(connection.token).permissions().actions).map(
        ([action, p]) => [action, p.decision],
      ),
    );
  const audits = () =>
    b.db.prepare("SELECT count(*) n FROM agent_audit").get().n;
  return { b, connection, decisions, audits };
}
const names = Object.keys(actions);
const syncNames = names.filter((a) => !actions[a].async);

test("setRules saves a whole connection at once and skips what did not change", (t) => {
  const { b, connection, decisions, audits } = fixture(t);
  const id = connection.id;
  const rules = [
    { action: "snapshot", decision: "allow" },
    { action: "export", decision: "deny" },
    {
      action: "transaction",
      decision: "ask",
      conditions: { max_amount: 10, otherwise: "deny" },
    },
  ];
  assert.deepEqual(b.setRules({ connection_id: id, rules }), { changed: 2 });
  const d = decisions();
  assert.equal(d.snapshot, "allow");
  assert.equal(d.export, "deny");
  assert.equal(d.transaction, "ask");
  const before = audits();
  assert.deepEqual(b.setRules({ connection_id: id, rules }), { changed: 0 });
  assert.equal(audits(), before, "unchanged rows are not audited again");
  assert.deepEqual(
    b.setRules({
      connection_id: id,
      rules: [
        {
          action: "transaction",
          decision: "ask",
          conditions: { max_amount: 11, otherwise: "deny" },
        },
      ],
    }),
    { changed: 1 },
  );
  b.db
    .prepare("UPDATE agent_rules SET action_version=0 WHERE action='snapshot'")
    .run();
  assert.equal(decisions().snapshot, "deny", "a stale rule does not grant");
  assert.deepEqual(
    b.setRules({
      connection_id: id,
      rules: [{ action: "snapshot", decision: "allow" }],
    }),
    { changed: 1 },
  );
  assert.equal(decisions().snapshot, "allow");
  assert.equal(b.forAgent(connection.token).setRules, undefined);
  for (const rules of [[], undefined, "snapshot"])
    assert.throws(
      () => b.setRules({ connection_id: id, rules }),
      (e) => e.code === "INVALID_RULE",
    );
});

test("PBT: a batch with one invalid row saves nothing", (t) => {
  const { b, connection, decisions, audits } = fixture(t);
  const invalid = fc.constantFrom(
    { action: "backup", decision: "ask" },
    { action: "not-an-action", decision: "allow" },
    { action: "snapshot", decision: "maybe" },
    { action: "snapshot", decision: "allow", conditions: { max_amount: 5 } },
    {
      action: "transaction",
      decision: "allow",
      conditions: { max_amount: -1 },
    },
  );
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.constantFrom(...syncNames), {
        minLength: 1,
        maxLength: 8,
      }),
      fc.array(fc.constantFrom("allow", "ask", "deny"), {
        minLength: 8,
        maxLength: 8,
      }),
      fc.option(invalid, { nil: undefined }),
      fc.nat(8),
      (chosen, picks, bad, at) => {
        const before = decisions(),
          audited = audits();
        const rules = chosen.map((action, i) => ({
          action,
          decision: picks[i],
        }));
        if (bad) rules.splice(at % (rules.length + 1), 0, bad);
        if (bad) {
          assert.throws(
            () => b.setRules({ connection_id: connection.id, rules }),
            (e) => e.code === "INVALID_RULE",
          );
          // Reading permissions audits itself, so count first.
          assert.equal(audits(), audited);
          assert.deepEqual(decisions(), before);
          return;
        }
        const expected = rules.filter(
          (r) => before[r.action] !== r.decision,
        ).length;
        assert.deepEqual(b.setRules({ connection_id: connection.id, rules }), {
          changed: expected,
        });
        const after = decisions();
        for (const r of rules) assert.equal(after[r.action], r.decision);
        for (const action of names)
          if (!chosen.includes(action))
            assert.equal(after[action], before[action]);
      },
    ),
    { seed: 290426, numRuns: 120 },
  );
});

test("Owner UI: one CSRF-protected request saves the connection without a reload", async (t) => {
  const { b, connection, decisions } = fixture(t);
  const account = b.createAccount({ name: "Cash", type: "efectivo" });
  const server = createApp(b, { installationRoots: [] }).listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const page = await (await fetch(base + "/?view=access")).text();
  assert.ok(page.includes("data-permissions-form"));
  assert.ok(page.includes(`name="decision:snapshot"`));
  assert.ok(
    !page.includes(`name="decision:backup" value="ask"`),
    "backups cannot wait for approval",
  );
  assert.ok(page.includes(`id="connection-${connection.id}"`));
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const post = (fields, json = true, token = csrf) =>
    fetch(base + "/action/permissions-set", {
      method: "POST",
      headers: json ? { Accept: "application/json" } : {},
      body: new URLSearchParams({
        _csrf: token,
        connection_id: connection.id,
        ...fields,
      }),
      redirect: "manual",
    });
  assert.equal(
    (await post({ "decision:snapshot": "allow" }, true, "bad")).status,
    403,
  );
  assert.equal(decisions().snapshot, "deny");
  let r = await post({
    "decision:snapshot": "allow",
    "decision:overview": "allow",
    "decision:transaction": "ask",
    "max_amount:transaction": "50",
    "account_id:transaction": String(account),
    "otherwise:transaction": "ask",
    "otherwise:account": "deny",
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { changed: 3 });
  const p = b.forAgent(connection.token).permissions().actions;
  assert.deepEqual(p.transaction.conditions, {
    max_amount: 50,
    account_id: account,
    otherwise: "ask",
  });
  assert.deepEqual(
    p.account.conditions,
    {},
    "a fallback alone adds no condition",
  );
  r = await post({
    "decision:snapshot": "deny",
    "max_amount:transaction": "5x",
    "decision:transaction": "ask",
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /enteros/);
  assert.equal(
    decisions().snapshot,
    "allow",
    "the rejected request changed nothing",
  );
  r = await post({ "decision:backup": "ask" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /respaldos/i);
  r = await post({ "decision:overview": "deny" }, false);
  assert.equal(r.status, 302);
  const location = new URL(r.headers.get("location"), base);
  assert.equal(location.searchParams.get("open"), connection.id);
  assert.equal(location.hash, "#connection-" + connection.id);
  assert.match(location.searchParams.get("notice"), /: 1 cambio./);
  const reopened = await (await fetch(location)).text();
  assert.ok(reopened.includes(`id="connection-${connection.id}" open`));
  r = await post({ "decision:overview": "deny" }, false);
  assert.match(
    new URL(r.headers.get("location"), base).searchParams.get("notice"),
    /al día/,
  );
});
