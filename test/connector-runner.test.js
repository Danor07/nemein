import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  LIMITS,
  encodeRequest,
  interpret,
  responseReader,
  runConnector,
  validateManifest,
} from "../src/connector-runner.js";
import vectors from "../src-tauri/connector/worker/fixtures/frames.json" with { type: "json" };

const example = (name) =>
  readFileSync(
    new URL(
      "../src-tauri/connector/examples/fictitious-bank-csv/fixtures/" + name,
      import.meta.url,
    ),
    "utf8",
  );
const manifest = JSON.parse(example("manifest.json"));
const batchText = example("extracto.batch.json").trimEnd();
const fake = fileURLToPath(
  new URL("./helpers/fake-connector.js", import.meta.url),
);

const okFrame = (header, blobs = []) => ({
  header: Buffer.from(JSON.stringify(header)),
  blobs: blobs.map((b) => Buffer.from(b)),
});
const code = (expected) => (error) => {
  assert.equal(error.code, expected, error.message);
  assert.ok(error.message.length > 0);
  return true;
};

test("frames: requests and responses match the vectors the Rust worker uses", () => {
  for (const v of vectors.request) {
    const encoded = encodeRequest({
      op: v.header.op,
      config: v.header.config,
      accountId: v.header.account_id,
      component: Buffer.from(v.blobs[0], "hex"),
      input: Buffer.from(v.blobs[1], "hex"),
    });
    assert.equal(encoded.toString("hex"), v.frame, v.name);
  }
  for (const v of vectors.response) {
    const bytes = Buffer.from(v.frame, "hex");
    for (const chunk of [bytes.length, 1, 3]) {
      const reader = responseReader();
      let frame = null;
      for (let i = 0; i < bytes.length; i += chunk) {
        assert.equal(frame, null, "no frame before the last byte");
        frame = reader.push(bytes.subarray(i, i + chunk));
      }
      assert.deepEqual(JSON.parse(frame.header), v.header, v.name);
      assert.deepEqual(
        frame.blobs.map((b) => b.toString("hex")),
        v.blobs,
        v.name,
      );
    }
  }
  for (const v of vectors.invalid_response) {
    const bytes = Buffer.from(v.frame, "hex");
    assert.throws(
      () => {
        const reader = responseReader();
        for (const byte of bytes) reader.push(Buffer.from([byte]));
      },
      code("CONNECTOR_PROTOCOL"),
      v.name,
    );
  }
});

test("frames: a declared length over the limit is refused before its bytes arrive", () => {
  const reader = responseReader();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(LIMITS.header + 1);
  assert.throws(
    () => reader.push(Buffer.concat([Buffer.from("NMC\x01R"), header])),
    code("CONNECTOR_PROTOCOL"),
  );
  const exact = responseReader();
  header.writeUInt32LE(LIMITS.header);
  assert.equal(
    exact.push(Buffer.concat([Buffer.from("NMC\x01R"), header])),
    null,
  );
  const blob = Buffer.alloc(4);
  blob.writeUInt32LE(LIMITS.output);
  const atLimit = responseReader();
  assert.equal(
    atLimit.push(
      Buffer.concat([Buffer.from("NMC\x01R\x02\x00\x00\x00{}\x01"), blob]),
    ),
    null,
  );
  assert.throws(
    () => responseReader().push(Buffer.from("NMC\x01R\x02\x00\x00\x00{}\x02")),
    code("CONNECTOR_PROTOCOL"),
  );
});

