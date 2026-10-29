import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../src/contracts/import-batch.v1.schema.json" with { type: "json" };
import vectors from "./fixtures/import-vectors.json" with { type: "json" };
import { csvImportBatch, validateImportBatch } from "../src/import-contract.js";
import { date } from "../src/date.js";

test("import v1: shared connector vectors and strict schema compile", () => {
  const check = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(schema.$id, vectors.contract);
  for (const { name, batch } of vectors.valid) {
    const before = structuredClone(batch);
    assert.equal(check(batch), true, name);
    assert.equal(validateImportBatch(batch), batch, name);
    assert.deepEqual(batch, before);
  }
  for (const { name, code, batch } of vectors.invalid) {
    const before = structuredClone(batch);
    assert.throws(
      () => validateImportBatch(batch),
      (error) => {
        assert.equal(error.code, code, name);
        assert.ok(error.message.length > 0, name);
        if (code === "IMPORT_INVALID_DATE") {
          assert.ok(error.cause instanceof Error);
          assert.equal(error.message, error.cause.message);
        }
        return true;
      },
    );
    assert.deepEqual(batch, before);
  }
});

test("import v1: closed objects, required fields and exact scalar boundaries", () => {
  const sample = () => structuredClone(vectors.valid[0].batch);
  for (const invalid of [null, [], {}, true, "{}", 1])
    assert.throws(() => validateImportBatch(invalid), {
      code: "IMPORT_INVALID_BATCH",
    });
  for (const path of [[], ["provenance"], ["period"], ["entries", 0]]) {
    const b = sample();
    const object = path.reduce((value, key) => value[key], b);
    for (const key of Object.keys(object)) {
      const value = object[key];
      delete object[key];
      assert.throws(
        () => validateImportBatch(b),
        { code: "IMPORT_INVALID_BATCH" },
        key,
      );
      object[key] = value;
    }
    object.extra = "untrusted";
    assert.throws(() => validateImportBatch(b), {
      code: "IMPORT_INVALID_BATCH",
    });
  }
  const cases = [
    (b) => {
      b.account_id = 0;
    },
    (b) => {
      b.account_id = 1.5;
    },
    (b) => {
      b.account_id = Number.MAX_SAFE_INTEGER + 1;
    },
    (b) => {
      b.amount_unit = "cents";
    },
    (b) => {
      b.provenance.source = " ";
    },
    (b) => {
      b.provenance.source = "a".repeat(513);
    },
    (b) => {
      b.provenance.connector = "a".repeat(161);
    },
    (b) => {
      b.provenance.version = "a".repeat(81);
    },
    (b) => {
      b.entries[0].payee = "a".repeat(161);
    },
    (b) => {
      b.entries[0].amount = -1000000000001;
    },
    (b) => {
      b.entries[0].amount = NaN;
    },
    (b) => {
      b.entries[0].amount = Infinity;
    },
    (b) => {
      b.entries[0].category_id = -1;
    },
    (b) => {
      b.entries[0].category_id = "1";
    },
    (b) => {
      b.entries[0].date = "2024-2-29";
    },
  ];
  for (const change of cases) {
    const b = sample();
    change(b);
    assert.throws(() => validateImportBatch(b), {
      code: "IMPORT_INVALID_BATCH",
    });
  }
  const b = sample();
  b.provenance.source = "a".repeat(512);
  b.provenance.connector = "a".repeat(160);
  b.provenance.version = "a".repeat(80);
  b.entries[0].payee = "a".repeat(160);
  b.account_id = Number.MAX_SAFE_INTEGER;
  b.entries[0].category_id = Number.MAX_SAFE_INTEGER;
  assert.equal(validateImportBatch(b), b);
});

test("import v1: date limits, inclusive coverage, empty and maximum batches", () => {
  const b = structuredClone(vectors.valid[0].batch);
  b.period = null;
  for (const day of ["1900-01-01", "2200-12-31", "2000-02-29"])
    assert.equal(
      validateImportBatch({ ...b, entries: [{ ...b.entries[0], date: day }] })
        .entries[0].date,
      day,
    );
  for (const day of [
    "1899-12-31",
    "2201-01-01",
    "1900-02-29",
    "2024-00-01",
    "2024-13-01",
    "2024-01-00",
  ])
    assert.throws(
      () =>
        validateImportBatch({
          ...b,
          entries: [{ ...b.entries[0], date: day }],
        }),
      { code: "IMPORT_INVALID_DATE" },
    );
  for (const period of [
    { from: "2024-02-30", to: "2024-03-01" },
    { from: "2201-01-01", to: "2201-01-02" },
  ])
    assert.throws(() => validateImportBatch({ ...b, period, entries: [] }), {
      code: "IMPORT_INVALID_DATE",
    });
  for (const day of ["2024-02-01", "2024-02-29"])
    assert.equal(
      validateImportBatch({
        ...b,
        period: { from: "2024-02-01", to: "2024-02-29" },
        entries: [{ ...b.entries[0], date: day }],
      }).entries[0].date,
      day,
    );
  b.entries = [];
  assert.equal(validateImportBatch(b), b);
  b.entries = Array.from({ length: 20000 }, (_, i) => ({
    ...vectors.valid[0].batch.entries[0],
    id: i.toString(16).padStart(64, "0"),
  }));
  assert.equal(validateImportBatch(b).entries.length, 20000);
  b.entries.push({ ...b.entries[0], id: "f".repeat(64) });
  assert.throws(() => validateImportBatch(b), { code: "IMPORT_INVALID_BATCH" });
});

test("shared domain date keeps its validation and return value", () => {
  for (const day of ["1900-01-01", "2200-12-31", "2000-02-29", "2026-10-28"])
    assert.equal(date(day), day);
  for (const value of [
    null,
    undefined,
    20260101,
    {},
    "",
    "2024-2-29",
    "2024-02-9",
    "24-02-29",
    "02024-02-29",
    "x2024-02-29",
    "2024-02-29x",
    "2024/02/29",
    "2024-02/29",
    "1899-12-31",
    "2201-01-01",
    "1900-02-29",
    "2024-04-31",
    Object("2024-02-29"),
  ])
    assert.throws(() => date(value), {
      message: "Fecha inválida. Usá una fecha real entre 1900 y 2200.",
    });
  for (const value of ["2024-00-01", "2024-13-01", "2024-01-00"])
    assert.throws(() => date(value), {
      name: "RangeError",
      message: "Invalid time value",
    });
});

test("CSV producer declares provenance and unknown coverage without mutating entries", () => {
  const entries = structuredClone(vectors.valid[0].batch.entries);
  const before = structuredClone(entries);
  assert.deepEqual(csvImportBatch(7, entries), {
    version: 1,
    provenance: { source: "csv", connector: "nemein.csv", version: "1" },
    period: null,
    currency: "PYG",
    amount_unit: "integer",
    account_id: 7,
    entries: before,
  });
  assert.deepEqual(entries, before);
  assert.deepEqual(csvImportBatch(1, []).entries, []);
  assert.throws(() => csvImportBatch(0, entries), {
    code: "IMPORT_INVALID_BATCH",
  });
  assert.throws(() => csvImportBatch(1, [{ ...entries[0], amount: 0 }]), {
    code: "IMPORT_INVALID_BATCH",
  });
});
