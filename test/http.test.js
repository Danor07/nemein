import { request } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBudget } from "../src/core.js";
import { createApp } from "../src/server.js";
test("pantallas SSR, CSRF, origen y guardado por HTTP", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cero-http-")),
    b = openBudget(dir),
    server = createApp(b).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  for (const view of [
    "budget",
    "transactions",
    "import",
    "reconcile",
    "reports",
    "settings",
  ]) {
    const r = await fetch(base + "/?view=" + view);
    assert.equal(r.status, 200, view);
    assert.match(await r.text(), /Cero/);
  }
  const html = await (await fetch(base + "/?view=budget")).text(),
    csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
  assert.equal(
    (
      await fetch(base + "/action/account", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "name=No&type=efectivo",
      })
    ).status,
    403,
  );
  const body = new URLSearchParams({
    _csrf: csrf,
    name: "Banco",
    type: "corriente",
    balance: "1000",
    date: "2026-01-01",
    view: "settings",
  });
  assert.equal(
    (
      await fetch(base + "/action/account", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://evil.example",
        },
        body,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/action/account", {
        method: "POST",
        body,
        redirect: "manual",
      })
    ).status,
    302,
  );
  assert.equal(b.snapshot().accounts.length, 1);
  for (const view of [
    "transactions",
    "import",
    "reconcile",
    "reports",
    "settings",
  ])
    assert.equal((await fetch(base + "/?view=" + view)).status, 200);
  assert.equal((await fetch(base + "/static/chart.js")).status, 200);
  assert.equal(
    await new Promise((resolve, reject) => {
      const req = request(
        base,
        { headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    }),
    403,
  );
});