test("frames: each check fires at the first byte that decides it", () => {
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  // Five bytes decide magic, version and kind.
  for (const head of ["NMC\x02R", "NMC\x01Q", "NMD\x01R"])
    assert.throws(
      () => responseReader().push(Buffer.from(head)),
      code("CONNECTOR_PROTOCOL"),
      head,
    );
  // Fourteen plus the header decide the blob length.
  assert.throws(
    () =>
      responseReader().push(
        Buffer.concat([
          Buffer.from("NMC\x01R\x02\x00\x00\x00{}\x01"),
          u32(LIMITS.output + 1),
        ]),
      ),
    code("CONNECTOR_PROTOCOL"),
  );
  // Nothing is accepted after a whole frame, not even an empty chunk.
  const reader = responseReader();
  assert.ok(reader.push(Buffer.from("NMC\x01R\x02\x00\x00\x00{}\x00")));
  assert.throws(() => reader.push(Buffer.alloc(0)), code("CONNECTOR_PROTOCOL"));
});

test("interpret: describe and parse results, checked outside the enclosure", () => {
  const described = interpret(okFrame({ status: "ok", manifest }), {
    op: "describe",
    accountId: "1",
  });
  assert.deepEqual(described, { manifest });
  const parsed = interpret(okFrame({ status: "ok", manifest }, [batchText]), {
    op: "parse",
    accountId: "1",
    expectedManifest: structuredClone(manifest),
  });
  assert.deepEqual(parsed.manifest, manifest);
  assert.equal(parsed.batch.entries.length, 5);
  assert.equal(parsed.batch.account_id, 1);
});

test("interpret: connector and host errors keep their codes apart", () => {
  assert.throws(
    () =>
      interpret(
        okFrame({
          status: "connector_error",
          manifest,
          error: { code: "CONNECTOR_TIMEOUT", message: "Línea 3: inválida" },
        }),
        { op: "parse", accountId: "1" },
      ),
    (error) => {
      // A connector cannot pass its own code off as a host failure.
      assert.equal(error.code, "CONNECTOR_REJECTED");
      assert.equal(error.connectorCode, "CONNECTOR_TIMEOUT");
      assert.equal(error.message, "Línea 3: inválida");
      return true;
    },
  );
  for (const host of [
    "REQUEST_INVALID",
    "COMPONENT_INVALID",
    "COMPONENT_HAS_IMPORTS",
    "COMPONENT_WRONG_WORLD",
    "MANIFEST_TOO_LARGE",
    "ERROR_TOO_LARGE",
    "OUTPUT_TOO_LARGE",
    "TIMEOUT",
    "MEMORY_LIMIT",
    "WORKER_CRASHED",
    "WORKER_PROTOCOL",
    "SANDBOX_UNAVAILABLE",
    "UNSUPPORTED_PLATFORM",
  ])
    assert.throws(
      () =>
        interpret(okFrame({ status: "host_error", code: host, message: "m" }), {
          op: "parse",
          accountId: "1",
        }),
      code("CONNECTOR_" + host),
    );
  assert.throws(
    () =>
      interpret(
        okFrame({ status: "host_error", code: "CONNECTOR_TRAP", message: "m" }),
        {
          op: "parse",
          accountId: "1",
        },
      ),
    code("CONNECTOR_TRAP"),
  );
  for (const header of [
    { status: "host_error", code: "UNKNOWN", message: "m" },
    { status: "host_error", code: "TIMEOUT" },
    { status: "host_error", code: "TIMEOUT", message: 1 },
    { status: "host_error", code: "TIMEOUT", message: "m", extra: 1 },
    { status: "maybe", manifest },
    { status: "ok" },
    { status: "ok", manifest, extra: 1 },
    { status: "connector_error", manifest },
    {
      status: "connector_error",
      manifest,
      error: { code: "lower", message: "m" },
    },
    { status: "connector_error", manifest, error: { code: "X", message: "" } },
    {
      status: "connector_error",
      manifest,
      error: { code: "X", message: "m".repeat(1025) },
    },
    {
      status: "connector_error",
      manifest,
      error: { code: "X".repeat(65), message: "m" },
    },
    {
      status: "connector_error",
      manifest,
      error: { code: "X", message: "m", detail: 1 },
    },
    null,
    [],
  ])
    assert.throws(
      () => interpret(okFrame(header), { op: "parse", accountId: "1" }),
      code("CONNECTOR_PROTOCOL"),
      JSON.stringify(header),
    );
  assert.throws(
    () =>
      interpret(
        okFrame({ status: "host_error", code: "TIMEOUT", message: "m" }, ["x"]),
        { op: "parse", accountId: "1" },
      ),
    code("CONNECTOR_PROTOCOL"),
  );
  assert.throws(
    () =>
      interpret(
        { header: Buffer.from([0xff]), blobs: [] },
        { op: "parse", accountId: "1" },
      ),
    code("CONNECTOR_PROTOCOL"),
  );
  assert.throws(
    () =>
      interpret(
        { header: Buffer.from("{"), blobs: [] },
        { op: "parse", accountId: "1" },
      ),
    code("CONNECTOR_PROTOCOL"),
  );
});

