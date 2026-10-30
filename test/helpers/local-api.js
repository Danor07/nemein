import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { openBudget } from "../../src/core.js";
import { createApp } from "../../src/server.js";

// Shared by every fixture of a test file: once one request hangs, the rest fail at
// once instead of each waiting for its own deadline.
let transportFailure;

export function apiDeadline(promise, cancel = () => {}, ms = 2000) {
  if (transportFailure) {
    cancel();
    return Promise.reject(transportFailure);
  }
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      transportFailure = Error(
        "Local API stream exceeded its shared test deadline.",
      );
      cancel();
      reject(transportFailure);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function openApiStream(port, token, after, options = {}) {
  let req;
  return apiDeadline(
    new Promise((resolve, reject) => {
      req = request(
        {
          hostname: "127.0.0.1",
          port,
          method: "GET",
          path: "/api/v1/events/stream",
          agent: false,
          headers: {
            Authorization: "Bearer " + token,
            "Last-Event-ID": after,
            ...options.headers,
          },
        },
        (res) => {
          const updates = new EventEmitter();
          const frames = [];
          let pending = "",
            text = "",
            ended = false;
          const finished = new Promise((done) =>
            res.once("close", () => {
              ended = true;
              updates.emit("update");
              done();
            }),
          );
          res.setEncoding("utf8");
          res.on("error", () => {});
          res.on("data", (chunk) => {
            text += chunk;
            pending += chunk;
            let boundary;
            while ((boundary = pending.indexOf("\n\n")) >= 0) {
              const raw = pending.slice(0, boundary);
              pending = pending.slice(boundary + 2);
              const fields = Object.fromEntries(
                raw.split("\n").map((line) => {
                  const colon = line.indexOf(":");
                  return [
                    line.slice(0, colon),
                    line.slice(colon + 1).trimStart(),
                  ];
                }),
              );
              frames.push({
                raw,
                ...fields,
                ...(fields.data ? { data: JSON.parse(fields.data) } : {}),
              });
            }
            updates.emit("update");
          });
          const close = () => {
            res.destroy();
            req.destroy();
          };
          const waitFor = (check) =>
            apiDeadline(
              new Promise((done, fail) => {
                const update = () => {
                  if (check(frames)) {
                    updates.off("update", update);
                    done(frames);
                  } else if (ended) {
                    updates.off("update", update);
                    fail(Error("SSE ended before the expected frame: " + text));
                  }
                };
                updates.on("update", update);
                update();
              }),
              close,
            );
          resolve({
            status: res.statusCode,
            headers: res.headers,
            frames,
            waitFor,
            finished,
            close,
            get text() {
              return text;
            },
          });
        },
      );
      req.on("error", reject);
      req.end();
    }),
    () => req?.destroy(),
  );
}

export async function apiFixture(t, enabled = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-local-api-"));
  const budget = openBudget(dir);
  const connection = budget.createConnection({ label: "HTTP fixture" });
  const app = createApp(budget, {
    ...(enabled === null ? {} : { localApi: enabled }),
    installationRoots: [],
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    // A failed shutdown must not leave the listener keeping the test process alive.
    try {
      app.locals.closeLocalApi();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      budget.close();
      rmSync(dir, { recursive: true, force: true });
    }
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
  const stream = (after, options) =>
    openApiStream(port, connection.token, after, options);
  return { budget, connection, port, send, rule, dir, app, server, stream };
}
