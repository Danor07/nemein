import express from "express";
import {
  apiActions,
  apiLimits,
  apiFailure,
  apiError,
  checkApiHeaders,
  errorStatus,
  validateEnvelope,
  executeApiCall,
  executeApiBatch,
} from "./local-api-contract.js";
import { generateOpenApi } from "./openapi.js";
import { createEventStreams } from "./local-api-sse.js";

export function createLocalApi(budget, { enabled = false } = {}) {
  const router = express.Router({ caseSensitive: true, strict: true });
  const document = generateOpenApi();
  const streams = createEventStreams();
  router.closeStreams = streams.close;
  router.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    try {
      if (!enabled)
        throw apiFailure("API_DISABLED", "The local API is disabled.");
      const { token, version } = checkApiHeaders(req);
      res.locals.agent = budget.forAgent(token, version);
      next();
    } catch (error) {
      next(error);
    }
  });
  router.all("/openapi.json", (req, res, next) => {
    if (req.method !== "GET")
      return next(apiFailure("METHOD_NOT_ALLOWED", "Use GET."));
    res.json(document);
  });
  router.all("/events/stream", (req, res, next) => {
    if (req.method !== "GET")
      return next(apiFailure("METHOD_NOT_ALLOWED", "Use GET."));
    streams.open(res.locals.agent, req.headers["last-event-id"], res);
  });
  router.use((req, _res, next) => {
    if (req.method !== "POST")
      return next(apiFailure("METHOD_NOT_ALLOWED", "Use POST."));
    if (
      !req.is("application/json") ||
      (req.headers["content-encoding"] !== undefined &&
        req.headers["content-encoding"] !== "identity")
    )
      return next(
        apiFailure(
          "UNSUPPORTED_MEDIA_TYPE",
          "Use uncompressed application/json in UTF-8.",
        ),
      );
    next();
  });
  router.use(express.json({ limit: apiLimits.bodyBytes, inflate: false }));
  router.post("/calls", async (req, res) => {
    res.json(await executeApiBatch(res.locals.agent, req.body));
  });
  for (const action of Object.keys(apiActions))
    router.post("/" + action, async (req, res) => {
      validateEnvelope(req.body);
      const response = await executeApiCall(res.locals.agent, action, req.body);
      res
        .status(response.ok ? 200 : errorStatus(response.error.code))
        .json(response);
    });
  router.use((_req, _res, next) =>
    next(apiFailure("NOT_FOUND", "Unknown API route.")),
  );
  router.use((error, _req, res, _next) => {
    let failure = error;
    if (error.type === "entity.too.large")
      failure = apiFailure(
        "BODY_TOO_LARGE",
        "Request body exceeds the byte limit.",
      );
    else if (error.type === "entity.parse.failed")
      failure = apiFailure("INVALID_JSON", "Malformed JSON body.");
    else if (error.status === 415)
      failure = apiFailure(
        "UNSUPPORTED_MEDIA_TYPE",
        "Use uncompressed application/json in UTF-8.",
      );
    const value = apiError(failure);
    if (value.code === "AUTH_REQUIRED") res.set("WWW-Authenticate", "Bearer");
    res.status(errorStatus(value.code)).json({ ok: false, error: value });
  });
  return router;
}
