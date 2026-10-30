import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { apiFixture } from "../helpers/local-api.js";
import { checkApiHeaders } from "../../src/local-api-contract.js";

test("Adversarial Host/Origin/token strings cannot cross the HTTP trust boundary", async (t) => {
  const { send, port, budget } = await apiFixture(t);
  const before = budget.eventSnapshot().cursor;
  await fc.assert(
    fc.asyncProperty(
      fc
        .string({ minLength: 1, maxLength: 100 })
        .filter((s) => /^[\x20-\x7e]+$/.test(s)),
      async (hostile) => {
        for (const [name, prefix, expected] of [
          ["Host", "evil-", "INVALID_HOST"],
          ["Origin", "https://evil.example/", "INVALID_ORIGIN"],
          ["Authorization", "Bearer invalid-", "AUTH_REQUIRED"],
        ]) {
          const response = await send(
            "permissions",
            { arguments: {} },
            { headers: { [name]: prefix + hostile } },
          );
          assert.equal(response.body.error.code, expected);
          assert.ok(!response.headers["access-control-allow-origin"]);
        }
      },
    ),
    { seed: 902903, numRuns: 80 },
  );
  // Includes control characters and Unicode which Node itself refuses on the wire.
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (hostile) => {
      const req = {
        headers: { host: "127.0.0.1:" + port, origin: hostile },
        rawHeaders: ["Host", "127.0.0.1:" + port, "Origin", hostile],
        socket: { localPort: port },
        url: "/permissions",
      };
      assert.throws(() => checkApiHeaders(req));
    }),
    { seed: 902904, numRuns: 200 },
  );
  assert.equal(budget.eventSnapshot().cursor, before);
});

test("Arbitrary JSON, malformed text and abusive batches leave no financial changes or proposals", async (t) => {
  const { send, budget } = await apiFixture(t);
  const before = budget.eventSnapshot().cursor;
  await fc.assert(
    fc.asyncProperty(fc.jsonValue(), async (value) => {
      const single = await send("transaction", value);
      assert.ok([400, 403].includes(single.status));
      const batch = await send("calls", { calls: [value] });
      assert.equal(batch.status, 400);
      const malformed = await send(
        "calls",
        {},
        { raw: JSON.stringify(value) + "!" },
      );
      assert.equal(malformed.status, 400);
      assert.equal(malformed.body.error.code, "INVALID_JSON");
    }),
    { seed: 902905, numRuns: 100 },
  );
  for (const count of [0, 17, 1000]) {
    const response = await send("calls", {
      calls: Array.from({ length: count }, (_, i) => ({
        id: String(i),
        action: "transaction",
        arguments: {},
      })),
    });
    assert.equal(response.status, 400);
  }
  const deep = await send(
    "calls",
    {},
    { raw: '{"calls":' + "[".repeat(10000) + "0" + "]".repeat(10000) + "}" },
  );
  assert.equal(deep.status, 400);
  assert.equal(budget.eventSnapshot().cursor, before);
  assert.equal(budget.accessState().proposalTotal, 0);
});
