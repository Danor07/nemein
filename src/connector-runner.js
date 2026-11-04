import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { validateImportBatch } from "./import-contract.js";

// Runs one connector component through the nemein-connector supervisor, which
// encloses the worker (docs/conectores.md). Nothing the worker answers is
// trusted: the manifest, the approved manifest, the batch v1, the account and
// the provenance are all checked here, outside the enclosure. This module
// never opens the budget or writes to it.

export const LIMITS = Object.freeze({
  component: 16 * 1024 * 1024,
  input: 5_000_000,
  config: 16_384,
  header: 65_536,
  output: 25_165_824,
  deadlineMs: 10_000,
  // The supervisor enforces the deadline; this backstop only covers a stuck
  // supervisor: the deadline plus five seconds.
  timeoutMs: 15_000,
});

const MAGIC = Buffer.from("NMC");
const VERSION = 1;
const REQUEST = "Q".charCodeAt(0);
const RESPONSE = "R".charCodeAt(0);

// Failures the supervisor and the worker report, and the code each becomes.
const HOST_CODES = new Map([
  ["REQUEST_INVALID", "CONNECTOR_REQUEST_INVALID"],
  ["COMPONENT_INVALID", "CONNECTOR_COMPONENT_INVALID"],
  ["COMPONENT_HAS_IMPORTS", "CONNECTOR_COMPONENT_HAS_IMPORTS"],
  ["COMPONENT_WRONG_WORLD", "CONNECTOR_COMPONENT_WRONG_WORLD"],
  ["CONNECTOR_TRAP", "CONNECTOR_TRAP"],
  ["MANIFEST_TOO_LARGE", "CONNECTOR_MANIFEST_TOO_LARGE"],
  ["ERROR_TOO_LARGE", "CONNECTOR_ERROR_TOO_LARGE"],
  ["OUTPUT_TOO_LARGE", "CONNECTOR_OUTPUT_TOO_LARGE"],
  ["TIMEOUT", "CONNECTOR_TIMEOUT"],
  ["MEMORY_LIMIT", "CONNECTOR_MEMORY_LIMIT"],
  ["WORKER_CRASHED", "CONNECTOR_WORKER_CRASHED"],
  ["WORKER_PROTOCOL", "CONNECTOR_WORKER_PROTOCOL"],
  ["SANDBOX_UNAVAILABLE", "CONNECTOR_SANDBOX_UNAVAILABLE"],
  ["UNSUPPORTED_PLATFORM", "CONNECTOR_UNSUPPORTED_PLATFORM"],
]);

const fail = (code, message, extra) =>
  Object.assign(new Error(message), { code }, extra);

const chars = (text) => [...text].length;
const hasContent = (text) => /\S/u.test(text);

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

// One request frame: header JSON plus the component and the file.
export function encodeRequest({ op, component, input, config, accountId }) {
  const header = Buffer.from(
    JSON.stringify({ op, config, account_id: accountId }),
  );
  return Buffer.concat([
    MAGIC,
    Buffer.from([VERSION, REQUEST]),
    u32(header.length),
    header,
    Buffer.from([2]),
    u32(component.length),
    component,
    u32(input.length),
    input,
  ]);
}

// Incremental reader of exactly one response frame. Each length is checked
// before its bytes are accepted, so a peer cannot make this buffer more than
// the limits. Only the short prefix is merged while lengths are unknown; the
// body is joined once, when complete. Bytes after the frame are an error.
export function responseReader() {
  const chunks = [];
  let length = 0;
  let expected = null;
  let frame = null;
  const protocol = (message) => fail("CONNECTOR_PROTOCOL", message);
  // The first n bytes, copied, or null while they have not all arrived. Only
  // the prefix is copied: at most 14 bytes plus the 64 KiB header.
  const prefix = (n) => (length < n ? null : Buffer.concat(chunks, n));
  function measure() {
    const head = prefix(5);
    if (!head) return null;
    if (
      !head.subarray(0, 3).equals(MAGIC) ||
      head[3] !== VERSION ||
      head[4] !== RESPONSE
    )
      throw protocol("La respuesta del conector no es una trama válida.");
    const lengths = prefix(9);
    if (!lengths) return null;
    const headerLength = lengths.readUInt32LE(5);
    if (headerLength > LIMITS.header)
      throw protocol("El encabezado de la respuesta supera su límite.");
    const counted = prefix(10 + headerLength);
    if (!counted) return null;
    const count = counted[9 + headerLength];
    if (count > 1)
      throw protocol("La respuesta del conector trae bloques de más.");
    if (count === 0) return 10 + headerLength;
    const blob = prefix(14 + headerLength);
    if (!blob) return null;
    const blobLength = blob.readUInt32LE(10 + headerLength);
    if (blobLength > LIMITS.output)
      throw protocol("El lote de la respuesta supera su límite.");
    return 14 + headerLength + blobLength;
  }
  return {
    push(chunk) {
      if (frame) throw protocol("La respuesta del conector trae bytes de más.");
      chunks.push(chunk);
      length += chunk.length;
      expected ??= measure();
      if (expected === null || length < expected) return null;
      if (length > expected)
        throw protocol("La respuesta del conector trae bytes de más.");
      const all = Buffer.concat(chunks);
      const headerLength = all.readUInt32LE(5);
      const blobs =
        all[9 + headerLength] === 1 ? [all.subarray(14 + headerLength)] : [];
      frame = { header: all.subarray(9, 9 + headerLength), blobs };
      return frame;
    },
  };
}

