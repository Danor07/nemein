import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { openBudget } from "../../src/core.js";
import { createApp } from "../../src/server.js";

// Shared by every fixture of a test file: once one request hangs, the rest fail at
// once instead of each waiting for its own deadline.
let transportFailure;

export async function apiFixture(t, enabled = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-local-api-"));
  const budget = openBudget(dir);
  const connection = budget.createConnection({ label: "HTTP fixture" });
  const server = createApp(budget, {
    localApi: enabled,
    installationRoots: [],
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    budget.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const port = server.address().port;
  function send(action, body = { arguments: {} }, options = {}) {
    if (transportFailure) return Promise.reject(transportFailure);
    const data = options.raw ?? JSON.stringify(body);
    const headers = options.rawHeaders ?? {
      Host: "127.0.0.1:" + port,
      Authorization: "Bearer " + connection.token,
      "Content-Type": "application/json",
      ...options.headers,
    };
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          method: options.method || "POST",
          path: "/api/v1/" + action,
          headers,
          agent: false,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode,
                headers: res.headers,
                text,
                body: text ? JSON.parse(text) : null,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(2000, () => {
        transportFailure = Error(
          "Local API request did not finish within its test deadline.",
        );
        req.destroy(transportFailure);
      });
      req.end(
        options.method === "GET" || options.method === "HEAD"
          ? undefined
          : data,
      );
    });
  }
  const rule = (action, decision = "allow", conditions = {}) =>
    budget.setRule({
      connection_id: connection.id,
      action,
      decision,
      conditions,
    });
  return { budget, connection, port, send, rule, dir };
}
