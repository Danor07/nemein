import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBudget } from "../src/core.js";
import { createApp } from "../src/server.js";
test("CSV por HTTP con vista previa, confirmación, conciliación y recategorización", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cero-flow-")),
    b = openBudget(dir),
    server = createApp(b).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = b.createAccount({ name: "Principal", type: "corriente" }),
    base = "http://127.0.0.1:" + server.address().port;
  const html = await (await fetch(base + "/?view=budget")).text(),
    _csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const post = (action, p) =>
    fetch(base + "/action/" + action, {
      method: "POST",
      body: new URLSearchParams({ _csrf, ...p }),
      redirect: "manual",
    });
  const preview = await post("preview", {
    view: "import",
    account_id: a,
    content:
      "fecha;detalle;importe\n01/10/2026;Ingreso;1000000\n02/10/2026;Mercado;-100000",
    dateColumn: "fecha",
    payeeColumn: "detalle",
    amountColumn: "importe",
    delimiter: ";",
    dateFormat: "dmy",
    thousands: "none",
    category_id: 1,
  });
  assert.equal(preview.status, 200);
  const previewHtml = await preview.text();
  assert.match(previewHtml, /Revisá antes de guardar/);
  assert.equal(b.accountTransactions(a).length, 0);
  const previewId = previewHtml.match(/name="previewId" value="([^"]+)"/)[1];
  assert.equal((await post("import", { previewId })).status, 302);
  assert.equal(b.accountTransactions(a).length, 2);
  const expense = b.accountTransactions(a)[1];
  assert.equal(b.reports("2026-10").spending[0].amount, 100000);
  assert.equal(
    (await post("categorize", { id: expense.id, category_id: 2 })).status,
    302,
  );
  assert.equal(
    b.snapshot("2026-10").memory.find((x) => x.payee === "mercado").category_id,
    2,
  );
  const tx = b.accountTransactions(a);
  const body = new URLSearchParams({
    _csrf,
    view: "reconcile",
    account_id: a,
    date: "2026-10-31",
    balance: "900000",
    commit: "no",
  });
  for (const row of tx) body.append("ids", row.id);
  let r = await fetch(base + "/action/reconcile", { method: "POST", body });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Confirmar conciliación/);
  body.set("commit", "yes");
  r = await fetch(base + "/action/reconcile", {
    method: "POST",
    body,
    redirect: "manual",
  });
  assert.equal(r.status, 302);
  assert.ok(b.accountTransactions(a).every((x) => x.reconciled));
  assert.equal((await post("delete", { id: expense.id })).status, 400);
});
test("reintegros reducen gastos y el patrimonio respeta el cierre mensual", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cero-report-")),
    b = openBudget(dir);
  t.after(() => {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = b.createAccount({
    name: "Cuenta",
    type: "corriente",
    balance: 1000000,
    date: "2026-01-01",
  });
  b.addTransaction({
    account_id: a,
    date: "2026-01-02",
    payee: "Tienda",
    amount: -100000,
    category_id: 1,
  });
  b.addTransaction({
    account_id: a,
    date: "2026-01-03",
    payee: "Reintegro",
    amount: 20000,
    category_id: 1,
  });
  b.addTransaction({
    account_id: a,
    date: "2026-02-01",
    payee: "Otro",
    amount: -50000,
    category_id: 2,
  });
  assert.equal(b.reports("2026-01").spending[0].amount, 80000);
  assert.equal(b.reports("2026-01").history.at(-1).value, 920000);
  assert.equal(b.reports("2026-02").history.at(-1).value, 870000);
});
