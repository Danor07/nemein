import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { openBudget } from "../src/core.js";
import { externalBackup } from "../src/backup.js";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nemein-backup-"));
  const b = openBudget(path.join(root, "data"));
  t.after(() => {
    if (b.db.open) b.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, b };
}
test("external backup preserves WAL data, separates identities and never replaces an earlier copy", async (t) => {
  const { root, b } = fixture(t);
  b.createAccount({
    name: "Fixture",
    type: "efectivo",
    balance: 100,
    date: "2026-10-01",
  });
  const first = await externalBackup(b.db, root);
  b.addTransaction({
    account_id: 1,
    amount: 25,
    payee: "Income",
    date: "2026-10-02",
  });
  const second = await externalBackup(b.db, root);
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), path.dirname(second));
  assert.match(path.basename(first), /^budget-.*\.db$/);
  for (const [file, sum] of [
    [first, 100],
    [second, 125],
  ]) {
    const copy = new Database(file, { readonly: true });
    try {
      assert.equal(copy.pragma("integrity_check", { simple: true }), "ok");
      assert.equal(
        copy.prepare("SELECT SUM(amount) n FROM transactions").get().n,
        sum,
      );
    } finally {
      copy.close();
    }
  }
  assert.equal(
    readdirSync(path.dirname(first)).filter((n) => n.endsWith(".db")).length,
    2,
  );
  assert.equal(
    readdirSync(path.dirname(first)).some((n) => n.endsWith(".tmp")),
    false,
  );
  const other = openBudget(path.join(root, "other"));
  try {
    assert.notEqual(
      path.dirname(await externalBackup(other.db, root)),
      path.dirname(first),
    );
  } finally {
    other.close();
  }
});
test("window daily backups stay local even with an absent external destination", async (t) => {
  const { root, b } = fixture(t);
  const previous = process.env.BUDGET_BACKUP_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.BUDGET_BACKUP_DIR;
    else process.env.BUDGET_BACKUP_DIR = previous;
  });
  delete process.env.BUDGET_BACKUP_DIR;
  const file = await b.backup();
  process.env.BUDGET_BACKUP_DIR = path.join(root, "disconnected");
  assert.equal(path.dirname(file), path.join(b.dir, "backups"));
  assert.equal(await b.dailyBackup(), file);
  assert.equal(readdirSync(path.join(b.dir, "backups")).length, 1);
  await assert.rejects(b.backup());
  assert.equal(existsSync(process.env.BUDGET_BACKUP_DIR), false);
});
test("external backup folders come only from an absolute path and a canonical identity", async (t) => {
  const { root, b } = fixture(t);
  for (const value of [null, 3, "", "relative"])
    await assert.rejects(externalBackup(b.db, value), {
      message: "BUDGET_BACKUP_DIR debe ser una carpeta absoluta existente.",
    });
  const hex = "a".repeat(36);
  for (const source of [
    "aaaaurn:uuid:" + "a".repeat(32),
    "urn:uuid:../" + hex,
    "urn:uuid:" + hex + "/../x",
  ]) {
    const fake = {
      prepare: () => ({ get: () => ({ source }) }),
      backup: async (file) => writeFileSync(file, "copy"),
    };
    await assert.rejects(externalBackup(fake, root), /Identidad/);
  }
  assert.deepEqual(readdirSync(root), ["data"]);
});
test("external backup rejects missing/non-directory destinations and cleans incomplete files", async (t) => {
  const { root, b } = fixture(t);
  for (const value of [null, 3, "", "relative", path.join(root, "absent")])
    await assert.rejects(externalBackup(b.db, value));
  const file = path.join(root, "file");
  writeFileSync(file, "original");
  await assert.rejects(externalBackup(b.db, file), /carpeta/);
  const fake = {
    prepare: () => ({ get: () => ({ source: "urn:uuid:" + "a".repeat(36) }) }),
    backup: async (temp) => {
      writeFileSync(temp, "partial");
      throw Error("offline");
    },
  };
  await assert.rejects(externalBackup(fake, root), /offline/);
  assert.deepEqual(
    readdirSync(path.join(root, "Nemein-" + "a".repeat(36))),
    [],
  );
  fake.prepare = () => ({ get: () => ({ source: "../../escape" }) });
  await assert.rejects(externalBackup(fake, root), /Identidad/);
  assert.equal(existsSync(path.join(root, "absent")), false);
});
test("CLI backup works with window closed, requires its own grant and fails for an absent drive", (t) => {
  const { root, b } = fixture(t),
    c = b.createConnection({ label: "Backup task" });
  const env = {
    ...process.env,
    BUDGET_DATA_DIR: b.dir,
    BUDGET_AGENT_TOKEN: c.token,
    BUDGET_AGENT_TOKEN_FILE: "",
    BUDGET_BACKUP_DIR: root,
  };
  const run = () =>
    spawnSync(process.execPath, ["src/cli.js", "backup"], {
      env,
      encoding: "utf8",
      timeout: 15000,
    });
  let result = run();
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, "PERMISSION_DENIED");
  b.setRule({ connection_id: c.id, action: "backup", decision: "allow" });
  b.close();
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(JSON.parse(result.stdout).result), true);
  env.BUDGET_BACKUP_DIR = path.join(root, "disconnected");
  result = run();
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).ok, false);
  assert.equal(existsSync(env.BUDGET_BACKUP_DIR), false);
});
