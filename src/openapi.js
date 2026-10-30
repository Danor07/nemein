import { readFileSync, readdirSync } from "node:fs";
import { actionVersion } from "./actions.js";
import {
  apiActions,
  apiLimits,
  apiVersion,
  sseLimits,
  argumentSchemas,
  envelopeSchema,
  batchSchema,
} from "./local-api-contract.js";

const ref = (name) => ({ $ref: "#/components/schemas/" + name });
export function generateOpenApi() {
  const files = readdirSync(new URL("./contracts/", import.meta.url))
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
  const contracts = Object.fromEntries(
    files.map((file) => [
      file.replace(".schema.json", ""),
      JSON.parse(
        readFileSync(new URL("./contracts/" + file, import.meta.url), "utf8"),
      ),
    ]),
  );
  const ids = Object.fromEntries(
    Object.entries(contracts).map(([name, schema]) => [schema.$id, name]),
  );
  function portable(value, name) {
    if (Array.isArray(value)) return value.map((v) => portable(v, name));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "$id")
        .map(([k, v]) => {
          if (k === "$ref") {
            if (v.startsWith("#"))
              return [k, "#/components/schemas/" + name + v.slice(1)];
            if (ids[v]) return [k, "#/components/schemas/" + ids[v]];
          }
          return [k, portable(v, name)];
        }),
    );
  }
  const schemas = Object.fromEntries(
    Object.entries(contracts).map(([name, schema]) => [
      name,
      portable(schema, name),
    ]),
  );
  schemas.Error = {
    type: "object",
    additionalProperties: false,
    required: ["ok", "error"],
    properties: {
      ok: { const: false },
      error: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message"],
        properties: { code: { type: "string" }, message: { type: "string" } },
      },
    },
  };
  schemas.Pending = {
    type: "object",
    required: ["status", "proposal_id", "request_id", "delivery"],
    properties: {
      status: { const: "pending" },
      proposal_id: { type: "string" },
      request_id: { type: "string" },
      delivery: { const: "delivered" },
    },
  };
  schemas.Envelope = envelopeSchema;
  schemas.Batch = batchSchema;
  const event = schemas["event-stream"].properties.event;
  const cursor = schemas["event-stream"].properties.cursor;
  schemas.EventItem = {
    type: "object",
    required: ["cursor", "event"],
    properties: { cursor, event },
  };
  schemas.EventPage = {
    type: "object",
    required: ["version", "events", "cursor", "hasMore"],
    properties: {
      version: { const: 1 },
      events: { type: "array", maxItems: 1000, items: ref("EventItem") },
      cursor,
      hasMore: { type: "boolean" },
    },
  };
  schemas.EventSnapshot = {
    type: "object",
    required: ["version", "cursor", "snapshot", "goals", "recurring"],
    properties: {
      version: { const: 1 },
      cursor,
      snapshot: { type: "object" },
      goals: { type: "array", items: {} },
      recurring: { type: "array", items: {} },
    },
  };
  const resultContracts = {
    export: "export-result",
    events: "EventPage",
    "event-snapshot": "EventSnapshot",
  };
  const content = (schema) => ({ "application/json": { schema } });
  const success = (result) => ({
    type: "object",
    required: ["ok", "result"],
    properties: { ok: { const: true }, result },
  });
  schemas.CallResult = { oneOf: [success({}), ref("Error")] };
  schemas.BatchResult = {
    type: "object",
    required: ["results"],
    properties: {
      results: {
        type: "array",
        maxItems: apiLimits.calls,
        items: {
          oneOf: [success({}), schemas.Error].map((schema) => ({
            ...schema,
            required: ["id", "action", ...schema.required],
            properties: {
              id: { type: "string" },
              action: { type: "string" },
              ...schema.properties,
            },
          })),
        },
      },
    },
  };
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 405, 409, 413, 415, 500].map((status) => [
      status,
      {
        description: "Error with a stable code; message is for people.",
        content: content(ref("Error")),
      },
    ]),
  );
  const parameters = [
    {
      in: "header",
      name: "Nemein-Connection-Version",
      schema: {
        type: "string",
        pattern: "^[a-zA-Z0-9._-]{1,40}$",
        default: "1",
      },
      description:
        "P1 connection version, independent of API and action versions.",
    },
  ];
  const paths = {};
  for (const [action, spec] of Object.entries(apiActions)) {
    const argsName = action + "Arguments",
      requestName = action + "Request";
    schemas[argsName] = argumentSchemas[action];
    schemas[requestName] = {
      ...envelopeSchema,
      required: spec.write ? ["arguments", "base"] : ["arguments"],
      properties: { ...envelopeSchema.properties, arguments: ref(argsName) },
    };
    const result = resultContracts[action]
      ? { anyOf: [ref(resultContracts[action]), ref("Pending")] }
      : {};
    paths["/api/v1/" + action] = {
      post: {
        operationId: action,
        summary: spec.label,
        parameters,
        "x-nemein-action": action,
        "x-nemein-action-version": actionVersion,
        "x-nemein-write": !!spec.write,
        requestBody: { required: true, content: content(ref(requestName)) },
        responses: {
          200: {
            description:
              "Action result, including a pending proposal. JSON result structures without an existing schema remain open; domain validation still applies.",
            content: content(success(result)),
          },
          ...errors,
        },
      },
    };
  }
  paths["/api/v1/calls"] = {
    post: {
      operationId: "calls",
      summary:
        "Sequential calls to catalog actions; no batch transaction or result references.",
      parameters,
      requestBody: { required: true, content: content(ref("Batch")) },
      responses: {
        200: {
          description:
            "Ordered results; a call failure does not stop later calls.",
          content: content(ref("BatchResult")),
        },
        ...errors,
      },
    },
  };
  paths["/api/v1/openapi.json"] = {
    get: {
      operationId: "openapi",
      summary: "Generated OpenAPI document; authentication required.",
      parameters,
      responses: {
        200: {
          description: "OpenAPI 3.1 document",
          content: content({ type: "object" }),
        },
        ...errors,
      },
    },
  };
  paths["/api/v1/events/stream"] = {
    get: {
      operationId: "eventStream",
      summary: "Continuous protected events, resumed from a P4a cursor.",
      "x-nemein-action": "events",
      "x-nemein-stream-limits": sseLimits,
      parameters: [
        ...parameters,
        {
          in: "header",
          name: "Last-Event-ID",
          required: true,
          schema: cursor,
          description:
            "Snapshot cursor on first connection; last processed event cursor on reconnect. Duplicates are rejected. Never a CloudEvents id.",
        },
      ],
      responses: {
        200: {
          description:
            "UTF-8 SSE. budget-event has id=cursor and JSON data matching event-stream. Heartbeat comments have no id. stream-error carries a sanitized Error without id, then closes. Persist after processing and deduplicate source+id. Slow consumers are disconnected; reconnect from the persisted cursor. Continuous events require allow; permissions are checked throughout.",
          content: {
            "text/event-stream": {
              schema: { type: "string" },
              "x-nemein-record-schema": ref("event-stream"),
            },
          },
        },
        ...errors,
        429: {
          description: "STREAM_LIMIT: too many simultaneous event streams.",
          content: content(ref("Error")),
        },
      },
    },
  };
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Nemein local API",
      version: apiVersion,
      description:
        "Opt-in loopback API. See api-local.md for limits, cursors, retries and deprecation (at least 90 days and two stable releases).",
    },
    servers: [
      {
        url: "http://127.0.0.1:{port}",
        variables: {
          port: {
            default: "3000",
            description: "Actual local UI port; not a fixed service port.",
          },
        },
      },
    ],
    security: [{ connectionToken: [] }],
    "x-nemein-limits": apiLimits,
    paths,
    components: {
      securitySchemes: {
        connectionToken: {
          type: "http",
          scheme: "bearer",
          description: "P1 connection token; never cookies or URL parameters.",
        },
      },
      schemas,
    },
  };
}
