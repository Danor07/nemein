import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { interpret, responseReader } from "../../src/connector-runner.js";
import vectors from "../../src-tauri/connector/worker/fixtures/frames.json" with { type: "json" };

const fixtures = new URL(
  "../../src-tauri/connector/examples/fictitious-bank-csv/fixtures/",
  import.meta.url,
);
const manifest = JSON.parse(
  readFileSync(new URL("manifest.json", fixtures), "utf8"),
);
const batch = readFileSync(
  new URL("extracto.batch.json", fixtures),
  "utf8",
).trimEnd();

function frame(header, blobs) {
  const h = Buffer.from(JSON.stringify(header));
  const len = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  return Buffer.concat([
    Buffer.from("NMC\x01R"),
    len(h.length),
    h,
    Buffer.from([blobs.length]),
    ...blobs.flatMap((b) => [len(b.length), Buffer.from(b)]),
  ]);
}

const seeds = [
  frame({ status: "ok", manifest }, [batch]),
  frame({ status: "ok", manifest }, []),
  frame(
    {
      status: "connector_error",
      manifest,
      error: { code: "CONNECTOR_FORMAT", message: "Línea 2" },
    },
    [],
  ),
  frame({ status: "host_error", code: "TIMEOUT", message: "t" }, []),
  ...vectors.response.map((v) => Buffer.from(v.frame, "hex")),
];

// Every outcome is a coded failure or a result that passed every check.
function outcome(bytes, chunk) {
  try {
    const reader = responseReader();
    let got = null;
    for (let i = 0; i < bytes.length; i += chunk)
      got = reader.push(bytes.subarray(i, i + chunk));
    if (!got) return "incomplete";
    const result = interpret(got, {
      op: "parse",
      accountId: "1",
      expectedManifest: manifest,
    });
    assert.deepEqual(result.manifest, manifest);
    assert.equal(result.batch.account_id, 1);
    assert.equal(result.batch.provenance.connector, manifest.id);
    return "ok";
  } catch (error) {
    assert.match(
      error.code ?? "",
      /^(CONNECTOR_[A-Z_]+|IMPORT_[A-Z_]+)$/,
      String(error.stack),
    );
    return error.code;
  }
}

test("fuzz: arbitrary bytes in arbitrary chunks never escape as uncoded errors", () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ maxLength: 600 }),
      fc.integer({ min: 1, max: 64 }),
      (bytes, chunk) => {
        outcome(
          Buffer.concat([Buffer.from("NMC\x01R"), Buffer.from(bytes)]),
          chunk,
        );
        outcome(Buffer.from(bytes), chunk);
      },
    ),
    { seed: 620001, numRuns: 2000 },
  );
});

test("fuzz: mutated real responses fail closed or still pass every check", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: seeds.length - 1 }),
      fc.array(
        fc.tuple(
          fc.nat(),
          fc.integer({ min: 0, max: 255 }),
          fc.constantFrom("set", "insert", "delete"),
        ),
        { minLength: 1, maxLength: 6 },
      ),
      fc.integer({ min: 1, max: 97 }),
      (which, edits, chunk) => {
        const bytes = [...seeds[which]];
        for (const [position, value, kind] of edits) {
          const at = position % (bytes.length + 1);
          if (kind === "insert") bytes.splice(at, 0, value);
          else if (at < bytes.length)
            kind === "set" ? (bytes[at] = value) : bytes.splice(at, 1);
        }
        outcome(Buffer.from(bytes), chunk);
      },
    ),
    { seed: 620002, numRuns: 3000 },
  );
});
