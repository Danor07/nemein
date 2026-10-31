import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { statementImportBatch } from "../src/statement-import.js";
import { ofx, ofxRow, camt } from "./fixtures/statements.js";

function harness() {
  const element = (value = "") => ({
    value,
    dataset: {},
    disabled: false,
    style: {},
    listeners: {},
    options: [],
    addEventListener(event, listener) {
      this.listeners[event] = listener;
    },
    replaceChildren(...options) {
      this.options = options;
    },
    add(option) {
      this.options.push(option);
    },
  });
  const file = element(),
    format = element("csv"),
    button = element();
  file.files = [];
  const columns = [element(), element(), element()];
  const labels = [...columns, element(), element(), element()].map(
    (select) => ({ style: {}, querySelector: () => select }),
  );
  const selectors = {
    "#csv-file": file,
    "#import-format": format,
    "#csv-delimiter": element(","),
    "#csv-content": element(),
    "#csv-message": element(),
    "#csv-form button": button,
    "#import-content-encoding": element(),
  };
  const document = {
    querySelector: (selector) => selectors[selector] || null,
    querySelectorAll: (selector) =>
      selector === "[data-csv-column]"
        ? columns
        : selector === "[data-csv-option]"
          ? labels
          : [],
  };
  vm.runInNewContext(
    readFileSync(new URL("../public/app.js", import.meta.url), "utf8"),
    {
      document,
      TextDecoder,
      Uint8Array,
      btoa,
      Option: class {
        constructor(text, value) {
          this.text = text;
          this.value = value;
        }
      },
    },
  );
  const selectFile = (bytes) => {
    file.files = [
      {
        size: bytes.length,
        arrayBuffer: async () =>
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
      },
    ];
    return file.listeners.change();
  };
  return { file, format, button, columns, labels, selectors, selectFile };
}

test("UI file listeners preserve original OFX bytes and switch between standard formats and CSV columns", async () => {
  const h = harness();
  h.format.value = "ofx";
  const original = Buffer.from(
    ofx(ofxRow({ payee: "Café" }), { sgml: true }),
    "latin1",
  );
  await h.selectFile(original);
  assert.equal(h.selectors["#csv-content"].value, original.toString("base64"));
  assert.equal(h.selectors["#import-content-encoding"].value, "base64");
  assert.ok(h.columns.every((column) => column.disabled));
  assert.ok(h.labels.every((label) => label.style.display === "none"));
  const batch = statementImportBatch(
    h.selectors["#csv-content"].value,
    { format: "ofx", content_encoding: "base64" },
    1,
  );
  assert.equal(batch.entries[0].payee, "Café");
  h.format.value = "camt053";
  await h.selectFile(Buffer.from(camt()));
  assert.equal(
    statementImportBatch(
      h.selectors["#csv-content"].value,
      { format: "camt053", content_encoding: "base64" },
      1,
    ).entries.length,
    1,
  );
  h.format.value = "csv";
  await h.selectFile(Buffer.from("date,payee,amount\n2026-10-02,Café,-1"));
  assert.equal(h.selectors["#import-content-encoding"].value, "");
  assert.equal(
    h.selectors["#csv-content"].value,
    "date,payee,amount\n2026-10-02,Café,-1",
  );
  assert.ok(h.columns.every((column) => !column.disabled));
  assert.ok(h.labels.every((label) => label.style.display === ""));
  assert.deepEqual(
    Array.from(h.columns[0].options, (option) => option.value),
    ["", "date", "payee", "amount"],
  );
  assert.equal(h.button.disabled, false);
});

test("UI reader clears stale content after errors, limits and concurrent file selection", async () => {
  const h = harness();
  h.format.value = "ofx";
  await h.selectFile(Buffer.from(ofx()));
  h.file.files = [{ size: 5000001 }];
  await h.file.listeners.change();
  assert.equal(h.selectors["#csv-content"].value, "");
  assert.match(h.selectors["#csv-message"].textContent, /supera 5 MB/);
  assert.equal(h.button.disabled, false);
  h.file.files = [
    {
      size: 10,
      arrayBuffer: async () => {
        throw Error("fixture read failure");
      },
    },
  ];
  await h.file.listeners.change();
  assert.match(h.selectors["#csv-message"].textContent, /No se pudo leer/);
  assert.equal(h.button.disabled, false);
  let finish;
  h.file.files = [
    {
      size: 10,
      arrayBuffer: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  ];
  const pending = h.file.listeners.change();
  assert.equal(h.button.disabled, true);
  const latest = Buffer.from(camt());
  h.format.value = "camt053";
  await h.selectFile(latest);
  finish(new ArrayBuffer(1));
  await pending;
  assert.equal(h.selectors["#csv-content"].value, latest.toString("base64"));
  assert.equal(h.button.disabled, false);
  h.file.files = [];
  await h.format.listeners.change();
  assert.equal(h.selectors["#csv-content"].value, "");
});
