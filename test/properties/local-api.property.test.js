import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { apiFixture } from "../helpers/local-api.js";
import { actions } from "../../src/actions.js";
import {
  executeApiBatch,
  validateBatch,
} from "../../src/local-api-contract.js";

test("HTTP conditional writes conserve the ledger and never apply a stale base", async (t) => {
  const { budget, rule, send } = await apiFixture(t);
  const account_id = budget.createAccount({
    name: "Property fixture",
    type: "efectivo",
  });
  rule("transaction");
  let count = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 100000 }), {
        minLength: 1,
        maxLength: 6,
      }),
      async (amounts) => {
        let total = budget
          .accountTransactions(account_id)
          .reduce((sum, row) => sum + row.amount, 0);
        for (const amount of amounts) {
          const base = budget.eventSnapshot().cursor;
          const request_id = "property-" + count++;
          const call = {
            arguments: {
              account_id,
              amount,
              date: "2026-10-20",
              payee: request_id,
            },
            base,
            request_id,
          };
          const written = await send("transaction", call);
          assert.equal(written.status, 200);
          total += amount;
          assert.deepEqual(
            (await send("transaction", call)).body,
            written.body,
          );
          const cursor = budget.eventSnapshot().cursor;
          const stale = await send("transaction", {
            ...call,
            request_id: request_id + "-stale",
          });
          assert.equal(stale.body.error.code, "STATE_CONFLICT");
          assert.equal(budget.eventSnapshot().cursor, cursor);
          assert.equal(
            budget
              .accountTransactions(account_id)
              .reduce((sum, row) => sum + row.amount, 0),
            total,
          );
        }
      },
    ),
    { seed: 902901, numRuns: 30 },
  );
});

test("Every catalog write requires the state condition before touching the domain", async (t) => {
  const { budget, connection, rule } = await apiFixture(t);
  const agent = budget.forAgent(connection.token);
  const initial = budget.eventSnapshot().cursor;
  for (const [action, spec] of Object.entries(actions)) {
    if (!spec.write) continue;
    rule(action);
    assert.throws(
      () => agent.request(action, {}, { requireBase: true }),
      (error) => error.code === "BASE_REQUIRED",
      action,
    );
    assert.equal(budget.eventSnapshot().cursor, initial, action);
  }
});

test("Generated batches retain correlation and execute sequentially despite rejected calls", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 16 }),
      async (failures) => {
        const started = [],
          finished = [];
        const agent = {
          request: async (_action, args) => {
            started.push(args.name);
            await Promise.resolve();
            assert.deepEqual(started.slice(0, -1), finished);
            finished.push(args.name);
            if (failures[Number(args.name)])
              throw Object.assign(Error("Rejected fixture"), {
                code: "PERMISSION_DENIED",
              });
            return args.name;
          },
        };
        const calls = failures.map((_, i) => ({
          id: "id-" + i,
          action: "group",
          arguments: { name: String(i) },
        }));
        assert.doesNotThrow(() =>
          validateBatch(JSON.parse(JSON.stringify({ calls }))),
        );
        const { results } = await executeApiBatch(agent, { calls });
        assert.deepEqual(
          started,
          failures.map((_, i) => String(i)),
        );
        assert.deepEqual(
          results.map((r) => r.id),
          calls.map((c) => c.id),
        );
        assert.deepEqual(
          results.map((r) => r.ok),
          failures.map((f) => !f),
        );
      },
    ),
    { seed: 902902, numRuns: 100 },
  );
});
