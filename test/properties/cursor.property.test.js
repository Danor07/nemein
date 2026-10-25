import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { decodeCursor } from "../../src/event-reads.js";
const encode = (p) =>
  Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
const invalid = (token) =>
  assert.throws(
    () => decodeCursor(token),
    (e) =>
      e.code === "INVALID_CURSOR" &&
      typeof e.message === "string" &&
      e.message.length > 0,
  );
test("PBT: cursor validity covers every field, exact keys and canonical encoding", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 40 }),
      fc.integer({ min: 0, max: 1000000000 }),
      fc.string({ minLength: 1, maxLength: 40 }),
      (source, sequence, id) => {
        const valid = {
          version: 1,
          source,
          sequence,
          id: sequence === 0 ? null : id,
        };
        assert.deepEqual(decodeCursor(encode(valid)), valid);
        assert.deepEqual(
          decodeCursor(encode({ id: valid.id, sequence, source, version: 1 })),
          valid,
        );
        for (const patch of [
          { version: 0 },
          { version: 2 },
          { version: "1" },
          { source: null },
          { source: 1 },
          { source: [] },
          { source: {} },
          { sequence: -1 },
          { sequence: 0.5 },
          { sequence: "1" },
          { sequence: null },
          { sequence: 9007199254740992 },
          { id: sequence === 0 ? "not-null" : null },
          { id: sequence === 0 ? 0 : "" },
          { id: sequence === 0 ? false : 1 },
          { extra: "not-a-cursor-field" },
        ])
          invalid(encode({ ...valid, ...patch }));
        for (const key of ["version", "source", "sequence", "id"]) {
          const missing = { ...valid };
          delete missing[key];
          invalid(encode(missing));
        }
        for (const prefix of ["!", " ", "=", "\r\n"]) {
          invalid(prefix + encode(valid));
          invalid(encode(valid) + prefix);
        }
      },
    ),
    { seed: 737373, numRuns: 100 },
  );
  for (const value of [null, true, 1, [], {}, []]) invalid(encode(value));
  const position = { version: 1, source: "", sequence: 1, id: "event" };
  const length = Buffer.byteLength(JSON.stringify(position));
  const boundary = { ...position, source: "x".repeat(768 - length) };
  const token = encode(boundary);
  assert.equal(token.length, 1024);
  assert.deepEqual(decodeCursor(token), boundary);
  invalid(encode({ ...boundary, source: boundary.source + "x" }));
  const padded = { ...position };
  while (Buffer.byteLength(JSON.stringify(padded)) % 3 !== 1)
    padded.source += "x";
  const canonical = encode(padded),
    alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const noncanonical =
    canonical.slice(0, -1) + alphabet[alphabet.indexOf(canonical.at(-1)) + 1];
  assert.deepEqual(
    Buffer.from(noncanonical, "base64url"),
    Buffer.from(canonical, "base64url"),
  );
  invalid(noncanonical);
});
