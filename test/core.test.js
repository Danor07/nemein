import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openBudget, money, date, today } from "../src/core.js";
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cero-test-"));
  const b = openBudget(dir);
  t.after(() => {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return b;
}
test("dinero entero, fechas reales y validación estricta", () => {
  assert.equal(money("85000"), 85000);
  for (const v of ["1.5", "1e3", "", NaN, "1.000"])
    assert.throws(() => money(v));
  assert.throws(() => date("2026-02-30"));
  assert.equal(date("2024-02-29"), "2024-02-29");
});
test("base cero, acumulación, sobreasignación y meses futuros", (t) => {
  const b = fixture(t),
    a = b.createAccount({
      name: "Banco",
      type: "corriente",
      balance: 1000000,
      date: "2026-01-01",
    });
  b.allocate({ month: "2026-01", category_id: 1, amount: 300000 });
  b.addTransaction({
    account_id: a,
    date: "2026-01-02",
    payee: "Mercado",
    amount: -80000,
    category_id: 1,
  });
  let s = b.snapshot("2026-01");
  assert.equal(s.ready, 700000);
  assert.equal(s.categories[0].available, 220000);
  assert.equal(b.snapshot("2026-02").categories[0].available, 220000);
  b.allocate({ month: "2026-02", category_id: 1, amount: 800000 });
  assert.equal(b.snapshot("2026-01").ready, -100000);
  assert.equal(b.snapshot("2026-02").categories[0].available, 1020000);
});
test("transferencias y tarjeta no duplican patrimonio ni gastos", (t) => {
  const b = fixture(t),
    a = b.createAccount({
      name: "Banco",
      type: "corriente",
      balance: 1000,
      date: "2026-01-01",
    }),
    card = b.createAccount({
      name: "Tarjeta",
      type: "credito",
      balance: -200,
      date: "2026-01-01",
    });
  assert.equal(b.snapshot("2026-01").ready, 800);
  b.transfer({ from: a, to: card, date: "2026-01-03", amount: 100 });
  assert.equal(
    b.snapshot("2026-01").accounts.reduce((s, a) => s + a.balance, 0),
    800,
  );
  assert.equal(b.reports("2026-01").spending.length, 0);
  assert.equal(b.snapshot("2026-01").ready, 800);
  assert.throws(() =>
    b.transfer({ from: a, to: a, date: "2026-01-03", amount: 10 }),
  );
});
test("CSV atómico, memoria y repetición sin perder dos filas legítimas iguales", (t) => {
  const b = fixture(t),
    a = b.createAccount({ name: "Banco", type: "corriente" });
  const p = {
    account_id: a,
    content:
      "Fecha;Detalle;Importe\n01/01/2026;Mercado;-80.000\n01/01/2026;Mercado;-80.000\n02/01/2026;Salario;1.000.000",
    config: {
      date: "Fecha",
      payee: "Detalle",
      amount: "Importe",
      delimiter: ";",
      dateFormat: "dmy",
      thousands: "dot",
      category_id: 1,
    },
  };
  assert.equal(b.csvPreview(p.content, p.config, a).rows.length, 3);
  assert.equal(b.accountTransactions(a).length, 0);
  assert.equal(b.importCsv(p).added, 3);
  assert.equal(b.snapshot("2026-01").ready, 1000000);
  assert.equal(b.importCsv(p).duplicates, 3);
  assert.equal(b.accountTransactions(a).length, 3);
  assert.equal(b.mapping(a).amount, "Importe");
  assert.equal(
    b.snapshot("2026-01").memory.find((x) => x.payee === "mercado").category_id,
    1,
  );
  const before = b.accountTransactions(a).length;
  assert.throws(() =>
    b.importCsv({ ...p, content: p.content + "\n31/02/2026;Error;-500" }),
  );
  assert.equal(b.accountTransactions(a).length, before);
});
test("conciliación exige cero, cuenta correcta y bloqueo posterior", (t) => {
  const b = fixture(t),
    a = b.createAccount({
      name: "Banco",
      type: "corriente",
      balance: 1000,
      date: "2026-01-01",
    }),
    other = b.createAccount({ name: "Otro", type: "efectivo" });
  const id = b.addTransaction({
      account_id: a,
      date: "2026-01-02",
      amount: -100,
      payee: "Compra",
      category_id: 1,
    }),
    opening = b.accountTransactions(a)[0].id;
  const p = {
    account_id: a,
    date: "2026-01-31",
    balance: 900,
    ids: [opening, id],
  };
  assert.equal(b.reconcile(p).difference, 0);
  assert.throws(() => b.reconcile({ ...p, balance: 899 }, true));
  assert.throws(() => b.reconcile({ ...p, account_id: other }, true));
  assert.equal(b.accountTransactions(a)[1].reconciled, 0);
  b.reconcile(p, true);
  assert.equal(b.accountTransactions(a)[1].reconciled, 1);
  assert.throws(() => b.deleteTransaction(id));
  assert.equal(b.reconcile({ ...p, ids: [] }).difference, 0);
});
test("respaldos SQLite válidos y retención de 30 copias", async (t) => {
  const b = fixture(t);
  b.createAccount({
    name: "Banco",
    type: "corriente",
    balance: 100,
    date: "2026-01-01",
  });
  const file = await b.backup();
  const copy = new Database(file, { readonly: true });
  assert.equal(copy.pragma("integrity_check", { simple: true }), "ok");
  assert.equal(copy.prepare("SELECT count(*) n FROM accounts").get().n, 1);
  copy.close();
  for (let i = 1; i <= 31; i++)
    writeFileSync(
      path.join(
        b.dir,
        "backups",
        `budget-2020-01-${String(i).padStart(2, "0")}.db`,
      ),
      "test",
    );
  await b.backup();
  assert.equal(
    readdirSync(path.join(b.dir, "backups")).filter((n) => n.endsWith(".db"))
      .length,
    30,
  );
  assert.ok(
    readdirSync(path.join(b.dir, "backups")).includes(
      "budget-" + today() + ".db",
    ),
  );
});
