import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { openBudget } from "../../src/core.js";
import { validateImportBatch } from "../../src/import-contract.js";
import {
  base64,
  batchFor,
  fakeRunner,
  manifest,
  statement,
} from "../helpers/connector-budget.js";

// A fault is a refusal the host meant: an Error, never a crash of the module.
const refused = (e) =>
  e instanceof Error &&
  !(e instanceof TypeError) &&
  !(e instanceof RangeError) &&
  !(e instanceof SyntaxError) &&
  !(e instanceof ReferenceError);

function budget(t, run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-connectors-fuzz-"));
  const b = openBudget(dir, { runConnector: run });
  t.after(() => {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const account = b.createAccount({ name: "Ficticia", type: "corriente" });
  const category = b.createCategory({
    name: "Varios",
    group_id: b.createGroup({ name: "G" }),
  });
  return { b, dir, account, category };
}

// Random edits of the golden batch: what a lying or broken connector returns.
const edit = fc.oneof(
  fc.record({
    kind: fc.constant("drop"),
    key: fc.constantFrom(
      "version",
      "provenance",
      "period",
      "currency",
      "amount_unit",
      "account_id",
      "entries",
    ),
  }),
  fc.record({
    kind: fc.constant("set"),
    key: fc.constantFrom(
      "version",
      "currency",
      "account_id",
      "entries",
      "period",
    ),
    value: fc.jsonValue(),
  }),
  fc.record({
    kind: fc.constant("entry"),
    index: fc.nat({ max: 6 }),
    key: fc.constantFrom(
      "id",
      "date",
      "payee",
      "amount",
      "category_id",
      "extra",
    ),
    value: fc.jsonValue(),
  }),
  fc.record({ kind: fc.constant("duplicate"), index: fc.nat({ max: 4 }) }),
);
function apply(batch, edits) {
  const out = structuredClone(batch);
  for (const e of edits) {
    if (e.kind === "drop") delete out[e.key];
    else if (e.kind === "set") out[e.key] = e.value;
    else if (
      e.kind === "duplicate" &&
      Array.isArray(out.entries) &&
      out.entries[e.index]
    )
      out.entries.push(structuredClone(out.entries[e.index]));
    else if (
      e.kind === "entry" &&
      Array.isArray(out.entries) &&
      out.entries[e.index]
    )
      out.entries[e.index][e.key] = e.value;
  }
  return out;
}

test("fuzz: a lying connector's batches are stored valid or refused", async (t) => {
  const state = { edits: [] };
  const run = fakeRunner(async (request) =>
    request.op === "describe"
      ? { manifest }
      : { manifest, batch: apply(batchFor(request.accountId), state.edits) },
  );
  const { b, account, category } = budget(t, run);
  const { hash } = await b.installConnector({
    component_base64: base64("componente"),
  });
  b.enableConnector({ acknowledge_unsigned: true, hash });
  await fc.assert(
    fc.asyncProperty(fc.array(edit, { maxLength: 3 }), async (edits) => {
      state.edits = edits;
      let prepared;
      try {
        prepared = await b.prepareConnectorImport({
          hash,
          account_id: account,
          content_base64: base64(statement),
          category_id: category,
        });
      } catch (e) {
        assert.ok(refused(e), String(e?.stack ?? e));
        return;
      }
      const row = b.db
        .prepare("SELECT * FROM connector_batches WHERE id=?")
        .get(prepared.id);
      const stored = validateImportBatch(JSON.parse(row.batch));
      assert.equal(stored.account_id, account);
      // Leave room for the next run.
      b.db.prepare("DELETE FROM connector_batches").run();
    }),
    { seed: 640001, numRuns: 250 },
  );
});

test("fuzz: arbitrary confirmation arguments are refused with a code", async (t) => {
  const { b, account, category } = budget(t, fakeRunner());
  const { hash } = await b.installConnector({
    component_base64: base64("componente"),
  });
  b.enableConnector({ acknowledge_unsigned: true, hash });
  const prepared = await b.prepareConnectorImport({
    hash,
    account_id: account,
    content_base64: base64(statement),
    category_id: category,
  });
  fc.assert(
    fc.property(
      fc.record(
        {
          id: fc.oneof(fc.jsonValue(), fc.constant(prepared.id)),
          batch_sha256: fc.oneof(
            fc.jsonValue(),
            fc.stringMatching(/^[0-9a-f]{64}$/),
          ),
          rows: fc.jsonValue(),
        },
        { requiredKeys: [] },
      ),
      (args) => {
        try {
          b.confirmConnectorImport(args);
          assert.fail("only the reviewed hash confirms");
        } catch (e) {
          assert.ok(
            typeof e.code === "string" && e.code.startsWith("CONNECTOR_"),
            String(e?.stack ?? e),
          );
        }
      },
    ),
    { seed: 640002, numRuns: 400 },
  );
  assert.equal(b.accountTransactions(account).length, 0);
});

test("fuzz: a damaged inventory never runs a connector and never crashes", async (t) => {
  const run = fakeRunner();
  const { b, dir, account, category } = budget(t, run);
  const { hash } = await b.installConnector({
    component_base64: base64("componente"),
  });
  b.enableConnector({ acknowledge_unsigned: true, hash });
  const file = path.join(dir, "connectors", "inventory.json");
  await fc.assert(
    fc.asyncProperty(fc.oneof(fc.jsonValue(), fc.string()), async (value) => {
      writeFileSync(
        file,
        typeof value === "string" ? value : JSON.stringify(value),
      );
      const calls = run.calls.length;
      try {
        await b.prepareConnectorImport({
          hash,
          account_id: account,
          content_base64: base64(statement),
          category_id: category,
        });
        assert.fail("a damaged inventory runs nothing");
      } catch (e) {
        assert.ok(refused(e), String(e?.stack ?? e));
        assert.equal(run.calls.length, calls, "no connector ran");
      }
    }),
    { seed: 640003, numRuns: 200 },
  );
});
