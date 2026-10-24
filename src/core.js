import { migrate } from "./migrations.js";
import { attachAccess } from "./access.js";
import { attachEvents } from "./events.js";
import Database from "better-sqlite3";
import { planning } from "./planning.js";

import {
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const defaultDir = () =>
  process.env.BUDGET_DATA_DIR ||
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"),
    "PresupuestoCero",
  );
export function date(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number(value.slice(0, 4)) < 1900 ||
    Number(value.slice(0, 4)) > 2200 ||
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) !== value
  )
    throw Error("Fecha inválida. Usá una fecha real entre 1900 y 2200.");
  return value;
}
export function month(value) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value))
    throw Error("Mes inválido.");
  date(value + "-01");
  return value;
}
export function money(value) {
  const s = String(value ?? "").trim();
  if (
    !/^-?\d+$/.test(s) ||
    !Number.isSafeInteger(Number(s)) ||
    Math.abs(Number(s)) > 1e12
  )
    throw Error(
      "Ingresá guaraníes enteros, sin puntos ni decimales (máximo 1 billón).",
    );
  return Number(s);
}
const text = (v) => {
  if (typeof v !== "string" || !v.trim() || v.length > 160)
    throw Error("El nombre es obligatorio y admite hasta 160 caracteres.");
  return v.trim();
};
export function openBudget(dir = defaultDir()) {
  mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "budget.db"));
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    migrate(db);
    db.pragma("journal_mode = WAL");
  } catch (error) {
    db.close();
    throw error;
  }
  const all = (sql, ...args) => db.prepare(sql).all(...args),
    one = (sql, ...args) => db.prepare(sql).get(...args),
    run = (sql, ...args) => db.prepare(sql).run(...args);
  const account = (id) => {
    const a = one("SELECT * FROM accounts WHERE id=?", Number(id));
    if (!a) throw Error("La cuenta no existe.");
    return a;
  };
  const category = (id) => {
    if (!one("SELECT id FROM categories WHERE id=?", Number(id)))
      throw Error("La categoría no existe.");
    return Number(id);
  };
  function addTransaction(p) {
    account(p.account_id);
    date(p.date);
    const amount = money(p.amount);
    if (amount === 0) throw Error("El importe no puede ser cero.");
    const payee = text(p.payee),
      cat = p.category_id ? category(p.category_id) : null;
    if (amount < 0 && !cat) throw Error("Elegí una categoría para el gasto.");
    return db.transaction(() => {
      const r = run(
        "INSERT INTO transactions(account_id,date,payee,amount,category_id) VALUES (?,?,?,?,?)",
        Number(p.account_id),
        p.date,
        payee,
        amount,
        cat,
      );
      if (cat)
        run(
          "INSERT INTO memory VALUES (?,?) ON CONFLICT(payee) DO UPDATE SET category_id=excluded.category_id",
          payee.toLocaleLowerCase("es"),
          cat,
        );
      return Number(r.lastInsertRowid);
    })();
  }
  function snapshot(m = today().slice(0, 7)) {
    month(m);
    const end = m + "-31";
    const categories = all(
      `SELECT c.*,g.name group_name,COALESCE((SELECT amount FROM allocations WHERE category_id=c.id AND month=?),0) assigned,
 COALESCE((SELECT SUM(amount) FROM transactions WHERE category_id=c.id AND kind='normal' AND substr(date,1,7)=?),0) activity,
 COALESCE((SELECT SUM(amount) FROM allocations WHERE category_id=c.id AND month<=?),0)+COALESCE((SELECT SUM(amount) FROM transactions WHERE category_id=c.id AND kind='normal' AND date<=?),0) available FROM categories c JOIN groups_ g ON g.id=c.group_id ORDER BY g.id,c.id`,
      m,
      m,
      m,
      end,
    );
    const income = one(
      "SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE date<=? AND category_id IS NULL AND kind!='transfer'",
      end,
    ).n;
    // Every assigned guarani is reserved, including assignments in future months.
    const allocated = one(
      "SELECT COALESCE(SUM(amount),0) n FROM allocations",
    ).n;
    return {
      month: m,
      ready: income - allocated,
      categories,
      groups: all("SELECT * FROM groups_"),
      accounts: all(
        "SELECT a.*,COALESCE(SUM(t.amount),0) balance FROM accounts a LEFT JOIN transactions t ON t.account_id=a.id GROUP BY a.id",
      ),
      memory: all("SELECT * FROM memory"),
      transactions: all(
        "SELECT t.*,a.name account_name,c.name category_name FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN categories c ON c.id=t.category_id WHERE substr(t.date,1,7)=? ORDER BY t.date DESC,t.id DESC",
        m,
      ),
    };
  }
  function createAccount(p) {
    const name = text(p.name);
    if (!["corriente", "credito", "efectivo"].includes(p.type))
      throw Error("Tipo de cuenta inválido.");
    return db.transaction(() => {
      const id = Number(
        run("INSERT INTO accounts(name,type) VALUES (?,?)", name, p.type)
          .lastInsertRowid,
      );
      const opening = money(p.balance || 0);
      if (opening)
        run(
          "INSERT INTO transactions(account_id,date,payee,amount,kind,cleared) VALUES (?,?,?,?,'opening',1)",
          id,
          date(p.date || today()),
          "Saldo inicial",
          opening,
        );
      return id;
    })();
  }
  function allocate(p) {
    category(p.category_id);
    month(p.month);
    run(
      "INSERT INTO allocations VALUES (?,?,?) ON CONFLICT(month,category_id) DO UPDATE SET amount=excluded.amount",
      p.month,
      Number(p.category_id),
      money(p.amount),
    );
  }
  function transfer(p) {
    account(p.from);
    account(p.to);
    if (Number(p.from) === Number(p.to))
      throw Error("Elegí dos cuentas distintas.");
    const amount = money(p.amount);
    if (amount <= 0) throw Error("El importe debe ser positivo.");
    date(p.date);
    const key = crypto.randomUUID();
    return db.transaction(() => {
      run(
        "INSERT INTO transactions(account_id,date,payee,amount,kind,transfer_key) VALUES (?,?,?,?,'transfer',?)",
        Number(p.from),
        p.date,
        "Transferencia a " + account(p.to).name,
        -amount,
        key,
      );
      run(
        "INSERT INTO transactions(account_id,date,payee,amount,kind,transfer_key) VALUES (?,?,?,?,'transfer',?)",
        Number(p.to),
        p.date,
        "Transferencia desde " + account(p.from).name,
        amount,
        key,
      );
    })();
  }
  function reconcile(p, commit = false) {
    account(p.account_id);
    date(p.date);
    const target = money(p.balance);
    const ids = [...new Set((p.ids || []).map(Number))];
    if (ids.some((id) => !Number.isSafeInteger(id)))
      throw Error("Selección inválida.");
    return db.transaction(() => {
      const tx = all(
        "SELECT * FROM transactions WHERE account_id=? AND date<=?",
        Number(p.account_id),
        p.date,
      );
      if (ids.some((id) => !tx.some((t) => t.id === id && !t.reconciled)))
        throw Error(
          "Un movimiento seleccionado no corresponde a esta conciliación.",
        );
      const total = tx
        .filter((t) => t.reconciled || ids.includes(t.id))
        .reduce((s, t) => s + t.amount, 0);
      const diff = target - total;
      if (commit) {
        if (diff !== 0)
          throw Error("La diferencia debe ser cero antes de conciliar.");
        for (const id of ids)
          run("UPDATE transactions SET cleared=1,reconciled=1 WHERE id=?", id);
        run(
          "INSERT INTO reconciliations(account_id,date,balance) VALUES (?,?,?)",
          Number(p.account_id),
          p.date,
          target,
        );
      }
      return { total, difference: diff, target };
    })();
  }
  function csvPreview(content, cfg, accountId) {
    account(accountId);
    if (Buffer.byteLength(content) > 5e6) throw Error("El CSV supera 5 MB.");
    const delimiter = cfg.delimiter || ",";
    if (![",", ";", "\t"].includes(delimiter))
      throw Error("Separador inválido.");
    const raw = parse(content, {
      bom: true,
      skip_empty_lines: true,
      delimiter,
      columns: false,
    });
    if (!raw.length) throw Error("El archivo está vacío.");
    const headers = raw.shift();
    if (new Set(headers).size !== headers.length)
      throw Error("El CSV tiene encabezados repetidos.");
    if (raw.length > 20000) throw Error("Máximo 20.000 filas por importación.");
    const index = (k) => {
      const i = headers.indexOf(cfg[k]);
      if (i < 0) throw Error("Elegí la columna de " + k + ".");
      return i;
    };
    const di = index("date"),
      pi = index("payee"),
      ai = index("amount");
    const occurrences = new Map();
    const rows = raw.map((r, i) => {
      try {
        if (r.length !== headers.length)
          throw Error("Cantidad de columnas incorrecta.");
        let d = r[di].trim();
        if (cfg.dateFormat === "dmy") {
          const parts = d.split(/[/-]/);
          if (parts.length !== 3) throw Error("Fecha inválida.");
          d = `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
        }
        date(d);
        let a = r[ai].trim();
        if (cfg.thousands === "dot") {
          if (!/^-?(\d+|\d{1,3}(\.\d{3})+)$/.test(a))
            throw Error("Importe inválido.");
          a = a.replaceAll(".", "");
        } else if (cfg.thousands === "comma") {
          if (!/^-?(\d+|\d{1,3}(,\d{3})+)$/.test(a))
            throw Error("Importe inválido.");
          a = a.replaceAll(",", "");
        }
        const amount = money(a);
        if (!amount) throw Error("Importe cero.");
        const payee = text(r[pi]);
        const cat =
          amount < 0
            ? one(
                "SELECT category_id FROM memory WHERE payee=?",
                payee.toLocaleLowerCase("es"),
              )?.category_id ||
              (cfg.category_id ? category(cfg.category_id) : null)
            : null;
        if (amount < 0 && !cat)
          throw Error("Elegí una categoría inicial para gastos sin memoria.");
        const canonical = JSON.stringify([
          Number(accountId),
          d,
          payee.toLocaleLowerCase("es"),
          amount,
        ]);
        const occurrence = (occurrences.get(canonical) || 0) + 1;
        occurrences.set(canonical, occurrence);
        const key = createHash("sha256")
          .update(canonical + "#" + occurrence)
          .digest("hex");
        return {
          date: d,
          payee,
          amount,
          category_id: cat,
          import_key: key,
          duplicate: !!one(
            "SELECT id FROM transactions WHERE import_key=?",
            key,
          ),
        };
      } catch (e) {
        throw Error(`Fila ${i + 2}: ${e.message}`, {cause:e});
      }
    });
    return { headers, rows };
  }
  function importCsv(p) {
    return db.transaction(() => {
      const preview = csvPreview(p.content, p.config, p.account_id);
      let added = 0;
      for (const row of preview.rows) {
        if (row.duplicate) continue;
        const id = addTransaction({ ...row, account_id: p.account_id });
        run(
          "UPDATE transactions SET import_key=?,cleared=1 WHERE id=?",
          row.import_key,
          id,
        );
        added++;
      }
      run(
        "INSERT INTO mappings VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET config=excluded.config",
        Number(p.account_id),
        JSON.stringify(p.config),
      );
      return { added, duplicates: preview.rows.length - added };
    })();
  }
  function reports(m) {
    month(m);
    const spending = all(
      "SELECT c.name,MAX(0,-SUM(t.amount)) amount FROM transactions t JOIN categories c ON c.id=t.category_id WHERE substr(date,1,7)=? AND kind='normal' GROUP BY c.id HAVING SUM(t.amount)<0",
      m,
    );
    const history = [];
    const [y, mo] = m.split("-").map(Number);
    for (let i = 11; i >= 0; i--) {
      const dt = new Date(Date.UTC(y, mo - 1 - i, 1)),
        key = dt.toISOString().slice(0, 7);
      history.push({
        month: key,
        value: one(
          "SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE date<=?",
          key + "-31",
        ).n,
      });
    }
    return { spending, history };
  }
  let backing;
  async function backup() {
    if (backing) return backing;
    backing = (async () => {
      const folder = path.join(dir, "backups");
      mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `budget-${today()}.db`);
      if (!existsSync(file)) {
        const temp = file + "." + process.pid + ".tmp";
        try {
          await db.backup(temp);
          if (!existsSync(file)) renameSync(temp, file);
        } finally {
          if (existsSync(temp)) unlinkSync(temp);
        }
      }
      const files = readdirSync(folder)
        .filter((n) => /^budget-\d{4}-\d{2}-\d{2}\.db$/.test(n))
        .sort()
        .reverse();
      for (const f of files.slice(30)) unlinkSync(path.join(folder, f));
      return file;
    })();
    try {
      return await backing;
    } finally {
      backing = null;
    }
  }
  const budget = {
    db,
    dir,
    snapshot,
    createAccount,
    addTransaction,
    allocate,
    transfer,
    reconcile,
    csvPreview,
    importCsv,
    reports,
    backup,
    categorize: (p) => {
      const t = one(
        "SELECT * FROM transactions WHERE id=? AND kind='normal'",
        Number(p.id),
      );
      if (!t) throw Error("Este movimiento no admite categorías.");
      const cat = p.category_id ? category(p.category_id) : null;
      if (t.amount < 0 && !cat) throw Error("Un gasto necesita categoría.");
      return db.transaction(() => {
        run("UPDATE transactions SET category_id=? WHERE id=?", cat, t.id);
        if (cat)
          run(
            "INSERT INTO memory VALUES (?,?) ON CONFLICT(payee) DO UPDATE SET category_id=excluded.category_id",
            t.payee.toLocaleLowerCase("es"),
            cat,
          );
      })();
    },
    createGroup: (p) =>
      Number(
        run("INSERT INTO groups_(name) VALUES (?)", text(p.name))
          .lastInsertRowid,
      ),
    createCategory: (p) => {
      if (!one("SELECT id FROM groups_ WHERE id=?", Number(p.group_id)))
        throw Error("Grupo inexistente.");
      return Number(
        run(
          "INSERT INTO categories(group_id,name) VALUES (?,?)",
          Number(p.group_id),
          text(p.name),
        ).lastInsertRowid,
      );
    },
    mapping: (id) =>
      JSON.parse(
        one("SELECT config FROM mappings WHERE account_id=?", Number(id))
          ?.config || "{}",
      ),
    accountTransactions: (id) => {
      account(id);
      return all(
        "SELECT * FROM transactions WHERE account_id=? ORDER BY date,id",
        Number(id),
      );
    },
    deleteTransaction: (id) => {
      const t = one("SELECT * FROM transactions WHERE id=?", Number(id));
      if (!t) throw Error("Movimiento inexistente.");
      if (
        t.reconciled ||
        (t.transfer_key &&
          one(
            "SELECT id FROM transactions WHERE transfer_key=? AND reconciled=1",
            t.transfer_key,
          ))
      )
        throw Error("No se puede borrar un movimiento conciliado.");
      if (t.transfer_key)
        run("DELETE FROM transactions WHERE transfer_key=?", t.transfer_key);
      else run("DELETE FROM transactions WHERE id=?", Number(id));
    },
    close: () => db.close(),
  };
  return attachAccess(attachEvents(Object.assign(budget, planning(budget, { money, date, month, today }))));
}