test("interpret: fields of the wrong type are refused even when they look right", () => {
  const parse = { op: "parse", accountId: "1" };
  for (const m of [
    null,
    42,
    { ...manifest, id: [manifest.id] },
    { ...manifest, version: [manifest.version] },
    { ...manifest, name: [manifest.name] },
    { ...manifest, description: [manifest.description] },
    { ...manifest, extensions: [["csv"]] },
  ])
    assert.throws(
      () =>
        interpret(okFrame({ status: "ok", manifest: m }, [batchText]), parse),
      code("CONNECTOR_MANIFEST_INVALID"),
      JSON.stringify(m),
    );
  const rejected = (error) =>
    interpret(okFrame({ status: "connector_error", manifest, error }), parse);
  for (const error of [
    null,
    { code: ["X"], message: "m" },
    { code: "X", message: ["m"] },
  ])
    assert.throws(
      () => rejected(error),
      code("CONNECTOR_PROTOCOL"),
      JSON.stringify(error),
    );
  for (const error of [
    { code: "X", message: "m" },
    { code: "X".repeat(64), message: "ñ".repeat(1024) },
  ])
    assert.throws(
      () => rejected(error),
      (thrown) => {
        assert.equal(thrown.connectorCode, error.code);
        assert.equal(thrown.message, error.message);
        return code("CONNECTOR_REJECTED")(thrown);
      },
    );
  // A connector error never carries a batch.
  assert.throws(
    () =>
      interpret(
        okFrame(
          {
            status: "connector_error",
            manifest,
            error: { code: "X", message: "m" },
          },
          [batchText],
        ),
        parse,
      ),
    code("CONNECTOR_PROTOCOL"),
  );
});

test("interpret: invalid UTF-8 inside JSON strings is refused, not replaced", () => {
  const parse = { op: "parse", accountId: "1" };
  // `text` with its first `marker` replaced by the lone byte 0xff.
  const withByte = (text, marker) => {
    const at = text.indexOf(marker);
    assert.ok(at >= 0, marker);
    return Buffer.concat([
      Buffer.from(text.slice(0, at)),
      Buffer.from([0xff]),
      Buffer.from(text.slice(at + marker.length)),
    ]);
  };
  assert.throws(
    () =>
      interpret(
        {
          header: withByte(
            JSON.stringify({
              status: "host_error",
              code: "TIMEOUT",
              message: "@",
            }),
            "@",
          ),
          blobs: [],
        },
        parse,
      ),
    code("CONNECTOR_PROTOCOL"),
  );
  assert.throws(
    () =>
      interpret(
        {
          header: Buffer.from(JSON.stringify({ status: "ok", manifest })),
          blobs: [withByte(batchText, "Sueldo")],
        },
        parse,
      ),
    (error) => {
      assert.ok(error.cause instanceof TypeError, String(error.cause));
      return code("IMPORT_INVALID_BATCH")(error);
    },
  );
});

