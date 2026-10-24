import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBudget } from "../src/core.js";
import { createApp } from "../src/server.js";

test("Owner UI: CSRF protected permissions and accept/modify/reject proposal flow", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-access-http-")),
    b = openBudget(dir);
  const account = b.createAccount({ name: "Cash", type: "efectivo" });
  const connection = b.createConnection({ label: "Client <fixture>" });
  const agent = b.forAgent(connection.token);
  const server = createApp(b, { installationRoots: [] }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    let page = await (await fetch(base + "/?view=access")).text();
    assert.ok(page.includes("Client &lt;fixture&gt;"));
    assert.ok(!page.includes(connection.token));
    const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
    const post = (action, p, token = csrf) =>
      fetch(base + "/action/" + action, {
        method: "POST",
        body: new URLSearchParams({ _csrf: token, view: "access", ...p }),
        redirect: "manual",
      });
    assert.equal(
      (
        await post(
          "permission-set",
          {
            connection_id: connection.id,
            action: "transaction",
            decision: "allow",
          },
          "bad",
        )
      ).status,
      403,
    );
    assert.throws(
      () =>
        agent.addTransaction({
          account_id: account,
          date: "2026-10-24",
          payee: "Denied",
          amount: -5,
          category_id: 1,
        }),
      (e) => e.code === "PERMISSION_DENIED",
    );
    assert.equal(
      (
        await post("permission-set", {
          connection_id: connection.id,
          action: "transaction",
          decision: "allow",
          max_amount: "10",
          otherwise: "ask",
          account_id: String(account),
        })
      ).status,
      302,
    );
    const payment = {
      account_id: account,
      date: "2026-10-24",
      payee: "Review",
      amount: -20,
      category_id: 1,
    };
    const propose = (id) =>
      agent.request("transaction", payment, {
        base: b.eventSnapshot().cursor,
        purpose: "Revisar gasto",
        request_id: id,
      });
    const accept = propose("http-accept");
    page = await (await fetch(base + "/?view=access")).text();
    assert.ok(page.includes("Revisar gasto"));
    assert.ok(page.includes('value="' + accept.proposal_id + '"'));
    assert.equal(
      (
        await post("proposal-resolve", {
          id: accept.proposal_id,
          decision: "accept",
        })
      ).status,
      302,
    );
    assert.equal(
      (
        await post("proposal-resolve", {
          id: accept.proposal_id,
          decision: "accept",
        })
      ).status,
      400,
    );
    const modified = propose("http-modify");
    assert.equal(
      (
        await post("proposal-resolve", {
          id: modified.proposal_id,
          decision: "modify",
          args: JSON.stringify({ ...payment, amount: -15 }),
          reason: "Corregir importe",
        })
      ).status,
      302,
    );
    assert.equal(
      agent.proposalStatus({ id: modified.proposal_id }).final_args.amount,
      -15,
    );
    const rejected = propose("http-reject");
    assert.equal(
      (
        await post("proposal-resolve", {
          id: rejected.proposal_id,
          decision: "reject",
          reason: "No corresponde",
        })
      ).status,
      302,
    );
    assert.equal(b.accountTransactions(account).length, 2);
    assert.equal(
      (await post("connection-revoke", { id: connection.id })).status,
      302,
    );
    assert.throws(
      () => agent.addTransaction(payment),
      (e) => e.code === "AUTH_REQUIRED",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
