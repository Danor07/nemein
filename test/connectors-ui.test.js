import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// public/connectors.js against a minimal document: what it sends, and what
// it says, for each file and answer. Fictitious bytes only.
const source = readFileSync(
  new URL("../public/connectors.js", import.meta.url),
  "utf8",
);
const file = (bytes, size = bytes.length) => ({
  size,
  arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  text: async () => Buffer.from(bytes).toString("utf8"),
});

function harness({
  answer = { ok: true, body: {} },
  forms = ["install", "prepare"],
} = {}) {
  const element = (extra = {}) => ({ textContent: "", value: "", ...extra });
  const button = { disabled: false };
  const states = [];
  const form = (name) => {
    const fields = {
      hash: element({ value: "a".repeat(64) }),
      account_id: element({ value: "3" }),
      category_id: element({ value: "" }),
      config: element({ value: "perfil" }),
    };
    return {
      dataset: { csrf: "token-" + name },
      listeners: {},
      addEventListener(event, listener) {
        this.listeners[event] = listener;
      },
      querySelector: (selector) =>
        selector === "button"
          ? button
          : fields[/^\[name=(\w+)\]$/.exec(selector)?.[1]],
    };
  };
  const nodes = {
    "#connector-install-status": element(),
    "#connector-prepare-status": element(),
    "#connector-component": element({ files: [] }),
    "#connector-signature": element({ files: [] }),
    "#connector-input": element({ files: [] }),
  };
  for (const name of forms) nodes[`#connector-${name}-form`] = form(name);
  const calls = [];
  const visits = [];
  vm.runInNewContext(source, {
    document: { querySelector: (selector) => nodes[selector] ?? null },
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      states.push(button.disabled);
      if (answer.throws) throw new Error(answer.throws);
      return { ok: answer.ok, json: async () => answer.body };
    },
    location: { assign: (url) => visits.push(url) },
    btoa,
    encodeURIComponent,
  });
  const submit = async (name) => {
    let prevented = false;
    await nodes[`#connector-${name}-form`].listeners.submit({
      preventDefault: () => (prevented = true),
    });
    assert.equal(prevented, true, "the page never posts the form itself");
    assert.equal(button.disabled, false, "the button is usable again");
  };
  return { nodes, calls, visits, submit, states };
}

test("install sends the component as base64 with its signature, then shows the notice", async () => {
  const notice = "Conector instalado y deshabilitado.";
  const h = harness({ answer: { ok: true, body: { notice } } });
  // Bigger than one chunk, to cover the chunked encoding.
  const bytes = Array.from({ length: 20000 }, (_, i) => (i * 7) % 256);
  h.nodes["#connector-component"].files = [file(bytes)];
  h.nodes["#connector-signature"].files = [file([...Buffer.from('{"x":1}')])];
  await h.submit("install");
  assert.equal(h.calls.length, 1);
  const [call] = h.calls;
  assert.equal(call.url, "/action/connector-install");
  assert.equal(call.options.method, "POST");
  // Spread: the object comes from the script's own realm.
  assert.deepEqual(
    { ...call.options.headers },
    {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  );
  assert.deepEqual(call.body, {
    _csrf: "token-install",
    component_base64: Buffer.from(bytes).toString("base64"),
    signature: '{"x":1}',
  });
  assert.deepEqual(h.states, [true], "the button is disabled while it works");
  assert.deepEqual(h.visits, [
    "/?view=connectors&notice=" + encodeURIComponent(notice),
  ]);
});

test("install without a signature sends none; limits stop it before any upload", async () => {
  const h = harness({ answer: { ok: true, body: { notice: "Listo" } } });
  h.nodes["#connector-component"].files = [file([1, 2, 3])];
  await h.submit("install");
  assert.deepEqual(Object.keys(h.calls[0].body), ["_csrf", "component_base64"]);
  assert.equal(h.calls[0].body.component_base64, "AQID");

  const status = h.nodes["#connector-install-status"];
  for (const [component, signature, message] of [
    [undefined, undefined, "Elegí el componente."],
    [
      file([1], 16 * 1024 * 1024 + 1),
      undefined,
      "El componente supera 16 MiB.",
    ],
    [
      file([1], 16 * 1024 * 1024),
      file([1], 4097),
      "El archivo de firma supera 4 KiB: no es una firma de Nemein.",
    ],
  ]) {
    h.nodes["#connector-component"].files = component ? [component] : [];
    h.nodes["#connector-signature"].files = signature ? [signature] : [];
    await h.submit("install");
    assert.equal(status.textContent, message);
  }
  assert.equal(h.calls.length, 1, "nothing invalid was sent");
  // The limits themselves are accepted.
  h.nodes["#connector-component"].files = [file([1], 16 * 1024 * 1024)];
  h.nodes["#connector-signature"].files = [file([1], 4096)];
  await h.submit("install");
  assert.equal(h.calls.length, 2);
});

test("a refusal from the server is shown and nothing navigates", async () => {
  for (const answer of [
    { ok: false, body: { error: "El componente no es base64 válido." } },
    { throws: "Failed to fetch" },
  ]) {
    const h = harness({ answer });
    h.nodes["#connector-component"].files = [file([1])];
    await h.submit("install");
    assert.equal(
      h.nodes["#connector-install-status"].textContent,
      answer.body?.error ?? "Failed to fetch",
    );
    assert.deepEqual(h.visits, []);
  }
});

test("prepare sends the chosen fields and the file, then opens the review", async () => {
  const h = harness({ answer: { ok: true, body: { id: "lote 1/ä" } } });
  h.nodes["#connector-input"].files = [
    file([...Buffer.from("fecha,importe\n")]),
  ];
  await h.submit("prepare");
  assert.equal(h.calls[0].url, "/action/connector-prepare");
  assert.deepEqual(h.calls[0].body, {
    _csrf: "token-prepare",
    hash: "a".repeat(64),
    account_id: "3",
    category_id: "",
    config: "perfil",
    content_base64: Buffer.from("fecha,importe\n").toString("base64"),
  });
  assert.deepEqual(h.visits, [
    "/?view=connectors&batch=" +
      encodeURIComponent("lote 1/ä") +
      "#connector-review",
  ]);
  const status = h.nodes["#connector-prepare-status"];
  for (const [input, message] of [
    [undefined, "Elegí el archivo del banco."],
    [file([1], 5000001), "El archivo supera 5 MB."],
  ]) {
    h.nodes["#connector-input"].files = input ? [input] : [];
    await h.submit("prepare");
    assert.equal(status.textContent, message);
  }
  assert.equal(h.calls.length, 1);
  h.nodes["#connector-input"].files = [file([1], 5000000)];
  await h.submit("prepare");
  assert.equal(h.calls.length, 2);
});

test("without the forms, the script does nothing", () => {
  const h = harness({ forms: [] });
  assert.deepEqual(h.calls, []);
});
