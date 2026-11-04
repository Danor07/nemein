import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  LIMITS,
  encodeRequest,
  responseReader,
  validateManifest,
} from "../../src/connector-runner.js";

// A reference decoder written apart from the module under test.
function decodeRequest(bytes) {
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "NMC\x01Q");
  let at = 5;
  const take = () => {
    const n = bytes.readUInt32LE(at);
    const out = bytes.subarray(at + 4, at + 4 + n);
    at += 4 + n;
    return out;
  };
  const header = JSON.parse(take().toString("utf8"));
  const count = bytes[at];
  at += 1;
  const blobs = Array.from({ length: count }, take);
  assert.equal(at, bytes.length, "no trailing bytes");
  return { header, blobs };
}

function responseBytes(header, blob) {
  const h = Buffer.from(header);
  const parts = [
    Buffer.from("NMC\x01R"),
    Buffer.alloc(4),
    h,
    Buffer.from([blob ? 1 : 0]),
  ];
  parts[1].writeUInt32LE(h.length);
  if (blob) {
    const n = Buffer.alloc(4);
    n.writeUInt32LE(blob.length);
    parts.push(n, blob);
  }
  return Buffer.concat(parts);
}

function chunked(bytes, cuts) {
  const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort(
    (a, b) => a - b,
  );
  const chunks = [];
  let last = 0;
  for (const p of [...points, bytes.length]) {
    if (p > last) chunks.push(bytes.subarray(last, p));
    last = Math.max(last, p);
  }
  return chunks;
}

test("PBT: request frames round-trip through an independent decoder", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("describe", "parse"),
      fc.string({ maxLength: 64, unit: "grapheme" }),
      fc.bigInt({ min: 1n, max: 9007199254740991n }),
      fc.uint8Array({ maxLength: 256 }),
      fc.uint8Array({ maxLength: 256 }),
      (op, config, account, component, input) => {
        const accountId = account.toString();
        const bytes = encodeRequest({
          op,
          config,
          accountId,
          component: Buffer.from(component),
          input: Buffer.from(input),
        });
        const decoded = decodeRequest(bytes);
        assert.deepEqual(decoded.header, { op, config, account_id: accountId });
        assert.deepEqual(Object.keys(decoded.header), [
          "op",
          "config",
          "account_id",
        ]);
        assert.deepEqual(
          decoded.blobs.map((b) => [...b]),
          [[...component], [...input]],
        );
      },
    ),
    { seed: 610001, numRuns: 300 },
  );
});

test("PBT: any chunking of a valid response yields the same single frame", () => {
  fc.assert(
    fc.property(
      fc.json({ maxDepth: 2 }),
      fc.option(fc.uint8Array({ maxLength: 512 }), { nil: undefined }),
      fc.array(fc.nat(), { maxLength: 12 }),
      (header, blob, cuts) => {
        const bytes = responseBytes(header, blob && Buffer.from(blob));
        const reader = responseReader();
        let frame = null;
        const chunks = chunked(bytes, cuts);
        chunks.forEach((chunk, index) => {
          frame = reader.push(chunk);
          assert.equal(frame === null, index < chunks.length - 1);
        });
        assert.equal(frame.header.toString(), header);
        assert.deepEqual(
          frame.blobs.map((b) => [...b]),
          blob ? [[...blob]] : [],
        );
      },
    ),
    { seed: 610002, numRuns: 300 },
  );
});

test("PBT: declared lengths decide alone; one over the limit is refused", () => {
  const around = (limit) =>
    fc.oneof(
      fc.constantFrom(0, 1, limit - 1, limit, limit + 1, 0xffffffff),
      fc.integer({ min: 0, max: 0xffffffff }),
    );
  fc.assert(
    fc.property(
      around(LIMITS.header),
      around(LIMITS.output),
      (headerLength, blobLength) => {
        const head = Buffer.alloc(9);
        head.write("NMC\x01R", "latin1");
        head.writeUInt32LE(headerLength, 5);
        const reader = responseReader();
        if (headerLength > LIMITS.header) {
          assert.throws(() => reader.push(head), {
            code: "CONNECTOR_PROTOCOL",
          });
          return;
        }
        assert.equal(reader.push(head), null);
        const rest = Buffer.alloc(headerLength + 5);
        rest[headerLength] = 1;
        rest.writeUInt32LE(blobLength, headerLength + 1);
        if (blobLength > LIMITS.output) {
          assert.throws(() => reader.push(rest), {
            code: "CONNECTOR_PROTOCOL",
          });
          return;
        }
        const got = reader.push(rest);
        if (blobLength === 0) {
          assert.equal(got.header.length, headerLength);
          assert.deepEqual(
            got.blobs.map((b) => b.length),
            [0],
          );
        } else assert.equal(got, null, "waits for the declared bytes");
      },
    ),
    { seed: 610003, numRuns: 400 },
  );
});

// Independent statement of the WIT manifest rules.
function oracle(m) {
  const words = (id) =>
    id
      .split(/[.-]/)
      .every(
        (w) =>
          w.length > 0 &&
          [...w].every((c) =>
            "abcdefghijklmnopqrstuvwxyz0123456789".includes(c),
          ),
      );
  const text = (s, min, max) =>
    typeof s === "string" &&
    [...s].length >= min &&
    [...s].length <= max &&
    (min === 0 || s.trim().length > 0);
  return (
    typeof m.id === "string" &&
    m.id.length <= 160 &&
    words(m.id) &&
    text(m.version, 1, 80) &&
    text(m.name, 1, 80) &&
    text(m.description, 0, 500) &&
    Array.isArray(m.extensions) &&
    m.extensions.length <= 8 &&
    m.extensions.every((e) => /^[a-z0-9]{1,16}$/.test(e))
  );
}

test("PBT: manifests are accepted exactly when the WIT rules hold", () => {
  const piece = fc.stringMatching(/^[a-z0-9]{1,6}$/);
  const id = fc.oneof(
    fc.array(piece, { minLength: 1, maxLength: 4 }).chain((parts) =>
      fc
        .array(fc.constantFrom(".", "-"), {
          minLength: parts.length - 1,
          maxLength: parts.length - 1,
        })
        .map((seps) =>
          parts.reduce((s, p, i) => (i ? s + seps[i - 1] + p : p), ""),
        ),
    ),
    fc.string({ maxLength: 12 }),
    fc.constant("a".repeat(161)),
  );
  const text = (max) =>
    fc.oneof(
      fc.string({ maxLength: max + 2 }),
      fc.constant(" "),
      fc.constant(""),
      fc.constant("x".repeat(max + 1)),
    );
  const extension = fc.oneof(
    fc.stringMatching(/^[a-z0-9]{1,16}$/),
    fc.string({ maxLength: 18 }),
  );
  fc.assert(
    fc.property(
      fc.record({
        id,
        version: text(80),
        name: text(80),
        description: text(500),
        extensions: fc.array(extension, { maxLength: 9 }),
      }),
      (m) => {
        let accepted = true;
        try {
          validateManifest(m);
        } catch (error) {
          assert.equal(error.code, "CONNECTOR_MANIFEST_INVALID");
          accepted = false;
        }
        assert.equal(accepted, oracle(m), JSON.stringify(m));
      },
    ),
    { seed: 610004, numRuns: 1000 },
  );
});
