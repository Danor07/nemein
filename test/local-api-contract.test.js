import test from "node:test";
import assert from "node:assert/strict";
import {
  apiError,
  errorStatus,
  apiFailure,
  checkApiHeaders,
  validateEnvelope,
  validateBatch,
  validateArguments,
  executeApiCall,
  executeApiBatch,
  apiVersion,
  apiLimits,
} from "../src/local-api-contract.js";

const coded = (code) => (e) => e.code === code && e.message.length > 0;
function headers(options = {}) {
  const values = {
    host: "127.0.0.1:4321",
    authorization: "Bearer " + "a".repeat(64),
    ...options,
  };
  return {
    headers: values,
    rawHeaders: Object.entries(values).flat(),
    socket: { localPort: 4321 },
    url: "/permissions",
  };
}

test("Header contract rejects ambiguous representations at exact boundaries", () => {
  assert.equal(apiVersion, "1.0.0");
  assert.deepEqual(apiLimits, { bodyBytes: 12000000, calls: 16 });
  assert.deepEqual(checkApiHeaders(headers()), {
    token: "a".repeat(64),
    version: "1",
  });
  assert.equal(
    checkApiHeaders(
      headers({
        origin: "http://127.0.0.1:4321",
        "nemein-connection-version": "x".repeat(40),
      }),
    ).version.length,
    40,
  );
  for (const version of ["", "x".repeat(41), "a/b", "a:b", "a b"])
    assert.throws(
      () => checkApiHeaders(headers({ "nemein-connection-version": version })),
      coded("VERSION_MISMATCH"),
    );
  for (const authorization of [
    undefined,
    "Bearer " + "a".repeat(63),
    "Bearer " + "a".repeat(65),
    "Bearer " + "G".repeat(64),
    " Bearer " + "a".repeat(64),
    "Bearer " + "a".repeat(64) + "\n",
  ])
    assert.throws(
      () => checkApiHeaders(headers({ authorization })),
      coded("AUTH_REQUIRED"),
    );
  assert.throws(
    () => checkApiHeaders(headers({ host: undefined })),
    coded("INVALID_HOST"),
  );
  assert.throws(
    () => checkApiHeaders(headers({ host: "127.0.0.1:43210" })),
    coded("INVALID_HOST"),
  );
  assert.throws(
    () => checkApiHeaders(headers({ origin: "" })),
    coded("INVALID_ORIGIN"),
  );
  for (const name of [
    "aUtHoRiZaTiOn",
    "Host",
    "Origin",
    "Nemein-Connection-Version",
    "Content-Type",
    "Content-Encoding",
  ]) {
    const duplicate = headers();
    duplicate.rawHeaders.push(name, "x", name, "y");
    assert.throws(() => checkApiHeaders(duplicate), coded("INVALID_REQUEST"));
  }
  assert.throws(
    () => checkApiHeaders({ ...headers(), url: "/permissions?x=1" }),
    coded("INVALID_REQUEST"),
  );
  assert.doesNotThrow(() => checkApiHeaders(headers({ "x-extra": "allowed" })));
});

test("Envelope and batch bounds are strict, without coercion, defaults or partial execution", async () => {
  const value = {
    arguments: {},
    base: "b".repeat(1024),
    purpose: "p".repeat(500),
    request_id: "r".repeat(100),
  };
  assert.doesNotThrow(() => validateEnvelope(value));
  assert.deepEqual(value.arguments, {});
  for (const invalid of [
    null,
    [],
    {},
    { arguments: 1 },
    { ...value, base: "b".repeat(1025) },
    { ...value, purpose: "p".repeat(501) },
    { ...value, purpose: "" },
    { ...value, request_id: "r".repeat(101) },
    { ...value, request_id: "" },
    { ...value, request_id: "a/b" },
    { ...value, request_id: 1 },
    { ...value, extra: true },
  ])
    assert.throws(() => validateEnvelope(invalid), coded("INVALID_REQUEST"));
  const call = { id: "i".repeat(100), action: "a".repeat(64), arguments: {} };
  assert.doesNotThrow(() => validateBatch({ calls: [call] }));
  assert.doesNotThrow(() =>
    validateBatch({ calls: [call, { ...call, id: "other" }] }),
  );
  for (const batch of [
    null,
    [],
    {},
    { calls: [] },
    { calls: [call], extra: true },
    { calls: [call, call] },
    { calls: [{ ...call, id: "i".repeat(101) }] },
    { calls: [{ ...call, action: "a".repeat(65) }] },
    { calls: [{ ...call, action: "" }] },
    { calls: [{ ...call, id: "" }] },
    { calls: [{ ...call, id: 1 }] },
    { calls: [{ action: call.action, arguments: {} }] },
    { calls: [{ id: call.id, arguments: {} }] },
    { calls: [{ id: call.id, action: call.action }] },
  ])
    assert.throws(() => validateBatch(batch), coded("INVALID_REQUEST"));
  let invoked = false;
  await assert.rejects(
    executeApiBatch(
      {
        request: () => {
          invoked = true;
        },
      },
      {
        calls: [
          { id: "ok", action: "group", arguments: { name: "Fixture" } },
          { id: "bad" },
        ],
      },
    ),
    coded("INVALID_REQUEST"),
  );
  assert.equal(invoked, false);
});

