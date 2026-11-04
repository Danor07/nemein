import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBudget } from "../src/core.js";
import { sha256 } from "../src/connectors.js";
import { signComponent } from "../src/connector-signature.js";
import { createApp } from "../src/server.js";
import {
  base64,
  component,
  fakeRunner,
  statement,
} from "./helpers/connector-budget.js";

// The owner's connectors screen over HTTP, with the in-process stand-in for
// the worker and fictitious data in a temporary folder.
async function screen(t, { runs = true, runConnector = fakeRunner() } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-connectors-http-"));
  const b = openBudget(dir, { runConnector });
  const app = createApp(b);
  app.locals.connectorsRun = runs;
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const page = async (query = "") => {
    const r = await fetch(base + "/?view=connectors" + query);
    assert.equal(r.status, 200);
    return r.text();
  };
  const csrf =
    (await page()).match(/name="_csrf" value="([^"]+)"/)?.[1] ??
    (await (await fetch(base + "/?view=budget")).text()).match(
      /name="_csrf" value="([^"]+)"/,
    )[1];
  const json = (action, body) =>
    fetch(base + "/action/" + action, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ _csrf: csrf, ...body }),
    });
  const form = (action, body) =>
    fetch(base + "/action/" + action, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: base },
      body: new URLSearchParams({ _csrf: csrf, view: "connectors", ...body }),
    });
  const account = b.createAccount({
    name: "Banco ficticio",
    type: "corriente",
  });
  const category = b.createCategory({
    name: "Varios",
    group_id: b.createGroup({ name: "Ficticio" }),
  });
  return { b, dir, base, page, json, form, account, category };
}
const notice = (response) =>
  new URL(response.headers.get("location"), "http://x").searchParams.get(
    "notice",
  );
const signed = (bytes) =>
  JSON.stringify(
    signComponent(sha256(bytes), generateKeyPairSync("ed25519").privateKey),
  );

test("the screen is in the navigation and says where connectors do not run", async (t) => {
  const s = await screen(t, { runs: false });
  const html = await s.page();
  assert.match(html, /href="\/\?view=connectors[^"]*">.*Conectores/);
  assert.match(html, /data-connectors-unsupported/);
  assert.match(html, /En Linux no corren/);
  // Where they do not run, nothing offers to install or run one.
  assert.doesNotMatch(html, /connector-install-form|connector-prepare-form/);
  assert.match(html, /No hay conectores instalados/);
});

