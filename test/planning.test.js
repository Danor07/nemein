import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBudget } from "../src/core.js";
import { execute } from "../src/commands.js";
import { createApp } from "../src/server.js";
function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cero-planning-")),
    b = openBudget(dir);
  t.after(() => {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = b.createAccount({
    name: "Banco",
    type: "corriente",
    balance: 1000000,
    date: "2026-01-01",
  });
  return { b, a };
}
test("recurrentes: fin de mes, doble envío y pausa sin modificar saldos programados", async (t) => {
  const { b, a } = setup(t);
  const id = await execute(b, "recurring-create", {
    account_id: a,
    category_id: 3,
    payee: "Internet",
    amount: -100000,
    next_date: "2026-01-31",
    frequency: "monthly",
  });
  assert.equal(b.snapshot("2026-01").accounts[0].balance, 1000000);
  assert.equal(
    b.postRecurring({ id, due_date: "2026-01-31" }).next_date,
    "2026-02-28",
  );
  assert.throws(
    () => b.postRecurring({ id, due_date: "2026-01-31" }),
    /ya cambió/,
  );
  assert.equal(
    b.postRecurring({ id, due_date: "2026-02-28" }).next_date,
    "2026-03-31",
  );
  b.toggleRecurring({ id, active: false });
  assert.throws(
    () => b.postRecurring({ id, due_date: "2026-03-31" }),
    /activo/,
  );
  assert.equal(b.snapshot().accounts[0].balance, 800000);
  b.toggleRecurring({ id, active: true });
  assert.equal(
    b.postRecurring({ id, due_date: "2026-03-31" }).next_date,
    "2026-04-30",
  );
  const yearly = b.createRecurring({
    account_id: a,
    category_id: 3,
    payee: "Anual",
    amount: -100,
    next_date: "2024-02-29",
    frequency: "yearly",
  });
  assert.equal(
    b.postRecurring({ id: yearly, due_date: "2024-02-29" }).next_date,
    "2025-02-28",
  );
});
test("metas usan fondos reales; el cubo conserva totales en todos los cortes", async (t) => {
  const { b, a } = setup(t);
  b.allocate({ month: "2026-01", category_id: 7, amount: 200000 });
  b.setGoal({ category_id: 7, amount: 1000000, due_date: "2026-04-30" });
  assert.equal(b.listGoals("2026-01")[0].monthly, 200000);
  b.addTransaction({
    account_id: a,
    date: "2026-01-03",
    payee: "Sueldo",
    amount: 500000,
  });
  b.addTransaction({
    account_id: a,
    date: "2026-01-04",
    payee: "Tienda",
    amount: -100000,
    category_id: 1,
  });
  b.addTransaction({
    account_id: a,
    date: "2026-01-05",
    payee: "Reintegro",
    amount: 20000,
    category_id: 1,
  });
  const cash = b.createAccount({ name: "Efectivo", type: "efectivo" });
  b.transfer({ from: a, to: cash, date: "2026-01-06", amount: 50000 });
  for (const dimensions of [
    ["month"],
    ["account", "category"],
    ["day", "payee", "category"],
  ]) {
    const cube = await execute(b, "cube", {
      from: "2026-01-01",
      to: "2026-01-31",
      dimensions,
    });
    assert.deepEqual(cube.totals, {
      count: 3,
      income: 500000,
      spending: 80000,
      net: 420000,
    });
  }
  assert.throws(
    () =>
      b.cube({
        from: "2026-01-01",
        to: "2026-01-31",
        dimensions: ["sqlite_version()"],
      }),
    /dimensiones/,
  );
  assert.equal(b.overview("2026-01").spending, 80000);
  assert.equal(
    (
      await execute(b, "search", {
        month: "2026-01",
        query: "tienda",
        account_id: a,
      })
    ).length,
    1,
  );
  b.removeGoal({ category_id: 7 });
  assert.equal(b.listGoals("2026-01").length, 0);
  assert.equal(
    b.snapshot("2026-01").categories.find((c) => c.id === 7).available,
    200000,
  );
});
test("pantallas nuevas, configuración MCP y recurrentes por HTTP", async (t) => {
  const { b, a } = setup(t);
  const server = createApp(b).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  for (const view of ["home", "planning", "agents", "access"]) {
    const res = await fetch(base + "/?view=" + view);
    assert.equal(res.status, 200, await res.text());
  }
  assert.equal((await fetch(base + "/agent-config")).status, 400);
  const html = await (await fetch(base + "/?view=planning")).text();
  const _csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const post = (action, p) =>
    fetch(base + "/action/" + action, {
      method: "POST",
      body: new URLSearchParams({ _csrf, view: "planning", ...p }),
      redirect: "manual",
    });
  assert.equal(
    (
      await post("recurring-create", {
        account_id: a,
        category_id: 1,
        payee: "Mercado",
        amount: -5000,
        next_date: "2026-10-23",
        frequency: "weekly",
      })
    ).status,
    302,
  );
  const id = b.listRecurring()[0].id;
  assert.equal(
    (await post("recurring-post", { id, due_date: "2026-10-23" })).status,
    302,
  );
  assert.equal(
    (await post("recurring-post", { id, due_date: "2026-10-23" })).status,
    400,
  );
  assert.equal(b.listRecurring()[0].next_date, "2026-10-30");
});
