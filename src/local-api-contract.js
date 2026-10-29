import Ajv2020 from "ajv/dist/2020.js";
import { z } from "zod";
import { actions, connectionActions } from "./actions.js";
import { actionShapes } from "./action-schemas.js";

export const apiVersion = "1.0.0";
export const apiLimits = Object.freeze({ bodyBytes: 12000000, calls: 16 });
export const apiActions = Object.freeze({ ...actions, ...connectionActions });
export const apiFailure = (code, message) =>
  Object.assign(new Error(message), { code });
const ajv = new Ajv2020();
export const argumentSchemas = Object.fromEntries(
  Object.keys(apiActions).map((action) => {
    if (!Object.hasOwn(actionShapes, action))
      throw Error("Missing action schema: " + action);
    return [
      action,
      z.toJSONSchema(z.strictObject(actionShapes[action]), { io: "input" }),
    ];
  }),
);
const argumentValidators = Object.fromEntries(
  Object.entries(argumentSchemas).map(([action, schema]) => [
    action,
    ajv.compile(schema),
  ]),
);
export const envelopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["arguments"],
  properties: {
    arguments: { type: "object" },
    base: { type: "string", maxLength: 1024 },
    request_id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" },
    purpose: { type: "string", minLength: 1, maxLength: 500 },
  },
};
export const batchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["calls"],
  properties: {
    calls: {
      type: "array",
      minItems: 1,
      maxItems: apiLimits.calls,
      items: {
        ...envelopeSchema,
        required: ["id", "action", "arguments"],
        properties: {
          ...envelopeSchema.properties,
          id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" },
          action: { type: "string", minLength: 1, maxLength: 64 },
        },
      },
    },
  },
};
const validEnvelope = ajv.compile(envelopeSchema);
const validBatch = ajv.compile(batchSchema);

export function validateEnvelope(value) {
  if (!validEnvelope(value))
    throw apiFailure("INVALID_REQUEST", "Invalid call envelope.");
}
export function validateBatch(value) {
  if (!validBatch(value))
    throw apiFailure("INVALID_REQUEST", "Invalid batch envelope.");
  const ids = value.calls.map((call) => call.id);
  if (new Set(ids).size !== ids.length)
    throw apiFailure("INVALID_REQUEST", "Duplicate call id.");
}
export function validateArguments(action, args) {
  if (!Object.hasOwn(apiActions, action))
    throw apiFailure("INVALID_ACTION", "Unknown action.");
  if (!argumentValidators[action](args))
    throw apiFailure(
      "INVALID_ARGUMENTS",
      "Arguments do not match the action schema.",
    );
}

export function checkApiHeaders(req) {
  const sensitive = [
    "host",
    "origin",
    "authorization",
    "nemein-connection-version",
    "content-type",
    "content-encoding",
  ];
  const names = req.rawHeaders
    .filter((_, i) => i % 2 === 0)
    .map((name) => name.toLowerCase());
  if (sensitive.some((name) => names.filter((n) => n === name).length > 1))
    throw apiFailure("INVALID_REQUEST", "Duplicate security header.");
  const host = "127.0.0.1:" + req.socket.localPort;
  if (req.headers.host !== host)
    throw apiFailure("INVALID_HOST", "Local host required.");
  if (
    req.headers.origin !== undefined &&
    req.headers.origin !== "http://" + host
  )
    throw apiFailure("INVALID_ORIGIN", "Origin is not allowed.");
  if (req.url.includes("?"))
    throw apiFailure("INVALID_REQUEST", "Query strings are not accepted.");
  const bearer = /^Bearer ([a-f0-9]{64})$/.exec(
    req.headers.authorization || "",
  );
  if (!bearer)
    throw apiFailure("AUTH_REQUIRED", "A connection Bearer token is required.");
  const version = req.headers["nemein-connection-version"] ?? "1";
  if (!/^[a-zA-Z0-9._-]{1,40}$/.test(version))
    throw apiFailure("VERSION_MISMATCH", "Invalid connection version.");
  return { token: bearer[1], version };
}

export function apiError(error) {
  const code = error.code || "INVALID_REQUEST";
  // Domain validations throw plain Errors whose message helps the client;
  // runtime failures (TypeError, RangeError, Node ERR_*) may expose paths.
  if (
    (!error.code && error.constructor !== Error) ||
    code.startsWith("SQLITE_") ||
    code.startsWith("ERR_") ||
    /^E[A-Z]+$/.test(code) ||
    code === "INTERNAL_ERROR"
  )
    return { code: "INTERNAL_ERROR", message: "The operation failed." };
  return { code, message: error.message };
}
export function errorStatus(code) {
  if (code === "AUTH_REQUIRED") return 401;
  if (["INVALID_HOST", "INVALID_ORIGIN", "PERMISSION_DENIED"].includes(code))
    return 403;
  if (["API_DISABLED", "NOT_FOUND", "PROPOSAL_NOT_FOUND"].includes(code))
    return 404;
  if (code === "METHOD_NOT_ALLOWED") return 405;
  if (
    [
      "STATE_CONFLICT",
      "PROPOSAL_CONFLICT",
      "REQUEST_ID_REUSED",
      "VERSION_MISMATCH",
      "CURSOR_MISMATCH",
      "EVENT_HISTORY_GAP",
    ].includes(code)
  )
    return 409;
  if (code === "BODY_TOO_LARGE") return 413;
  if (code === "UNSUPPORTED_MEDIA_TYPE") return 415;
  if (code === "INTERNAL_ERROR") return 500;
  return 400;
}

export async function executeApiCall(agent, action, envelope) {
  try {
    validateArguments(action, envelope.arguments);
    const { arguments: args, base, request_id, purpose } = envelope;
    const result = Object.hasOwn(connectionActions, action)
      ? await agent[connectionActions[action].method](args)
      : await agent.request(action, args, {
          base,
          request_id,
          purpose,
          requireBase: true,
        });
    return { ok: true, result: result ?? null };
  } catch (error) {
    return { ok: false, error: apiError(error) };
  }
}
export async function executeApiBatch(agent, envelope) {
  validateBatch(envelope);
  const results = [];
  for (const { id, action, ...call } of envelope.calls)
    results.push({
      id,
      action,
      ...(await executeApiCall(agent, action, call)),
    });
  return { results };
}