test("interpret: lying manifests, foreign accounts and foreign provenance are refused", () => {
  const run = (m, blobs = [batchText], extra = {}) =>
    interpret(okFrame({ status: "ok", manifest: m }, blobs), {
      op: "parse",
      accountId: "1",
      ...extra,
    });
  const variants = [
    { ...manifest, id: "Mayúsculas" },
    { ...manifest, id: "a..b" },
    { ...manifest, id: "-a" },
    { ...manifest, id: "a".repeat(161) },
    { ...manifest, version: "" },
    { ...manifest, version: "   " },
    { ...manifest, version: "v".repeat(81) },
    { ...manifest, name: "" },
    { ...manifest, name: "n".repeat(81) },
    { ...manifest, description: "d".repeat(501) },
    { ...manifest, extensions: "csv" },
    { ...manifest, extensions: ["CSV"] },
    { ...manifest, extensions: [".csv"] },
    { ...manifest, extensions: ["a".repeat(17)] },
    { ...manifest, extensions: Array(9).fill("csv") },
    { ...manifest, extra: 1 },
    { id: manifest.id },
  ];
  for (const m of variants)
    assert.throws(
      () => run(m),
      code("CONNECTOR_MANIFEST_INVALID"),
      JSON.stringify(m),
    );
  for (const m of [
    {
      ...manifest,
      id: "a".repeat(160),
      version: "v".repeat(80),
      name: "n".repeat(80),
      description: "d".repeat(500),
      extensions: Array(8).fill("a".repeat(16)),
    },
    { ...manifest, description: "", extensions: [] },
  ])
    assert.deepEqual(validateManifest(m), m);
  assert.throws(
    () =>
      run(manifest, [batchText], {
        expectedManifest: { ...manifest, version: "1.0.1" },
      }),
    code("CONNECTOR_MANIFEST_MISMATCH"),
  );
  assert.throws(
    () => run({ ...manifest, version: "2.0.0" }),
    code("CONNECTOR_PROVENANCE_MISMATCH"),
  );
  assert.throws(
    () => run({ ...manifest, id: "otro.conector" }),
    code("CONNECTOR_PROVENANCE_MISMATCH"),
  );
  assert.throws(
    () =>
      interpret(okFrame({ status: "ok", manifest }, [batchText]), {
        op: "parse",
        accountId: "2",
      }),
    code("CONNECTOR_ACCOUNT_MISMATCH"),
  );
});

test("interpret: invalid batches fail with the import contract's codes", () => {
  const run = (blobs, op = "parse") =>
    interpret(okFrame({ status: "ok", manifest }, blobs), {
      op,
      accountId: "1",
    });
  assert.throws(() => run(["esto no es JSON"]), code("IMPORT_INVALID_BATCH"));
  assert.throws(
    () =>
      interpret(
        {
          header: Buffer.from(JSON.stringify({ status: "ok", manifest })),
          blobs: [Buffer.from([0x7b, 0xff])],
        },
        { op: "parse", accountId: "1" },
      ),
    code("IMPORT_INVALID_BATCH"),
  );
  const batch = JSON.parse(batchText);
  assert.throws(
    () => run([JSON.stringify({ ...batch, currency: "USD" })]),
    code("IMPORT_INVALID_BATCH"),
  );
  const duplicated = {
    ...batch,
    entries: [batch.entries[0], batch.entries[0]],
  };
  assert.throws(
    () => run([JSON.stringify(duplicated)]),
    code("IMPORT_DUPLICATE_ID"),
  );
  assert.throws(() => run([]), code("CONNECTOR_PROTOCOL"));
  assert.throws(() => run([batchText, batchText]), code("CONNECTOR_PROTOCOL"));
  assert.throws(() => run([batchText], "describe"), code("CONNECTOR_PROTOCOL"));
});

function responseFile(t, header, blobs = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-fake-connector-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "response.json");
  writeFileSync(file, JSON.stringify({ header, blobs }));
  return file;
}

