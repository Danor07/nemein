import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import {
  canonicalJson,
  decodeBase64,
  enablementHolds,
  sha256,
  validateInventory,
} from "../../src/connectors.js";
import { LIMITS } from "../../src/connector-runner.js";
import { openBudget } from "../../src/core.js";
import {
  base64,
  batchFor,
  fakeRunner,
  manifest,
  statement,
} from "../helpers/connector-budget.js";

const hex = fc.stringMatching(/^[0-9a-f]{64}$/);

test("PBT: an enablement holds exactly when this budget's audit recorded it", () => {
  // Every fact is right most of the time, so single faults are frequent. The
  // oracle states the rule in one boolean expression, apart from the code.
  const mostly = (good, ...bad) =>
    fc.oneof(
      { weight: 4, arbitrary: fc.constant(good) },
      { weight: 1, arbitrary: fc.constantFrom(...bad) },
    );
  const other = (hex) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
  fc.assert(
    fc.property(
      hex,
      hex,
      fc.record({
        enabledEntry: mostly(true, false),
        sameSource: mostly(true, false),
        revokedAfter: mostly(false, true),
        row: mostly(true, false),
        actor: mostly("owner", "agente", "Owner"),
        action: mostly("connector-enable", "connector-revoke", "connectors"),
        decision: mostly("allow", "error", "deny"),
        args: mostly(
          "valid",
          "other-hash",
          "other-token",
          "swapped",
          "empty",
          "{",
          "null",
          "7",
          '"texto"',
        ),
      }),
      (hash, token, f) => {
        const entry = {
          hash,
          enablement: f.enabledEntry
            ? { token, audit: 7, at: "2026-11-04T00:00:00Z" }
            : null,
        };
        const args =
          {
            valid: JSON.stringify({ hash, token }),
            "other-hash": JSON.stringify({ hash: other(hash), token }),
            "other-token": JSON.stringify({ hash, token: other(token) }),
            swapped: JSON.stringify({ hash: token, token: hash }),
            empty: "{}",
          }[f.args] ?? f.args;
        const enabled = f.row
          ? { actor: f.actor, action: f.action, decision: f.decision, args }
          : undefined;
        const expected =
          f.enabledEntry &&
          f.sameSource &&
          !f.revokedAfter &&
          f.row &&
          f.actor === "owner" &&
          f.action === "connector-enable" &&
          f.decision === "allow" &&
          (f.args === "valid" || (f.args === "swapped" && hash === token));
        assert.equal(
          enablementHolds(entry, {
            inventorySource: "urn:a",
            source: f.sameSource ? "urn:a" : "urn:b",
            enabled,
            revokedAfter: f.revokedAfter,
          }),
          expected,
        );
      },
    ),
    { seed: 630001, numRuns: 800 },
  );
});

test("PBT: the batch hash ignores key order and nothing else", () => {
  const shuffle = (value, seed) => {
    if (Array.isArray(value)) return value.map((v, i) => shuffle(v, seed + i));
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      const order = seed % 2 ? keys.reverse() : keys;
      return Object.fromEntries(
        order.map((k) => [k, shuffle(value[k], seed + 1)]),
      );
    }
    return value;
  };
  fc.assert(
    fc.property(
      fc.jsonValue(),
      fc.nat(),
      fc.jsonValue(),
      (value, seed, other) => {
        const text = canonicalJson(value);
        assert.equal(canonicalJson(shuffle(value, seed)), text);
        assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(value)));
        // Different JSON values never share a canonical text.
        if (canonicalJson(other) === text)
          assert.deepEqual(JSON.parse(JSON.stringify(other)), JSON.parse(text));
      },
    ),
    { seed: 630002, numRuns: 300 },
  );
});

test("PBT: base64 decodes exactly the canonical encoding within the limit", () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ maxLength: 64 }),
      fc.nat({ max: 70 }),
      (bytes, limit) => {
        const text = Buffer.from(bytes).toString("base64");
        if (bytes.length <= limit)
          assert.deepEqual(decodeBase64(text, limit, "x"), Buffer.from(bytes));
        else
          assert.throws(() => decodeBase64(text, limit, "x"), {
            code: "CONNECTOR_REQUEST_INVALID",
          });
      },
    ),
    { seed: 630003, numRuns: 400 },
  );
  // Anything that is not the canonical encoding of its own bytes is refused.
  fc.assert(
    fc.property(fc.string({ maxLength: 24 }), (text) => {
      const canonical = Buffer.from(text, "base64").toString("base64") === text;
      if (canonical)
        assert.equal(decodeBase64(text, 1000, "x").toString("base64"), text);
      else
        assert.throws(() => decodeBase64(text, 1000, "x"), {
          code: "CONNECTOR_REQUEST_INVALID",
        });
    }),
    { seed: 630004, numRuns: 600 },
  );
});