test("the default follows the platform: only Windows runs connectors", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-connectors-http-"));
  const b = openBudget(dir);
  t.after(() => {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(createApp(b).locals.connectorsRun, process.platform === "win32");
});

test("install, signature, enable with acknowledgement, prepare, review and confirm", async (t) => {
  const s = await screen(t);
  let html = await s.page();
  assert.doesNotMatch(html, /data-connectors-unsupported/);
  assert.match(html, /connector-install-form/);
  assert.match(html, /Habilitá un conector para importar con él/);

  // Unsigned: installed disabled, and the screen says so.
  let r = await s.json("connector-install", {
    component_base64: base64(component),
    signature: "",
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    notice:
      "Conector instalado y deshabilitado. No tiene una firma válida: revisalo antes de habilitarlo.",
  });
  const unsigned = sha256(component);
  html = await s.page();
  assert.match(html, /data-signature="absent">Sin firma/);
  assert.match(html, /Entiendo que no tiene una firma válida/);

  // Enabling it needs the explicit acknowledgement.
  r = await s.form("connector-enable", { hash: unsigned });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /no tiene una firma válida/);
  assert.equal(s.b.listConnectors()[0].enabled, false);
  r = await s.form("connector-enable", {
    hash: unsigned,
    acknowledge_unsigned: "yes",
  });
  assert.equal(r.status, 302);
  assert.equal(notice(r), "Conector habilitado.");
  assert.equal(s.b.listConnectors()[0].enabled, true);

  // Signed: valid, and it enables without the acknowledgement. Its body is
  // larger than any other form takes.
  const big = Buffer.alloc(9 * 1024 * 1024, 7);
  r = await s.json("connector-install", {
    component_base64: base64(big),
    signature: signed(big),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    notice: "Conector instalado y deshabilitado. Su firma es válida.",
  });
  html = await s.page();
  assert.match(html, /data-signature="valid">Firma válida/);
  assert.match(html, /clave <code>[0-9a-f]{12}…[0-9a-f]{8}<\/code>/);
  r = await s.form("connector-enable", { hash: sha256(big) });
  assert.equal(notice(r), "Conector habilitado.");
  // Other forms keep their own limit.
  r = await s.json("connector-prepare", {
    hash: sha256(big),
    account_id: String(s.account),
    content_base64: base64(big),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "request entity too large");

  // Prepare: the server stores the batch and answers its id only.
  r = await s.json("connector-prepare", {
    hash: unsigned,
    account_id: String(s.account),
    category_id: String(s.category),
    config: "",
    content_base64: base64(statement),
  });
  assert.equal(r.status, 200);
  const { id, ...rest } = await r.json();
  assert.deepEqual(rest, {});
  assert.equal(s.b.accountTransactions(s.account).length, 0);

  // The review is a page of its own, reloadable, that runs nothing.
  html = await s.page("&batch=" + encodeURIComponent(id));
  assert.match(html, /Revisá antes de importar/);
  assert.match(
    html,
    /5 movimientos para <strong>Banco ficticio<\/strong> · 0 ya importados/,
  );
  assert.equal((html.match(/<td>Nuevo<\/td>/g) ?? []).length, 5);
  assert.match(html, /<td>Varios<\/td>/);
  assert.match(html, /<td>Sin categoría \(ingreso\)<\/td>/);
  const batchHash = html.match(/name="batch_sha256" value="([0-9a-f]{64})"/)[1];
  assert.equal(batchHash, s.b.connectorBatch({ id }).batch_sha256);

  // Confirming imports exactly that batch.
  r = await s.form("connector-import", { id, batch_sha256: batchHash });
  assert.equal(r.status, 302);
  assert.equal(notice(r), "Se importaron 5 movimientos. 0 ya existían.");
  assert.equal(s.b.accountTransactions(s.account).length, 5);
  html = await s.page("&batch=" + encodeURIComponent(id));
  assert.match(html, /Este lote ya se confirmó/);
  assert.match(html, /Se agregaron 5 movimientos y 0 ya existían/);

  // A second batch of the same file shows every row as already imported.
  r = await s.json("connector-prepare", {
    hash: unsigned,
    account_id: String(s.account),
    category_id: String(s.category),
    content_base64: base64(statement),
  });
  html = await s.page("&batch=" + encodeURIComponent((await r.json()).id));
  assert.equal((html.match(/<td>Ya importado<\/td>/g) ?? []).length, 5);
  assert.match(html, /5 ya importados/);

  // Revoking from the screen.
  r = await s.form("connector-revoke", { hash: unsigned });
  assert.equal(notice(r), "Conector revocado: ya no se ejecuta.");
  assert.equal(
    s.b.listConnectors().find((c) => c.hash === unsigned).enabled,
    false,
  );
});

test("refusals reach the screen as messages, never as a broken page", async (t) => {
  const s = await screen(t);
  // No CSRF token, no change.
  let r = await fetch(s.base + "/action/connector-install", {
    method: "POST",
    headers: { Origin: s.base, "Content-Type": "application/json" },
    body: JSON.stringify({ component_base64: base64(component) }),
  });
  assert.equal(r.status, 403);
  assert.equal(s.b.listConnectors().length, 0);
  // Another origin, no change.
  r = await fetch(s.base + "/action/connector-install", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ component_base64: base64(component) }),
  });
  assert.equal(r.status, 403);
  // Bad input answers JSON with the reason.
  for (const body of [
    { component_base64: "%%%" },
    { component_base64: base64(component), signature: "{" },
  ]) {
    r = await s.json("connector-install", body);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /base64|firma/);
  }
  r = await s.json("connector-prepare", {
    hash: "0".repeat(64),
    account_id: String(s.account),
    content_base64: base64(statement),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "El conector no está instalado.");
  // A batch that does not exist or is not the owner's.
  let html = await s.page("&batch=otro");
  assert.match(html, /El lote no existe o no es tuyo/);
  // A damaged inventory.
  await s.json("connector-install", { component_base64: base64(component) });
  writeFileSync(path.join(s.dir, "connectors", "inventory.json"), "{");
  html = await s.page();
  assert.match(html, /El inventario de conectores está dañado/);
});

test("a prepare that the connector refuses leaves nothing to review", async (t) => {
  const run = fakeRunner(async (request) => {
    if (request.op === "parse")
      throw Object.assign(new Error("El extracto no es de este banco."), {
        code: "CONNECTOR_REFUSED",
      });
    return { manifest: (await fakeRunner()(request)).manifest };
  });
  const s = await screen(t, { runConnector: run });
  await s.json("connector-install", { component_base64: base64(component) });
  await s.form("connector-enable", {
    hash: sha256(component),
    acknowledge_unsigned: "yes",
  });
  const r = await s.json("connector-prepare", {
    hash: sha256(component),
    account_id: String(s.account),
    category_id: String(s.category),
    content_base64: base64(statement),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "El extracto no es de este banco.");
  assert.equal(
    s.b.db.prepare("SELECT COUNT(*) n FROM connector_batches").get().n,
    0,
  );
});
