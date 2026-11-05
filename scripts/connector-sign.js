import { createHash, createPrivateKey, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { signComponent } from "../src/connector-signature.js";

// For connector authors (docs/conectores.md, "Firma"):
//   node scripts/connector-sign.js keygen <private-key.pem>
//   node scripts/connector-sign.js sign <component.wasm> <private-key.pem> <signature.json>
// Neither command overwrites a file. The key is PKCS#8 PEM, readable only by
// its owner where the system supports it. Nemein never needs the private key.
const fingerprint = (publicKey) =>
  createHash("sha256")
    .update(Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"))
    .digest("hex");

export function connectorSign(args) {
  const [command, ...rest] = args;
  if (command === "keygen" && rest.length === 1) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(
      rest[0],
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { flag: "wx", mode: 0o600 },
    );
    return `Clave creada. Huella de la clave pública: ${fingerprint(publicKey)}`;
  }
  if (command === "sign" && rest.length === 3) {
    const [component, keyFile, output] = rest;
    const hash = createHash("sha256")
      .update(readFileSync(component))
      .digest("hex");
    const signature = signComponent(
      hash,
      createPrivateKey(readFileSync(keyFile)),
    );
    writeFileSync(output, JSON.stringify(signature, null, 2) + "\n", {
      flag: "wx",
    });
    return `Firma escrita para ${hash}.`;
  }
  throw Object.assign(
    new Error(
      "Uso: connector-sign.js keygen <clave.pem> | sign <componente.wasm> <clave.pem> <firma.json>",
    ),
    { code: "USAGE" },
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(connectorSign(process.argv.slice(2)) + "\n");
  } catch (e) {
    process.stderr.write(e.message + "\n");
    process.exitCode = e.code === "USAGE" ? 2 : 1;
  }
}
