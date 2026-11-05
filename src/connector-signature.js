import { createHash, createPublicKey, sign, verify } from "node:crypto";

// Author signatures of connector components (docs/conectores.md, "Firma").
// A signature informs; it never blocks running or enabling. Without a valid
// one, enabling needs the owner's explicit acknowledgement.
//
// What is signed is Nemein's own domain bytes followed by the component's
// SHA-256, like the namespace of SSH signatures (PROTOCOL.sshsig): a Nemein
// signature never verifies as a signature over anything else, and no other
// product's signature over the same hash verifies here.
export const SIGNATURE_DOMAIN = Buffer.from("nemein:connector-signature:v1\n");
export const SIGNATURE_FORMAT = "nemein-connector-signature";
// The signature file is small: anything longer is not one.
export const SIGNATURE_MAX = 4096;

const HASH = /^[0-9a-f]{64}$/;
const fail = (message) =>
  Object.assign(new Error(message), { code: "CONNECTOR_REQUEST_INVALID" });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Strict base64 of exactly `length` bytes.
function bytesOf(text, length, what) {
  const bytes = typeof text === "string" ? Buffer.from(text, "base64") : null;
  if (!bytes || bytes.length !== length || bytes.toString("base64") !== text)
    throw fail(`La firma tiene ${what} inválida.`);
  return bytes;
}

export const signedMessage = (componentHash) =>
  Buffer.concat([SIGNATURE_DOMAIN, Buffer.from(componentHash, "hex")]);

// A signature file as stored: exactly these fields, or a refusal. Accepts the
// parsed object or its JSON text.
export function parseSignature(value) {
  let file = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > SIGNATURE_MAX)
      throw fail("El archivo de firma supera su límite.");
    try {
      file = JSON.parse(value);
    } catch {
      throw fail("El archivo de firma no es JSON.");
    }
  }
  const keys = [
    "algorithm",
    "component_sha256",
    "format",
    "public_key",
    "signature",
    "version",
  ];
  // Object.keys of a number or a boolean is empty: only null needs a guard.
  if (
    !file ||
    Array.isArray(file) ||
    Object.keys(file).sort().join() !== keys.join() ||
    file.format !== SIGNATURE_FORMAT ||
    file.version !== 1 ||
    file.algorithm !== "ed25519" ||
    typeof file.component_sha256 !== "string" ||
    !HASH.test(file.component_sha256)
  )
    throw fail("El archivo de firma no tiene el formato de Nemein.");
  bytesOf(file.public_key, 32, "una clave pública");
  bytesOf(file.signature, 64, "una firma");
  return {
    format: SIGNATURE_FORMAT,
    version: 1,
    algorithm: "ed25519",
    component_sha256: file.component_sha256,
    public_key: file.public_key,
    signature: file.signature,
  };
}

// What the screen shows: absent, valid or invalid, with the key's
// fingerprint (SHA-256 of the raw public key). It never throws.
export function checkSignature(componentHash, stored) {
  if (!stored) return { status: "absent" };
  let file;
  try {
    file = parseSignature(stored);
  } catch {
    return { status: "invalid", reason: "format" };
  }
  const raw = Buffer.from(file.public_key, "base64");
  const key = sha256(raw);
  if (file.component_sha256 !== componentHash)
    return { status: "invalid", reason: "component", key };
  // The parse fixed both lengths; verification then answers false, also for
  // a public key that is not a point of the curve.
  const ok = verify(
    null,
    signedMessage(componentHash),
    createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    }),
    Buffer.from(file.signature, "base64"),
  );
  return ok
    ? { status: "valid", key }
    : { status: "invalid", reason: "signature", key };
}

// For authors and tests: the signature file for a component, with an
// Ed25519 private key (a KeyObject or PEM).
export function signComponent(componentHash, privateKey) {
  if (!HASH.test(componentHash))
    throw fail("El componente no es un hash válido.");
  const publicKey = createPublicKey(privateKey).export({ format: "jwk" });
  if (publicKey.crv !== "Ed25519") throw fail("La clave no es Ed25519.");
  return {
    format: SIGNATURE_FORMAT,
    version: 1,
    algorithm: "ed25519",
    component_sha256: componentHash,
    public_key: Buffer.from(publicKey.x, "base64url").toString("base64"),
    signature: sign(null, signedMessage(componentHash), privateKey).toString(
      "base64",
    ),
  };
}
