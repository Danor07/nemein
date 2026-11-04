// In-process stand-in for the enclosed connector worker, for tests on any
// platform: it answers describe and parse as the worker would, with the
// fictitious bank example. Fictitious data only.
import { readFileSync } from "node:fs";
import { validateRequest } from "../../src/connector-runner.js";

export const example = (name) =>
  readFileSync(
    new URL(
      "../../src-tauri/connector/examples/fictitious-bank-csv/fixtures/" + name,
      import.meta.url,
    ),
    "utf8",
  );
export const manifest = JSON.parse(example("manifest.json"));
export const statement = Buffer.from(example("extracto.csv"));
export const component = Buffer.from("componente ficticio para pruebas");
export const base64 = (bytes) => Buffer.from(bytes).toString("base64");

// The golden batch, for the account the host chose.
export const batchFor = (accountId) => ({
  ...JSON.parse(example("extracto.batch.json")),
  account_id: Number(accountId),
});

// `answer(request)` may return { manifest, batch } or throw; calls are kept.
// Requests are held to the worker's own contract, with runConnector's
// defaults.
export function fakeRunner(answer) {
  const calls = [];
  const run = async (request) => {
    calls.push(request);
    validateRequest({ input: Buffer.alloc(0), config: "", ...request });
    if (answer) return answer(request);
    return request.op === "describe"
      ? { manifest }
      : { manifest, batch: batchFor(request.accountId) };
  };
  run.calls = calls;
  return run;
}

// Installs and enables the component, prepares the statement and confirms it.
export async function importThroughConnector(budget, accountId, extra = {}) {
  const installed = await budget.installConnector({
    component_base64: base64(extra.component ?? component),
  });
  budget.enableConnector({ hash: installed.hash });
  const prepared = await budget.prepareConnectorImport({
    hash: installed.hash,
    account_id: accountId,
    content_base64: base64(statement),
    category_id: extra.category_id,
  });
  return {
    installed,
    prepared,
    result: budget.confirmConnectorImport({
      id: prepared.id,
      batch_sha256: prepared.batch_sha256,
    }),
  };
}
