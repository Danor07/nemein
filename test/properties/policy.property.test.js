import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { evaluatePolicy } from "../../src/policy.js";
import { actions } from "../../src/actions.js";
const options = { seed: 424242, numRuns: 400 };
const actor = { id: "client", version: "1", active: true };
const rule = (decision = "allow", conditions = {}) => ({
  connection_id: "client",
  connection_version: "1",
  action_version: 1,
  decision,
  conditions,
});
function result(input, expected) {
  const r = evaluatePolicy(input);
  assert.equal(r.decision, expected);
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason.length > 0);
}
test("PBT: amount/account boundaries and fallback preserve policy", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 1000000 }),
      fc.integer({ min: -1000000, max: 1000000 }),
      fc.integer({ min: 1, max: 10 }),
      fc.integer({ min: 1, max: 10 }),
      fc.constantFrom("allow", "ask"),
      fc.constantFrom("deny", "ask"),
      (limit, amount, account, requested, decision, otherwise) => {
        const permitted =
          (BigInt(amount) < 0n ? -BigInt(amount) : BigInt(amount)) <=
            BigInt(limit) && account === requested;
        for (const value of [amount, String(amount)])
          result(
            {
              actor,
              rule: rule(decision, {
                max_amount: limit,
                account_id: account,
                otherwise,
              }),
              action: "transaction",
              args: { amount: value, account_id: requested },
            },
            permitted ? decision : otherwise,
          );
        for (const value of [limit, -limit])
          result(
            {
              actor,
              rule: rule(decision, { max_amount: limit }),
              action: "transaction",
              args: { amount: value },
            },
            decision,
          );
      },
    ),
    options,
  );
});
test("PBT: absent, revoked or mismatched grants never authorize any action", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...Object.keys(actions)),
      fc.jsonValue(),
      (action, args) => {
        for (const input of [
          { actor: null, rule: rule() },
          { actor: { ...actor, active: false }, rule: rule() },
          { actor: { ...actor, version: "2" }, rule: rule() },
          { actor: { ...actor, id: "other" }, rule: rule() },
          { actor, rule: null },
          { actor, rule: { ...rule(), action_version: 2 } },
          { actor, rule: rule("invalid") },
        ])
          result({ ...input, action, args }, "deny");
        result({ actor, rule: rule(), action: "unknown", args }, "deny");
        result(
          {
            actor,
            rule: rule("deny", { max_amount: 0, otherwise: "ask" }),
            action,
            args,
          },
          "deny",
        );
      },
    ),
    options,
  );
});
test("PBT: unconstrained decisions, defaults and invalid money stay explicit", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(true, 1),
      fc.constantFrom("allow", "ask", "deny"),
      fc.integer({ min: 0, max: 10000 }),
      (active, decision, limit) => {
        result(
          {
            actor: { ...actor, active },
            rule: rule(decision),
            action: "snapshot",
            args: {},
          },
          decision,
        );
        result(
          {
            actor,
            rule: rule(decision, { max_amount: limit }),
            action: "account",
            args: {},
          },
          decision,
        );
        if (decision !== "deny") {
          result(
            {
              actor,
              rule: rule(decision, { max_amount: limit }),
              action: "transaction",
              args: { amount: limit + 1 },
            },
            "deny",
          );
          for (const amount of [
            "",
            null,
            "1.5",
            "1e3",
            Number.MAX_SAFE_INTEGER + 1,
          ])
            result(
              {
                actor,
                rule: rule(decision, { max_amount: limit, otherwise: "ask" }),
                action: "transaction",
                args: { amount },
              },
              "ask",
            );
        }
      },
    ),
    options,
  );
});

test("PBT: invalid fallbacks cannot authorize an out-of-bounds request", () => {
  fc.assert(
    fc.property(
      fc
        .oneof(fc.constant("allow"), fc.jsonValue())
        .filter((v) => v !== "ask" && v !== "deny"),
      fc.integer({ min: 0, max: 1000000 }),
      (otherwise, limit) =>
        result(
          {
            actor,
            rule: rule("allow", { max_amount: limit, otherwise }),
            action: "transaction",
            args: { amount: limit + 1 },
          },
          "deny",
        ),
    ),
    options,
  );
  for (const otherwise of ["allow", "unknown", true, 1, null, {}, []])
    result(
      {
        actor,
        rule: rule("ask", { account_id: 1, otherwise }),
        action: "transaction",
        args: { account_id: 2, amount: 1 },
      },
      "deny",
    );
});
