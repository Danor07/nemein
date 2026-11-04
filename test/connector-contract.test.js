import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateImportBatch } from "../src/import-contract.js";

// The Rust tests produce these bytes from the component and the native build;
// here the host's own validator and an independent reading of the CSV check them.
const read = (path) =>
  readFileSync(
    new URL("../src-tauri/connector/" + path, import.meta.url),
    "utf8",
  );
const fixture = (name) => read("examples/fictitious-bank-csv/fixtures/" + name);

test("connector example: golden batch passes the v1 contract and repeats its manifest", () => {
  const text = fixture("extracto.batch.json");
  // Compact JSON on one line, as `parse` returns it.
  assert.equal(text.indexOf("\n"), text.length - 1);
  const batch = JSON.parse(text);
  const before = structuredClone(batch);
  assert.equal(validateImportBatch(batch), batch);
  assert.deepEqual(batch, before);
  assert.equal(JSON.stringify(batch) + "\n", text);
  const manifest = JSON.parse(fixture("manifest.json"));
  assert.deepEqual(batch.provenance, {
    source: "banco-ficticio:FIC-0001",
    connector: manifest.id,
    version: manifest.version,
  });
  assert.equal(batch.account_id, 1);
  assert.deepEqual(batch.period, { from: "2026-10-01", to: "2026-10-31" });
  assert.ok(batch.entries.every((entry) => entry.category_id === null));
});

test("connector example: identities are SHA-256 of JSON.stringify without the version", () => {
  const batch = JSON.parse(fixture("extracto.batch.json"));
  const manifest = JSON.parse(fixture("manifest.json"));
  const lines = fixture("extracto.csv").trimEnd().split(/\r?\n/);
  const account = lines.find((line) => line.startsWith("Cuenta;")).slice(7);
  const rows = lines
    .slice(lines.indexOf("Fecha;Referencia;Descripción;Débito;Crédito") + 1)
    .map((line) => line.split(";"));
  assert.equal(rows.length, batch.entries.length);
  rows.forEach((row, index) => {
    // Date and reference come first and amounts last; only descriptions are quoted.
    const [date, reference] = row;
    const [debit, credit] = row.slice(-2);
    const entry = batch.entries[index];
    assert.equal(entry.date, date);
    assert.equal(entry.amount, debit ? -Number(debit) : Number(credit));
    assert.equal(
      entry.id,
      createHash("sha256")
        .update(JSON.stringify([manifest.id, "1", account, reference]))
        .digest("hex"),
    );
  });
  assert.equal(batch.entries[2].payee, "Farmacia; turno noche");
  assert.equal(batch.entries[3].payee, 'Librería "El Ejemplo"');
});

test("connector WIT: one exported interface and nothing imported", () => {
  const code = read("sdk/wit/world.wit").replace(/\/\/.*$/gm, "");
  assert.match(code, /^\s*package nemein:connector@1\.0\.0;/);
  const worlds = [...code.matchAll(/\bworld\s+([\w-]+)\s*\{([^}]*)\}/g)];
  assert.deepEqual(
    worlds.map(([, name, body]) => [name, body.trim()]),
    [["connector", "export api;"]],
  );
  assert.doesNotMatch(code, /\b(import|use|include)\b/);
  assert.match(code, /\bdescribe: func\(\) -> manifest;/);
  assert.match(
    code,
    /\bparse: func\(input: list<u8>, ctx: context\) -> result<string, error>;/,
  );
  assert.match(
    code,
    /record context \{\s*config: string,\s*account-id: string,\s*\}/,
  );
});