const request = {
  op: "parse",
  component: Buffer.from("componente ficticio"),
  input: Buffer.from(example("extracto.csv")),
  accountId: "1",
  command: "/nunca/se/ejecuta",
  platform: "win32",
};
// Short backstop: no fake answers later than this unless a test says so.
const withFake = (mode, file, extra = {}) =>
  runConnector({
    ...request,
    command: [process.execPath, fake, mode, file],
    timeoutMs: 4000,
    ...extra,
  });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// Whether the fake that answered from `file` is gone within `ms`.
async function fakeGone(file, ms = 2000) {
  const pid = Number(readFileSync(file + ".pid", "utf8"));
  for (let waited = 0; waited < ms; waited += 25) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
const timers = () =>
  process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

test("run: answers through a supervisor that keeps the protocol", async (t) => {
  const file = responseFile(t, { status: "ok", manifest }, [batchText]);
  for (const mode of ["answer", "slow", "require-open"]) {
    const result = await withFake(mode, file);
    assert.equal(result.batch.entries.length, 5, mode);
    // Closing stdin after the answer lets the supervisor go.
    assert.ok(await fakeGone(file), mode);
  }
  const described = await withFake(
    "answer",
    responseFile(t, { status: "ok", manifest }),
    { op: "describe", input: undefined, expectedManifest: manifest },
  );
  assert.deepEqual(described, { manifest });
});

test("run: the supervisor gets the request and SystemRoot, nothing else", async (t) => {
  const file = responseFile(t, { status: "ok", manifest }, [batchText]);
  process.env.NEMEIN_TEST_LEAK = "no debe pasar";
  t.after(() => delete process.env.NEMEIN_TEST_LEAK);
  await withFake("answer", file, { accountId: "1", config: undefined });
  const received = JSON.parse(readFileSync(file + ".request.json", "utf8"));
  assert.deepEqual(received.header, {
    op: "parse",
    config: "",
    account_id: "1",
  });
  assert.equal(
    received.env.SystemRoot,
    process.env.SystemRoot ?? "C:\\Windows",
  );
  assert.equal(received.env.NEMEIN_TEST_LEAK, undefined);
  // On Windows libuv adds the variables CreateProcess needs (PATH, TEMP...);
  // the supervisor ignores them and gives the worker only SystemRoot.
  if (process.platform !== "win32")
    assert.deepEqual(Object.keys(received.env), ["SystemRoot"]);
});

test("run: a settled run leaves no backstop timer behind", async (t) => {
  const file = responseFile(t, { status: "ok", manifest }, [batchText]);
  const before = timers();
  await withFake("linger", file, { timeoutMs: undefined });
  assert.equal(timers(), before);
  assert.equal(LIMITS.timeoutMs, LIMITS.deadlineMs + 5000);
});

test("run: a misbehaving or missing supervisor fails closed", async (t) => {
  const file = responseFile(t, { status: "ok", manifest }, [batchText]);
  await assert.rejects(
    withFake("crash", file),
    code("CONNECTOR_SUPERVISOR_FAILED"),
  );
  await assert.rejects(
    withFake("truncate", file),
    code("CONNECTOR_SUPERVISOR_FAILED"),
  );
  for (const mode of ["garbage", "extra"]) {
    await assert.rejects(withFake(mode, file), code("CONNECTOR_PROTOCOL"));
    assert.ok(await fakeGone(file), mode);
  }
  const started = Date.now();
  await assert.rejects(withFake("huge-blob", file), code("CONNECTOR_PROTOCOL"));
  assert.ok(Date.now() - started < 3000, "refused at the declared length");
  assert.ok(await fakeGone(file), "huge-blob");
  const hang = Date.now();
  await assert.rejects(
    withFake("hang", file, { timeoutMs: 300 }),
    code("CONNECTOR_TIMEOUT"),
  );
  assert.ok(Date.now() - hang < 3000);
  assert.ok(await fakeGone(file), "hang");
  // A supervisor that stops reading the request is stopped, not awaited.
  await assert.rejects(
    withFake("close-stdin", file, { component: Buffer.alloc(1 << 20) }),
    code("CONNECTOR_SUPERVISOR_FAILED"),
  );
  assert.ok(await fakeGone(file), "close-stdin");
});

test("run: a supervisor that cannot start fails closed", async (t) => {
  const missing = path.join(os.tmpdir(), "no-existe-nemein-connector.exe");
  await assert.rejects(
    runConnector({ ...request, command: missing }),
    (error) => {
      assert.equal(error.cause.code, "ENOENT");
      return code("CONNECTOR_UNAVAILABLE")(error);
    },
  );
  const previous = process.env.NEMEIN_CONNECTOR_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.NEMEIN_CONNECTOR_BIN;
    else process.env.NEMEIN_CONNECTOR_BIN = previous;
  });
  process.env.NEMEIN_CONNECTOR_BIN = missing;
  await assert.rejects(
    runConnector({ ...request, command: undefined }),
    (error) => {
      assert.equal(error.cause.code, "ENOENT");
      return code("CONNECTOR_UNAVAILABLE")(error);
    },
  );
  delete process.env.NEMEIN_CONNECTOR_BIN;
  await assert.rejects(
    runConnector({ ...request, command: undefined }),
    (error) => {
      assert.equal(error.cause, undefined);
      return code("CONNECTOR_UNAVAILABLE")(error);
    },
  );
  // Present but not runnable: a supervisor failure, not a missing one.
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-not-runnable-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const notRunnable = path.join(dir, "nemein-connector.txt");
  writeFileSync(notRunnable, "no es un ejecutable", { mode: 0o600 });
  await assert.rejects(
    runConnector({ ...request, command: notRunnable }),
    (error) => {
      assert.notEqual(error.cause.code, "ENOENT");
      return code("CONNECTOR_SUPERVISOR_FAILED")(error);
    },
  );
});

