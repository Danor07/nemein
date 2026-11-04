import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fc from "fast-check";
import {
  checkSignature,
  parseSignature,
  signComponent,
} from "../../src/connector-signature.js";

const hash = "ab".repeat(32);
const file = signComponent(hash, generateKeyPairSync("ed25519").privateKey);

// Anything an author, a broken tool or an attacker can upload as a
// signature: the check reports it and never throws; parsing refuses it with
// its own code.
const upload = fc.oneof(
  fc.jsonValue(),
  fc.string({ maxLength: 200 }),
  fc.record(
    {
      format: fc.oneof(fc.constant(file.format), fc.jsonValue()),
      version: fc.oneof(fc.constant(1), fc.jsonValue()),
      algorithm: fc.oneof(fc.constant("ed25519"), fc.jsonValue()),
      component_sha256: fc.oneof(fc.constant(hash), fc.jsonValue()),
      public_key: fc.oneof(
        fc.constant(file.public_key),
        fc
          .uint8Array({ maxLength: 40 })
          .map((b) => Buffer.from(b).toString("base64")),
        fc.jsonValue(),
      ),
      signature: fc.oneof(
        fc.constant(file.signature),
        fc
          .uint8Array({ maxLength: 70 })
          .map((b) => Buffer.from(b).toString("base64")),
        fc.jsonValue(),
      ),
    },
    { requiredKeys: [] },
  ),
);

test("fuzz: uploaded signatures are reported, never thrown", () => {
  fc.assert(
    fc.property(upload, fc.boolean(), (value, asText) => {
      const input = asText ? (JSON.stringify(value) ?? "") : value;
      const result = checkSignature(hash, input);
      assert.ok(["absent", "valid", "invalid"].includes(result.status));
      if (result.status === "valid")
        assert.deepEqual(parseSignature(input), file);
      try {
        parseSignature(input);
      } catch (e) {
        assert.equal(
          e.code,
          "CONNECTOR_REQUEST_INVALID",
          String(e?.stack ?? e),
        );
        if (input !== undefined && input !== null)
          assert.notEqual(result.status, "valid");
      }
    }),
    { seed: 660001, numRuns: 2000 },
  );
});
