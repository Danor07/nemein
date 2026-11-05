import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fc from "fast-check";
import {
  checkSignature,
  parseSignature,
  signComponent,
} from "../../src/connector-signature.js";

const hex = fc.stringMatching(/^[0-9a-f]{64}$/);
// A few keys, made once: generating one per run would only slow the property.
const keys = Array.from({ length: 4 }, () => generateKeyPairSync("ed25519"));
const fingerprint = (publicKey) =>
  createHash("sha256")
    .update(Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"))
    .digest("hex");

test("PBT: a signature holds for its component and key, and any changed bit breaks it", () => {
  fc.assert(
    fc.property(
      hex,
      fc.nat({ max: keys.length - 1 }),
      fc.constantFrom("component", "public_key", "signature"),
      fc.nat(),
      (hash, k, field, position) => {
        const { privateKey, publicKey } = keys[k];
        const file = signComponent(hash, privateKey);
        assert.deepEqual(checkSignature(hash, file), {
          status: "valid",
          key: fingerprint(publicKey),
        });
        // Its JSON text and its parsed form are the same signature.
        assert.deepEqual(parseSignature(JSON.stringify(file)), file);
        // One bit of the component, the key or the signature.
        const flip = (bytes) => {
          const out = Buffer.from(bytes);
          const bit = position % (out.length * 8);
          out[bit >> 3] ^= 1 << (bit & 7);
          return out;
        };
        const changed =
          field === "component"
            ? { hash: flip(Buffer.from(hash, "hex")).toString("hex"), file }
            : {
                hash,
                file: {
                  ...file,
                  [field]: flip(Buffer.from(file[field], "base64")).toString(
                    "base64",
                  ),
                },
              };
        const result = checkSignature(changed.hash, changed.file);
        assert.equal(result.status, "invalid");
        assert.equal(
          result.reason,
          field === "component" ? "component" : "signature",
        );
      },
    ),
    { seed: 650001, numRuns: 300 },
  );
});

test("PBT: the same component signed by another key is valid under that key only", () => {
  fc.assert(
    fc.property(
      hex,
      fc.nat({ max: keys.length - 1 }),
      fc.nat({ max: keys.length - 2 }),
      (hash, a, offset) => {
        const b = (a + 1 + offset) % keys.length;
        const first = signComponent(hash, keys[a].privateKey);
        const second = signComponent(hash, keys[b].privateKey);
        assert.equal(
          checkSignature(hash, second).key,
          fingerprint(keys[b].publicKey),
        );
        assert.notEqual(
          checkSignature(hash, first).key,
          checkSignature(hash, second).key,
        );
        // Each signature belongs to its own key.
        assert.equal(
          checkSignature(hash, { ...first, public_key: second.public_key })
            .status,
          "invalid",
        );
      },
    ),
    { seed: 650002, numRuns: 100 },
  );
});