test("Action contracts retain integer types and invoke the scoped facade with state metadata", async () => {
  for (const action of ["__proto__", "constructor", "unknown"])
    assert.throws(() => validateArguments(action, {}), coded("INVALID_ACTION"));
  for (const amount of [1.5, "1", Infinity])
    assert.throws(
      () =>
        validateArguments("transaction", {
          account_id: 1,
          date: "2026-10-20",
          payee: "Fixture",
          amount,
        }),
      coded("INVALID_ARGUMENTS"),
    );
  assert.doesNotThrow(() => validateArguments("recurring", {}));
  const envelope = {
    arguments: { name: "Fixture" },
    base: "base",
    request_id: "request",
    purpose: "purpose",
  };
  let observed;
  const agent = {
    request: (...args) => {
      observed = args;
    },
  };
  assert.deepEqual(await executeApiCall(agent, "group", envelope), {
    ok: true,
    result: null,
  });
  assert.deepEqual(observed, [
    "group",
    envelope.arguments,
    {
      base: "base",
      request_id: "request",
      purpose: "purpose",
      requireBase: true,
    },
  ]);
  assert.deepEqual(
    await executeApiCall(
      { permissions: () => ({ own: true }) },
      "permissions",
      { arguments: {} },
    ),
    { ok: true, result: { own: true } },
  );
  assert.deepEqual(
    await executeApiCall({ proposalStatus: (p) => p.id }, "proposal-status", {
      arguments: { id: "own" },
    }),
    { ok: true, result: "own" },
  );
  assert.deepEqual(
    await executeApiBatch(
      { request: () => "done" },
      {
        calls: [{ id: "one", action: "group", arguments: { name: "Fixture" } }],
      },
    ),
    {
      results: [{ id: "one", action: "group", ok: true, result: "done" }],
    },
  );
  const rejected = await executeApiCall(
    { request: () => assert.fail("Invalid arguments reached the facade") },
    "group",
    { arguments: { name: 1 } },
  );
  assert.equal(rejected.error.code, "INVALID_ARGUMENTS");
  const failure = await executeApiCall(
    {
      request: async () => {
        throw apiFailure("PERMISSION_DENIED", "Denied fixture");
      },
    },
    "group",
    envelope,
  );
  assert.deepEqual(failure, {
    ok: false,
    error: { code: "PERMISSION_DENIED", message: "Denied fixture" },
  });
});

test("Transport errors classify domain failures and redact implementation errors", () => {
  for (const [status, codes] of [
    [401, ["AUTH_REQUIRED"]],
    [403, ["INVALID_HOST", "INVALID_ORIGIN", "PERMISSION_DENIED"]],
    [404, ["API_DISABLED", "NOT_FOUND", "PROPOSAL_NOT_FOUND"]],
    [405, ["METHOD_NOT_ALLOWED"]],
    [
      409,
      [
        "STATE_CONFLICT",
        "PROPOSAL_CONFLICT",
        "REQUEST_ID_REUSED",
        "VERSION_MISMATCH",
        "CURSOR_MISMATCH",
        "EVENT_HISTORY_GAP",
      ],
    ],
    [413, ["BODY_TOO_LARGE"]],
    [415, ["UNSUPPORTED_MEDIA_TYPE"]],
    [500, ["INTERNAL_ERROR"]],
    [
      400,
      ["INVALID_REQUEST", "INVALID_CURSOR", "BASE_REQUIRED", "INVALID_JSON"],
    ],
  ])
    for (const code of codes) assert.equal(errorStatus(code), status);
  for (const code of [
    "SQLITE_ERROR",
    "SQLITE_CONSTRAINT_UNIQUE",
    "EACCES",
    "ENOENT",
    "INTERNAL_ERROR",
    "ERR_FS_EISDIR",
  ]) {
    const safe = apiError(
      apiFailure(code, "private path / SQL / secret fixture"),
    );
    assert.deepEqual(safe, {
      code: "INTERNAL_ERROR",
      message: "The operation failed.",
    });
  }
  for (const runtime of [
    new TypeError("C:\\private\\path"),
    new RangeError("Maximum call stack size exceeded"),
  ])
    assert.deepEqual(apiError(runtime), {
      code: "INTERNAL_ERROR",
      message: "The operation failed.",
    });
  assert.deepEqual(apiError(Error("Domain validation")), {
    code: "INVALID_REQUEST",
    message: "Domain validation",
  });
  for (const code of [
    "EVENT_HISTORY_GAP",
    "EXPORT_TOO_LARGE",
    "INVALID_CURSOR",
  ])
    assert.deepEqual(apiError(apiFailure(code, "Domain failure")), {
      code,
      message: "Domain failure",
    });
});