test("run: only Windows runs connectors, and requests are checked before spawning", async () => {
  if (process.platform !== "win32")
    await assert.rejects(
      runConnector({ ...request, platform: undefined }),
      code("CONNECTOR_UNSUPPORTED_PLATFORM"),
    );
  for (const platform of ["linux", "darwin", "freebsd"])
    await assert.rejects(
      runConnector({ ...request, platform }),
      code("CONNECTOR_UNSUPPORTED_PLATFORM"),
    );
  const invalid = [
    { op: "run" },
    { component: "texto" },
    { component: Buffer.alloc(LIMITS.component + 1) },
    { input: Buffer.alloc(LIMITS.input + 1) },
    { input: "texto" },
    { op: "describe" },
    { config: "c".repeat(LIMITS.config + 1) },
    { config: "ñ".repeat(LIMITS.config / 2 + 1) },
    { config: 1 },
    { accountId: 1 },
    { accountId: "0" },
    { accountId: "01" },
    { accountId: "-1" },
    { accountId: "1.0" },
    { accountId: " 1" },
    { accountId: "9007199254740992" },
    { accountId: "12345678901234567" },
  ];
  for (const extra of invalid)
    await assert.rejects(
      runConnector({ ...request, ...extra }),
      code("CONNECTOR_REQUEST_INVALID"),
      JSON.stringify(Object.keys(extra)),
    );
});

test("run: limits are inclusive", async (t) => {
  const file = responseFile(t, { status: "ok", manifest }, [batchText]);
  const result = await withFake("answer", file, {
    component: Buffer.alloc(LIMITS.component),
    input: Buffer.alloc(LIMITS.input),
    config: "c".repeat(LIMITS.config),
  });
  assert.equal(result.batch.account_id, 1);
  await assert.rejects(
    withFake("answer", file, { accountId: "9007199254740991" }),
    code("CONNECTOR_ACCOUNT_MISMATCH"),
  );
});