// The manifest as the WIT declares it; anything else is a lying connector.
export function validateManifest(manifest) {
  const keys = ["id", "version", "name", "description", "extensions"];
  const invalid = () =>
    fail(
      "CONNECTOR_MANIFEST_INVALID",
      "El manifiesto del conector no cumple el contrato.",
    );
  // Object.keys rejects arrays and primitives; only null and undefined throw.
  if (!manifest || !isDeepStrictEqual(Object.keys(manifest), keys))
    throw invalid();
  const { id, version, name, description, extensions } = manifest;
  const text = (value, required, max) =>
    typeof value === "string" &&
    chars(value) <= max &&
    (!required || hasContent(value));
  if (
    typeof id !== "string" ||
    id.length > 160 ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id) ||
    !text(version, true, 80) ||
    !text(name, true, 80) ||
    !text(description, false, 500) ||
    !Array.isArray(extensions) ||
    extensions.length > 8 ||
    !extensions.every(
      (e) => typeof e === "string" && /^[a-z0-9]{1,16}$/.test(e),
    )
  )
    throw invalid();
  return manifest;
}

function validateConnectorError(error) {
  if (
    !error ||
    !isDeepStrictEqual(Object.keys(error), ["code", "message"]) ||
    typeof error.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ||
    typeof error.message !== "string" ||
    chars(error.message) < 1 ||
    chars(error.message) > 1024
  )
    throw fail(
      "CONNECTOR_PROTOCOL",
      "El error del conector no cumple el contrato.",
    );
  return error;
}

function validateRequest({ op, component, input, config, accountId }) {
  const invalid = (message) => fail("CONNECTOR_REQUEST_INVALID", message);
  if (op !== "describe" && op !== "parse")
    throw invalid("Operación de conector desconocida.");
  if (!Buffer.isBuffer(component) || component.length > LIMITS.component)
    throw invalid("El componente supera su límite.");
  if (!Buffer.isBuffer(input) || input.length > LIMITS.input)
    throw invalid("El archivo supera su límite.");
  if (op === "describe" && input.length > 0)
    throw invalid("describe no recibe archivo.");
  if (typeof config !== "string" || Buffer.byteLength(config) > LIMITS.config)
    throw invalid("La configuración supera su límite.");
  if (
    typeof accountId !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(accountId) ||
    !Number.isSafeInteger(Number(accountId))
  )
    throw invalid("La cuenta de destino no es un identificador válido.");
}

