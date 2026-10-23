process.env.BUDGET_DEMO = "1";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBudget } from "../src/core.js";
import { start } from "../src/server.js";
process.env.BUDGET_DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.preview-data",
);
const b = openBudget();
if (!b.snapshot().accounts.length) {
  const a = b.createAccount({
    name: "Cuenta principal",
    type: "corriente",
    balance: 4500000,
    date: "2026-10-01",
  });
  b.createAccount({
    name: "Efectivo",
    type: "efectivo",
    balance: 250000,
    date: "2026-10-01",
  });
  for (const [id, amount] of [
    [1, 900000],
    [2, 1500000],
    [3, 450000],
    [4, 350000],
    [5, 300000],
    [6, 120000],
    [7, 800000],
  ])
    b.allocate({ month: "2026-10", category_id: id, amount });
  for (const [date, payee, amount, category_id] of [
    ["2026-10-02", "Supermercado", -185000, 1],
    ["2026-10-03", "Alquiler", -1500000, 2],
    ["2026-10-04", "Internet", -150000, 3],
    ["2026-10-06", "Combustible", -160000, 4],
    ["2026-10-09", "Cena", -120000, 5],
  ])
    b.addTransaction({ account_id: a, date, payee, amount, category_id });
}
b.close();
await start();