test("PBT: a valid inventory is accepted and any one damaged field fails closed", () => {
  // The bounds themselves are valid, and generated often.
  const entry = fc.record({
    hash: hex,
    manifest: fc.constant(manifest),
    size: fc.oneof(
      fc.constantFrom(1, LIMITS.component),
      fc.integer({ min: 1, max: LIMITS.component }),
    ),
    installed_at: fc.constant("2026-11-04T12:00:00.000Z"),
    enablement: fc.option(
      fc.record({
        token: hex,
        audit: fc.oneof(fc.constant(1), fc.integer({ min: 1, max: 1e9 })),
        at: fc.constant("2026-11-04T12:00:00.000Z"),
      }),
      { nil: null },
    ),
  });
  const damage = [
    (e) => ({ ...e, hash: e.hash.toUpperCase() + "g" }),
    (e) => ({ ...e, hash: "x" + e.hash }),
    (e) => ({ ...e, hash: e.hash + "0" }),
    (e) => ({ ...e, hash: [e.hash] }),
    (e) => ({ ...e, size: 0 }),
    (e) => ({ ...e, size: LIMITS.component + 1 }),
    (e) => ({ ...e, size: 1.5 }),
    (e) => ({ ...e, installed_at: "ayer" }),
    // Date.parse would read these; only text is a time.
    (e) => ({ ...e, installed_at: 2026 }),
    (e) => ({ ...e, installed_at: ["2026-11-04"] }),
    (e) => ({ ...e, manifest: { ...manifest, id: "Mayúsculas" } }),
    (e) => ({ ...e, enablement: { token: "x", audit: 1, at: e.installed_at } }),
    (e) => ({
      ...e,
      enablement: { token: e.hash, audit: 0, at: e.installed_at },
    }),
    (e) => ({ ...e, enablement: { token: e.hash, audit: 1, at: "nunca" } }),
    (e) => ({ ...e, enablement: undefined }),
  ];
  fc.assert(
    fc.property(
      fc.uniqueArray(entry, { selector: (e) => e.hash, maxLength: 4 }),
      fc.nat(),
      fc.nat({ max: damage.length - 1 }),
      (connectors, which, how) => {
        const inventory = {
          version: 1,
          source: "urn:uuid:ficticio",
          connectors,
        };
        assert.equal(validateInventory(inventory), inventory);
        for (const broken of [
          null,
          [],
          { ...inventory, version: 2 },
          { ...inventory, source: 7 },
          { ...inventory, source: undefined },
          { ...inventory, connectors: { ...connectors } },
        ])
          assert.throws(() => validateInventory(broken), {
            code: "CONNECTOR_INVENTORY_INVALID",
          });
        if (!connectors.length) return;
        const i = which % connectors.length;
        const broken = connectors.map((e, j) => (j === i ? damage[how](e) : e));
        assert.throws(
          () => validateInventory({ ...inventory, connectors: broken }),
          {
            code: "CONNECTOR_INVENTORY_INVALID",
          },
        );
        assert.throws(
          () =>
            validateInventory({
              ...inventory,
              connectors: [...connectors, connectors[i]],
            }),
          { code: "CONNECTOR_INVENTORY_INVALID" },
        );
      },
    ),
    { seed: 630005, numRuns: 300 },
  );
});

test("PBT: confirming adds exactly the entries not yet imported, once", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(fc.nat({ max: 4 }), { maxLength: 5 }),
      async (known) => {
        const dir = mkdtempSync(
          path.join(os.tmpdir(), "nemein-connectors-pbt-"),
        );
        const b = openBudget(dir, { runConnector: fakeRunner() });
        try {
          const account = b.createAccount({
            name: "Ficticia",
            type: "corriente",
          });
          const category = b.createCategory({
            name: "Varios",
            group_id: b.createGroup({ name: "G" }),
          });
          const entries = batchFor(account).entries;
          // Some movements are already in the budget, under the same identity.
          for (const i of known) {
            const e = entries[i];
            const id = b.addTransaction({
              account_id: account,
              date: e.date,
              payee: e.payee,
              amount: e.amount,
              category_id: e.amount < 0 ? category : undefined,
            });
            b.db
              .prepare("UPDATE transactions SET import_key=? WHERE id=?")
              .run(e.id, id);
          }
          const { hash } = await b.installConnector({
            component_base64: base64("componente"),
          });
          b.enableConnector({ hash });
          const prepared = await b.prepareConnectorImport({
            hash,
            account_id: account,
            content_base64: base64(statement),
            category_id: category,
          });
          assert.deepEqual(
            prepared.rows.map((r) => r.duplicate),
            entries.map((_e, i) => known.includes(i)),
          );
          const args = { id: prepared.id, batch_sha256: prepared.batch_sha256 };
          const result = b.confirmConnectorImport(args);
          assert.deepEqual(result, {
            added: entries.length - known.length,
            duplicates: known.length,
          });
          assert.deepEqual(b.confirmConnectorImport(args), result);
          const total = b
            .accountTransactions(account)
            .reduce((n, t) => n + t.amount, 0);
          assert.equal(
            total,
            entries.reduce((n, e) => n + e.amount, 0),
          );
          assert.equal(sha256(Buffer.from("componente")), hash);
        } finally {
          b.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    ),
    { seed: 630006, numRuns: 15 },
  );
});