// Interprets one response frame for `op`, outside the enclosure.
export function interpret(frame, { op, accountId, expectedManifest }) {
  let header;
  try {
    header = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(frame.header),
    );
  } catch {
    throw fail(
      "CONNECTOR_PROTOCOL",
      "El encabezado de la respuesta no es JSON.",
    );
  }
  const status = header?.status;
  if (status === "host_error") {
    if (
      !isDeepStrictEqual(Object.keys(header), ["status", "code", "message"]) ||
      !HOST_CODES.has(header.code) ||
      typeof header.message !== "string" ||
      frame.blobs.length !== 0
    )
      throw fail("CONNECTOR_PROTOCOL", "Error de anfitrión desconocido.");
    throw fail(HOST_CODES.get(header.code), header.message);
  }
  if (status !== "ok" && status !== "connector_error")
    throw fail("CONNECTOR_PROTOCOL", "Estado de respuesta desconocido.");
  const keys =
    status === "ok" ? ["status", "manifest"] : ["status", "manifest", "error"];
  if (!isDeepStrictEqual(Object.keys(header), keys))
    throw fail("CONNECTOR_PROTOCOL", "Encabezado de respuesta inesperado.");
  const manifest = validateManifest(header.manifest);
  if (
    expectedManifest !== undefined &&
    !isDeepStrictEqual(manifest, expectedManifest)
  )
    throw fail(
      "CONNECTOR_MANIFEST_MISMATCH",
      "El conector declara otro manifiesto que el aprobado.",
    );
  if (status === "connector_error") {
    if (frame.blobs.length !== 0)
      throw fail("CONNECTOR_PROTOCOL", "Un error no trae lote.");
    const error = validateConnectorError(header.error);
    throw fail("CONNECTOR_REJECTED", error.message, {
      connectorCode: error.code,
    });
  }
  if (op === "describe") {
    if (frame.blobs.length !== 0)
      throw fail("CONNECTOR_PROTOCOL", "describe no devuelve lote.");
    return { manifest };
  }
  if (frame.blobs.length !== 1)
    throw fail("CONNECTOR_PROTOCOL", "parse debe devolver un lote.");
  let batch;
  try {
    batch = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(frame.blobs[0]),
    );
  } catch (cause) {
    throw fail(
      "IMPORT_INVALID_BATCH",
      "El lote no cumple el contrato de importación v1.",
      { cause },
    );
  }
  validateImportBatch(batch);
  if (batch.account_id !== Number(accountId))
    throw fail(
      "CONNECTOR_ACCOUNT_MISMATCH",
      "El lote declara otra cuenta que la elegida.",
    );
  if (
    batch.provenance.connector !== manifest.id ||
    batch.provenance.version !== manifest.version
  )
    throw fail(
      "CONNECTOR_PROVENANCE_MISMATCH",
      "La procedencia del lote no coincide con el manifiesto.",
    );
  return { manifest, batch };
}

// Runs `op` on `component`. Resolves with `{manifest}` or `{manifest, batch}`;
// rejects with an Error carrying `code`. `command` is the supervisor, as a path
// or `[path, ...args]` (tests); production uses NEMEIN_CONNECTOR_BIN, set by
// the desktop shell, on Windows only. `platform` and `timeoutMs` are for tests.
export function runConnector({
  op,
  component,
  input = Buffer.alloc(0),
  config = "",
  accountId,
  expectedManifest,
  command = process.env.NEMEIN_CONNECTOR_BIN,
  platform = process.platform,
  timeoutMs = LIMITS.timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    if (platform !== "win32")
      return reject(
        fail(
          "CONNECTOR_UNSUPPORTED_PLATFORM",
          "Los conectores sólo corren en Windows, dentro de su encierro.",
        ),
      );
    validateRequest({ op, component, input, config, accountId });
    if (!command)
      return reject(
        fail(
          "CONNECTOR_UNAVAILABLE",
          "No se encontró el ejecutable de conectores.",
        ),
      );
    const [file, ...args] = [command].flat();
    // Only SystemRoot: the supervisor needs nothing else from Node's
    // environment, and a stderr nobody reads must not be able to block it.
    // The supervisor is a GUI-subsystem binary, so it never opens a console.
    const child = spawn(file, args, {
      stdio: ["pipe", "pipe", "ignore"],
      env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" },
    });
    const reader = responseReader();
    // Promises settle once; the first outcome wins.
    const finish = (error, value) => {
      clearTimeout(timer);
      child.stdin.destroy();
      if (error) {
        child.kill();
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish(
          fail("CONNECTOR_TIMEOUT", "El conector superó el tiempo permitido."),
        ),
      timeoutMs,
    );
    child.on("error", (error) =>
      finish(
        fail(
          error.code === "ENOENT"
            ? "CONNECTOR_UNAVAILABLE"
            : "CONNECTOR_SUPERVISOR_FAILED",
          "No se pudo iniciar el ejecutable de conectores.",
          { cause: error },
        ),
      ),
    );
    child.stdout.on("data", (chunk) => {
      let frame;
      try {
        frame = reader.push(chunk);
      } catch (error) {
        return finish(error);
      }
      if (!frame) return;
      try {
        finish(null, interpret(frame, { op, accountId, expectedManifest }));
      } catch (error) {
        finish(error);
      }
    });
    child.on("close", () =>
      finish(
        fail(
          "CONNECTOR_SUPERVISOR_FAILED",
          "El supervisor de conectores terminó sin responder.",
        ),
      ),
    );
    // EPIPE: the supervisor stopped reading before the whole request arrived.
    // Whatever it says next would not answer this request.
    child.stdin.on("error", (cause) =>
      finish(
        fail(
          "CONNECTOR_SUPERVISOR_FAILED",
          "El supervisor de conectores no recibió la solicitud completa.",
          { cause },
        ),
      ),
    );
    // stdin stays open until the answer: closing it would cancel the run.
    child.stdin.write(
      encodeRequest({ op, component, input, config, accountId }),
    );
  });
}
