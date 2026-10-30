import test from "node:test";
import assert from "node:assert/strict";
import { statementImportBatch } from "../src/statement-import.js";
import { ofx, ofxRow } from "./fixtures/statements.js";

// Runs last in the mutation scope: these inputs are large, and nearly every mutant dies earlier.
const parse = (content, format = "ofx", extra = {}, account = 1) =>
  statementImportBatch(content, { format, ...extra }, account);
const reject = (content, code, format = "ofx", extra) =>
  assert.throws(
    () => parse(content, format, extra),
    typeof code === "string" ? { code } : code,
  );

test("Statement limits accept the exact boundary and reject the next byte, element or row", () => {
  // At the limit the size check passes and the content fails on its first token.
  const exactBytes = "x".repeat(5000000);
  reject(exactBytes, "IMPORT_INVALID_STATEMENT");
  reject(
    Buffer.from(exactBytes).toString("base64"),
    "IMPORT_INVALID_STATEMENT",
    "ofx",
    { content_encoding: "base64" },
  );
  reject(exactBytes + "x", {
    code: "IMPORT_LIMIT",
    message: "El extracto supera 5 MB.",
  });
  reject(ofx().padEnd(3000000, "é"), "IMPORT_LIMIT");
  const plain = ofx();
  const elements = plain.match(/<[A-Za-z]/g).length;
  const exactNodes = plain.replace(
    "</OFX>",
    "<Extra/>".repeat(250000 - elements) + "</OFX>",
  );
  assert.equal(parse(exactNodes).entries.length, 1);
  reject(exactNodes.replace("</OFX>", "<Extra/></OFX>"), "IMPORT_LIMIT");
  const entries = Array.from({ length: 20000 }, (_, i) =>
    ofxRow({ id: String(i), amount: "1", date: "20261002", payee: "Fixture" }),
  );
  assert.equal(parse(ofx(entries.join(""))).entries.length, 20000);
  reject(ofx(entries.join("") + entries[0]), {
    code: "IMPORT_LIMIT",
    message: "Máximo 20.000 filas por importación.",
  });
  reject("x".repeat(5000001), "IMPORT_LIMIT");
  reject(
    "!".repeat(6666672),
    { code: "IMPORT_LIMIT", message: "El extracto supera 5 MB." },
    "ofx",
    {
      content_encoding: "base64",
    },
  );
  reject(Buffer.alloc(5000001), "IMPORT_LIMIT");
  reject("<a>" + "<b/>".repeat(250000) + "</a>", "IMPORT_LIMIT");
  reject(ofx(ofxRow().repeat(20001)), "IMPORT_LIMIT");
});
