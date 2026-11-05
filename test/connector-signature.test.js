import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SIGNATURE_DOMAIN,
  SIGNATURE_MAX,
  checkSignature,
  parseSignature,
  signComponent,
  signedMessage,
} from "../src/connector-signature.js";
import { connectorSign } from "../scripts/connector-sign.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const hash = sha("componente ficticio");
const keys = () => generateKeyPairSync("ed25519");
const refused = { code: "CONNECTOR_REQUEST_INVALID" };

test("the signed bytes are Nemein's domain followed by the raw component hash", () => {
  assert.equal(
    SIGNATURE_DOMAIN.toString("utf8"),
    "nemein:connector-signature:v1\n",
  );
  const message = signedMessage(hash);
  assert.equal(message.length, SIGNATURE_DOMAIN.length + 32);
  assert.deepEqual(
    message.subarray(0, SIGNATURE_DOMAIN.length),
    SIGNATURE_DOMAIN,
  );
  assert.equal(message.subarray(SIGNATURE_DOMAIN.length).toString("hex"), hash);
  assert.equal(SIGNATURE_MAX, 4096);
});

test("a signature verifies for its component only, and only with Nemein's domain", () => {
  const { privateKey, publicKey } = keys();
  const file = signComponent(hash, privateKey);
  assert.deepEqual(Object.keys(file), [
    "format",
    "version",
    "algorithm",
    "component_sha256",
    "public_key",
    "signature",
  ]);
  assert.equal(file.format, "nemein-connector-signature");
  const key = createHash("sha256")
    .update(Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"))
    .digest("hex");
  assert.deepEqual(checkSignature(hash, file), { status: "valid", key });
  assert.deepEqual(checkSignature(hash, JSON.stringify(file)), {
    status: "valid",
    key,
  });
  // Another component.
  assert.deepEqual(checkSignature(sha("otro"), file), {
    status: "invalid",
    reason: "component",
    key,
  });
  // The same hash signed without the domain, or under another product's.
  for (const message of [
    Buffer.from(hash, "hex"),
    Buffer.concat([
      Buffer.from("otro:producto:v1\n"),
      Buffer.from(hash, "hex"),
    ]),
  ])
    assert.deepEqual(
      checkSignature(hash, {
        ...file,
        signature: sign(null, message, privateKey).toString("base64"),
      }),
      { status: "invalid", reason: "signature", key },
    );
  // Another key over the right bytes.
  const other = signComponent(hash, keys().privateKey);
  assert.equal(
    checkSignature(hash, { ...file, public_key: other.public_key }).status,
    "invalid",
  );
  // A public key that is not a point on the curve.
  assert.deepEqual(
    checkSignature(hash, {
      ...file,
      public_key: Buffer.alloc(32, 0xff).toString("base64"),
    }).reason,
    "signature",
  );
  assert.deepEqual(checkSignature(hash, null), { status: "absent" });
  assert.deepEqual(checkSignature(hash, undefined), { status: "absent" });
  assert.deepEqual(checkSignature(hash, { x: 1 }), {
    status: "invalid",
    reason: "format",
  });
});

test("the signature file is exactly Nemein's format", () => {
  const file = signComponent(hash, keys().privateKey);
  assert.deepEqual(parseSignature(file), file);
  assert.deepEqual(parseSignature(JSON.stringify(file)), file);
  const b64 = (n, fill = 1) => Buffer.alloc(n, fill).toString("base64");
  for (const bad of [
    null,
    [],
    "",
    "{",
    "null",
    7,
    { ...file, extra: 1 },
    Object.fromEntries(Object.entries(file).slice(1)),
    { ...file, format: "otra-firma" },
    { ...file, version: 2 },
    { ...file, version: "1" },
    { ...file, algorithm: "ecdsa" },
    { ...file, component_sha256: hash.toUpperCase() },
    { ...file, component_sha256: hash + "0" },
    { ...file, component_sha256: "x" + hash.slice(1) },
    { ...file, component_sha256: [hash] },
    { ...file, public_key: b64(31) },
    { ...file, public_key: b64(33) },
    { ...file, public_key: b64(32).replace(/=$/, "") },
    { ...file, public_key: 32 },
    { ...file, signature: b64(63) },
    { ...file, signature: b64(65) },
    { ...file, signature: " " + file.signature },
    JSON.stringify({ ...file, padding: "x".repeat(SIGNATURE_MAX) }),
  ])
    assert.throws(() => parseSignature(bad), refused, JSON.stringify(bad));
  // The limit is in bytes of text.
  const text = JSON.stringify(file);
  const padded =
    text.slice(0, -1) + " ".repeat(SIGNATURE_MAX - text.length) + "}";
  assert.equal(Buffer.byteLength(padded), SIGNATURE_MAX);
  assert.deepEqual(parseSignature(padded), file);
  assert.throws(() => parseSignature(padded + " "), refused);
  assert.throws(() => parseSignature(" ".repeat(SIGNATURE_MAX + 1)), {
    message: "El archivo de firma supera su límite.",
  });
  assert.throws(() => parseSignature("{"), {
    message: "El archivo de firma no es JSON.",
  });
  for (const bad of [null, 7, true, '"texto"', { ...file, version: 2 }])
    assert.throws(() => parseSignature(bad), {
      message: "El archivo de firma no tiene el formato de Nemein.",
    });
  assert.throws(() => parseSignature({ ...file, public_key: "x" }), {
    message: "La firma tiene una clave pública inválida.",
  });
  assert.throws(() => parseSignature({ ...file, signature: "x" }), {
    message: "La firma tiene una firma inválida.",
  });
});

test("signing needs a component hash and an Ed25519 key", () => {
  assert.throws(() => signComponent("x", keys().privateKey), {
    ...refused,
    message: "El componente no es un hash válido.",
  });
  assert.throws(() => signComponent(hash + "0", keys().privateKey), refused);
  for (const kind of ["x25519", "ed448"])
    assert.throws(
      () => signComponent(hash, generateKeyPairSync(kind).privateKey),
      { ...refused, message: "La clave no es Ed25519." },
    );
  // A PEM works as well as a key object.
  const { privateKey } = keys();
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  assert.equal(checkSignature(hash, signComponent(hash, pem)).status, "valid");
});

test("the author's tool creates a key and signs, and never overwrites a file", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-connector-sign-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, "clave.pem");
  const component = path.join(dir, "componente.wasm");
  const out = path.join(dir, "firma.json");
  writeFileSync(component, "componente ficticio");
  const created = connectorSign(["keygen", key]);
  assert.match(
    created,
    /^Clave creada\. Huella de la clave pública: [0-9a-f]{64}$/,
  );
  if (process.platform !== "win32")
    assert.equal(statSync(key).mode & 0o777, 0o600);
  assert.equal(
    createPrivateKey(readFileSync(key)).asymmetricKeyType,
    "ed25519",
  );
  assert.equal(
    connectorSign(["sign", component, key, out]),
    `Firma escrita para ${hash}.`,
  );
  const file = JSON.parse(readFileSync(out, "utf8"));
  assert.match(readFileSync(out, "utf8"), /\n$/);
  assert.deepEqual(checkSignature(hash, file), {
    status: "valid",
    key: created.slice(-64),
  });
  assert.throws(() => connectorSign(["keygen", key]), { code: "EEXIST" });
  assert.throws(() => connectorSign(["sign", component, key, out]), {
    code: "EEXIST",
  });
  for (const args of [
    [],
    ["keygen"],
    ["sign", component, key],
    ["otro", key],
    ["firmar", component, key, path.join(dir, "otra.json")],
  ])
    assert.throws(() => connectorSign(args), { code: "USAGE" });

  // As a command: exit codes and output streams.
  const script = fileURLToPath(
    new URL("../scripts/connector-sign.js", import.meta.url),
  );
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  let r = run("keygen", path.join(dir, "otra.pem"));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Clave creada\. .*\n$/);
  r = run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^Uso: connector-sign\.js.*\n$/);
  r = run("keygen", key);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /EEXIST.*\n$/);
});
