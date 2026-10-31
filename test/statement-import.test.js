import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { statementImportBatch } from "../src/statement-import.js";
import { validateImportBatch } from "../src/import-contract.js";
import {
  ofx,
  ofxRow,
  camt,
  camtRow,
  sgmlHeader,
} from "./fixtures/statements.js";

const parse = (content, format = "ofx", extra = {}, account = 1) =>
  statementImportBatch(content, { format, ...extra }, account);
const reject = (content, code, format = "ofx", extra) =>
  assert.throws(
    () => parse(content, format, extra),
    typeof code === "string" ? { code } : code,
  );

test("Statement depth and tag limits accept the boundary and reject the next level or character", () => {
  const atDepth = (n) =>
    ofx().replace(
      "<OFX>",
      "<OFX>" + "<Extra>".repeat(n) + "</Extra>".repeat(n),
    );
  assert.equal(parse(atDepth(63)).entries.length, 1);
  reject(atDepth(64), {
    code: "IMPORT_LIMIT",
    message: "Extracto demasiado complejo (profundidad máxima 64).",
  });
  const tag = '<OFX note="' + "x".repeat(4096 - '<OFX note="">'.length) + '">';
  assert.equal(tag.length, 4096);
  assert.equal(parse(ofx().replace("<OFX>", tag)).entries.length, 1);
  reject(ofx().replace("<OFX>", tag.replace('">', 'x">')), {
    code: "IMPORT_LIMIT",
    message: "Etiqueta de extracto demasiado larga.",
  });
});

test("Statement variants keep explicit accounts, memo fallback and currency boundaries", () => {
  const creditCard = ofx()
    .replaceAll("STMTRS", "CCSTMTRS")
    .replaceAll("BANKACCTFROM", "CCACCTFROM");
  assert.equal(parse(creditCard).entries[0].amount, -120);
  assert.equal(
    parse(
      ofx().replace("<NAME>Fixture shop</NAME>", "<MEMO>Fixture memo</MEMO>"),
    ).entries[0].payee,
    "Fixture memo",
  );
  assert.equal(parse(ofx().replaceAll('"', "'")).entries.length, 1);
  assert.equal(parse(camt().replaceAll('"', "'"), "camt053").entries.length, 1);
  assert.equal(
    parse(camt().replace("<Ccy>PYG</Ccy>", ""), "camt053").entries.length,
    1,
  );
  for (const [before, after] of [
    ["DATA:OFXSGML", "DATA:OTHER"],
    ["VERSION:102", "VERSION:202"],
    ["SECURITY:NONE", "SECURITY:TYPE1"],
    ["COMPRESSION:NONE", "COMPRESSION:GZIP"],
  ])
    reject(
      ofx(undefined, { sgml: true }).replace(before, after),
      "IMPORT_INVALID_STATEMENT",
    );
  reject(
    ofx(ofxRow() + ofxRow({ amount: "10", payee: "Different" })),
    "IMPORT_DUPLICATE_ID",
  );
  reject(
    ofx().replace("</STMTTRN>", "<ORIGCURRENCY/></STMTTRN>"),
    "IMPORT_CURRENCY",
  );
  reject(
    ofx().replace("<ACCTID>fixture-account</ACCTID>", ""),
    "IMPORT_INVALID_STATEMENT",
  );
  reject(
    ofx().replace("</BANKTRANLIST>", "</BANKTRANLIST>" + ofxRow()),
    "IMPORT_INVALID_STATEMENT",
  );
  reject(
    ofx().replace("<OFX>", '<OFX xmlns="urn:other">'),
    "IMPORT_INVALID_STATEMENT",
  );
  reject(ofx() + "<", "IMPORT_INVALID_STATEMENT");
  reject(
    ofx().replace("<OFX>", '<OFX><?xml version="1.0"?>'),
    "IMPORT_INVALID_STATEMENT",
  );
  reject(
    camt().replace(
      "</Stmt>",
      "<FrToDt><FrDtTm>2026-10-01</FrDtTm></FrToDt></Stmt>",
    ),
    "IMPORT_INVALID_STATEMENT",
    "camt053",
  );
  reject(camt(camtRow({ date: "" })), "IMPORT_INVALID_STATEMENT", "camt053");
});

test("OFX XML and SGML produce the same v1 identity, exact sign and civil date", () => {
  for (const sgml of [false, true]) {
    const rows =
      ofxRow() +
      ofxRow({
        id: "credit",
        amount: "+20.000",
        date: "20261003010000[14:TEST]",
        payee: "Fixture income",
      });
    const batch = parse(
      ofx(rows, {
        sgml,
        period: "<DTSTART>20261001</DTSTART><DTEND>20261031</DTEND>",
      }),
    );
    assert.equal(validateImportBatch(batch), batch);
    assert.deepEqual(batch.period, { from: "2026-10-01", to: "2026-10-31" });
    assert.deepEqual(
      batch.entries.map(({ date, amount, payee, category_id }) => ({
        date,
        amount,
        payee,
        category_id,
      })),
      [
        {
          date: "2026-10-02",
          amount: -120,
          payee: "Fixture shop",
          category_id: null,
        },
        {
          date: "2026-10-03",
          amount: 20,
          payee: "Fixture income",
          category_id: null,
        },
      ],
    );
    assert.equal(batch.account_id, 1);
    assert.equal(batch.currency, "PYG");
    assert.equal(batch.amount_unit, "integer");
    assert.equal(batch.provenance.connector, "nemein.ofx");
    assert.equal(batch.provenance.version, "1");
    assert.match(batch.provenance.source, /^ofx:[a-f0-9]{64}$/);
    const expected = parse(ofx(rows));
    assert.deepEqual(batch.entries, expected.entries);
  }
  const first = parse(ofx()).entries[0].id;
  assert.equal(
    parse(ofx(ofxRow({ amount: "-99", payee: "Changed" }))).entries[0].id,
    first,
  );
  assert.notEqual(parse(ofx(), "ofx", {}, 2).entries[0].id, first);
  assert.notEqual(
    parse(ofx(undefined, { account: "other-account" })).entries[0].id,
    first,
  );
  reject(ofx(ofxRow() + ofxRow()), "IMPORT_DUPLICATE_ID");
  reject(camt(camtRow() + camtRow()), "IMPORT_DUPLICATE_ID", "camt053");
});

test("CAMT uses each Ntry total, credit/debit, booking dates and reference precedence", () => {
  const rows =
    camtRow() +
    camtRow({
      id: "credit",
      amount: "70",
      sign: "CRDT",
      date: "<DtTm>2026-10-03T00:10:00+14:00</DtTm>",
    });
  const batch = parse(
    camt(rows, {
      period:
        "<FrToDt><FrDtTm>2026-10-01T00:00:00Z</FrDtTm><ToDtTm>2026-10-31T23:59:59Z</ToDtTm></FrToDt>",
    }),
    "camt053",
  );
  assert.deepEqual(
    batch.entries.map((entry) => [entry.amount, entry.date]),
    [
      [-120, "2026-10-02"],
      [70, "2026-10-03"],
    ],
  );
  assert.deepEqual(batch.period, { from: "2026-10-01", to: "2026-10-31" });
  assert.equal(batch.provenance.connector, "nemein.camt053");
  assert.match(batch.provenance.source, /^camt053:[a-f0-9]{64}$/);
  const id = parse(camt(), "camt053").entries[0].id;
  assert.equal(
    parse(camt(camtRow({ ref: "changed" })), "camt053").entries[0].id,
    id,
  );
  const fallback = parse(camt(camtRow({ id: "" })), "camt053").entries[0].id;
  assert.notEqual(fallback, id);
  assert.notEqual(
    parse(camt(camtRow({ id: "", ref: "other" })), "camt053").entries[0].id,
    fallback,
  );
  const prefixed = camt()
    .replace(/<(\/?)([A-Z][\w]*)(?=[\s/>])/g, "<$1c:$2")
    .replace("xmlns=", "xmlns:c=");
  assert.deepEqual(parse(prefixed, "camt053"), parse(camt(), "camt053"));
  assert.equal(parse(camt(""), "camt053").entries.length, 0);
  assert.equal(parse(ofx("")).entries.length, 0);
});

test("Missing external identities reuse the historical CSV occurrence fallback", () => {
  const expected = (n) =>
    createHash("sha256")
      .update(JSON.stringify([1, "2026-10-02", "fixture shop", -120]) + "#" + n)
      .digest("hex");
  for (const [format, content] of [
    ["ofx", ofx(ofxRow({ id: "" }) + ofxRow({ id: "" }))],
    [
      "camt053",
      camt(camtRow({ id: "", ref: "" }) + camtRow({ id: "", ref: "" })),
    ],
  ]) {
    assert.deepEqual(
      parse(content, format).entries.map((row) => row.id),
      [expected(1), expected(2)],
    );
  }
});

test("Declared OFX charsets decode original bytes; Unicode text cannot masquerade as legacy bytes", () => {
  const text = ofx(ofxRow({ payee: "Café €" }), { sgml: true });
  const bytes = Buffer.from(text.replace("€", "\x80"), "latin1");
  assert.equal(parse(bytes).entries[0].payee, "Café €");
  assert.deepEqual(
    parse(bytes.toString("base64"), "ofx", { content_encoding: "base64" }),
    parse(bytes),
  );
  reject(text, "IMPORT_CHARSET");
  assert.equal(
    parse(
      Buffer.from(
        text.replace("€", "X").replace("1252", "ISO-8859-1"),
        "latin1",
      ),
    ).entries[0].payee,
    "Café X",
  );
  assert.equal(
    parse(Buffer.from(text.replace("USASCII", "UTF-8").replace("1252", "NONE")))
      .entries[0].payee,
    "Café €",
  );
  assert.equal(
    parse(ofx(undefined, { sgml: true }).replace("1252", "NONE")).entries
      .length,
    1,
  );
  reject(Buffer.from(text.replace("1252", "NONE"), "latin1"), "IMPORT_CHARSET");
  reject(
    ofx(undefined, { sgml: true }).replace("1252", "9999"),
    "IMPORT_CHARSET",
  );
  reject(
    ofx(undefined, { sgml: true }).replace("USASCII", "UNKNOWN"),
    "IMPORT_CHARSET",
  );
  reject(
    Buffer.concat([Buffer.from(ofx()), Buffer.from([255])]),
    "IMPORT_CHARSET",
  );
  reject(ofx().replace("UTF-8", "UTF-16"), "IMPORT_CHARSET");
  reject("!!!!", "IMPORT_INVALID_STATEMENT", "ofx", {
    content_encoding: "base64",
  });
  reject("YQ=", "IMPORT_INVALID_STATEMENT", "ofx", {
    content_encoding: "base64",
  });
  reject("YR==", "IMPORT_INVALID_STATEMENT", "ofx", {
    content_encoding: "base64",
  });
  reject(ofx(), "IMPORT_INVALID_STATEMENT", "ofx", {
    content_encoding: "utf16",
  });
});

test("Money and row errors reject the whole batch without conversion, rounding or skipping", () => {
  for (const money of [
    "1.01",
    "-1.1",
    "1e2",
    "NaN",
    "1,00",
    "0",
    "1000000000001",
    "9007199254740993",
    "",
    " 1 2 ",
  ]) {
    assert.throws(
      () => parse(ofx(ofxRow() + ofxRow({ id: "bad", amount: money }))),
      /Fila 2:/,
    );
  }
  for (const money of ["-1", "+1", "1.1", "0", "1000000000001"])
    reject(camt(camtRow({ amount: money })), "IMPORT_AMOUNT", "camt053");
  for (const value of ["USD", "pyg", ""])
    reject(ofx(undefined, { currency: value }), "IMPORT_CURRENCY");
  reject(camt(undefined, { currency: "USD" }), "IMPORT_CURRENCY", "camt053");
  reject(camt(camtRow({ currency: "USD" })), "IMPORT_CURRENCY", "camt053");
  reject(
    ofx().replace(
      "</STMTTRN>",
      "<CURRENCY><CURSYM>USD</CURSYM></CURRENCY></STMTTRN>",
    ),
    "IMPORT_CURRENCY",
  );
  reject(ofx(ofxRow({ date: "20260230" })), "IMPORT_INVALID_DATE");
  reject(ofx(ofxRow({ date: "not-a-date" })), "IMPORT_INVALID_DATE");
  reject(ofx(ofxRow({ payee: " " })), "IMPORT_INVALID_STATEMENT");
  reject(ofx(ofxRow({ payee: "x".repeat(161) })), "IMPORT_INVALID_BATCH");
  reject(
    camt(camtRow({ sign: "OTHER" })),
    "IMPORT_INVALID_STATEMENT",
    "camt053",
  );
  reject(
    ofx(undefined, {
      period: "<DTSTART>20261003</DTSTART><DTEND>20261001</DTEND>",
    }),
    "IMPORT_INVALID_PERIOD",
  );
  reject(
    ofx(undefined, {
      period: "<DTSTART>20261003</DTSTART><DTEND>20261031</DTEND>",
    }),
    "IMPORT_OUTSIDE_PERIOD",
  );
});

test("Markup is bounded, structurally complete and rejects declarations, references and ambiguity", () => {
  for (const [format, content] of [
    ["ofx", ofx()],
    ["ofx", ofx(undefined, { sgml: true })],
    ["camt053", camt()],
  ]) {
    for (const payload of [
      "<!DOCTYPE x SYSTEM 'file:///secret'>",
      "<!ENTITY x 'bad'>",
      "<![CDATA[x]]>",
      "<!--x-->",
      "\0",
    ])
      reject(
        content.replace("Fixture shop", payload),
        "IMPORT_UNSAFE_XML",
        format,
      );
    if (!content.startsWith("OFXHEADER"))
      for (const payload of ["&xxe;", "&#65;", "A&B"])
        reject(
          content.replace("Fixture shop", payload),
          "IMPORT_UNSAFE_XML",
          format,
        );
    reject(content.slice(0, -5), "IMPORT_INVALID_STATEMENT", format);
    reject(content + "<extra/>", "IMPORT_INVALID_STATEMENT", format);
    reject(content + "garbage", "IMPORT_INVALID_STATEMENT", format);
  }
  reject("<a>".repeat(65) + "</a>".repeat(65), "IMPORT_LIMIT");
  reject("<a " + " ".repeat(5000) + "/>", "IMPORT_LIMIT");
  for (const content of [
    "",
    "<",
    "<a",
    "<OFX></wrong>",
    "<OFX a=unquoted/>",
    '<OFX a="1" a="2"/>',
    "<p:OFX/>",
    "<a:b:c/>",
    '<OFX><?evil run="x"?></OFX>',
    "<OFX>text<a/></OFX>",
    ofx().replace("</NAME>", "</NAME><NAME>other</NAME>"),
    ofx().replace("<NAME>Fixture shop</NAME>", "<NAME><Nested/></NAME>"),
    ofx(undefined, { period: "<DTSTART>20261001</DTSTART>" }),
  ])
    reject(content, "IMPORT_INVALID_STATEMENT");
  reject(ofx(), "IMPORT_FORMAT", "unknown");
  reject({}, "IMPORT_INVALID_STATEMENT");
  reject(ofx(undefined, { sgml: true }), "IMPORT_INVALID_STATEMENT", "camt053");
  reject(
    camt().replace("camt.053", "camt.052"),
    "IMPORT_INVALID_STATEMENT",
    "camt053",
  );
  reject(
    camt().replace("</Stmt>", "</Stmt><Stmt/>"),
    "IMPORT_INVALID_STATEMENT",
    "camt053",
  );
  reject(
    ofx().replace("</STMTRS>", "</STMTRS><STMTRS/>"),
    "IMPORT_INVALID_STATEMENT",
  );
});

test("CAMT description supports related parties and remittance, and rejects ambiguous dates", () => {
  const description = (inner) =>
    `<NtryDtls><TxDtls>${inner}</TxDtls></NtryDtls>`;
  for (const [inner, expected] of [
    [
      "<RltdPties><Cdtr><Pty><Nm>Fixture creditor</Nm></Pty></Cdtr></RltdPties>",
      "Fixture creditor",
    ],
    [
      "<RltdPties><Cdtr><Nm>Fixture creditor</Nm></Cdtr></RltdPties>",
      "Fixture creditor",
    ],
    ["<AddtlTxInf>Fixture memo</AddtlTxInf>", "Fixture memo"],
    [
      "<RmtInf><Ustrd>Fixture</Ustrd><Ustrd>memo</Ustrd></RmtInf>",
      "Fixture memo",
    ],
  ])
    assert.equal(
      parse(camt(camtRow({ payee: description(inner) })), "camt053").entries[0]
        .payee,
      expected,
    );
  assert.equal(
    parse(
      camt(
        camtRow({
          sign: "CRDT",
          payee: description(
            "<RltdPties><Dbtr><Nm>Fixture debtor</Nm></Dbtr></RltdPties>",
          ),
        }),
      ),
      "camt053",
    ).entries[0].payee,
    "Fixture debtor",
  );
  reject(
    camt(
      camtRow({ date: "<Dt>2026-10-02</Dt><DtTm>2026-10-02T00:00:00Z</DtTm>" }),
    ),
    "IMPORT_INVALID_STATEMENT",
    "camt053",
  );
  reject(camt(camtRow({ payee: "" })), "IMPORT_INVALID_STATEMENT", "camt053");
  const other = camt().replace(
    "<IBAN>FICTIONAL-ACCOUNT</IBAN>",
    "<Othr><Id>fixture-other</Id><Issr>fixture-issuer</Issr></Othr>",
  );
  assert.equal(parse(other, "camt053").entries.length, 1);
});

test("Escaped text, headers without a blank line, PAYEE and entry status follow real exports", () => {
  const payee = (content, format) => parse(content, format).entries[0].payee;
  assert.equal(payee(ofx(ofxRow({ payee: "Perez &amp; Cia" }))), "Perez & Cia");
  assert.equal(
    payee(ofx(ofxRow({ payee: "Perez &amp; Cia" }), { sgml: true })),
    "Perez & Cia",
  );
  assert.equal(
    payee(
      camt(
        camtRow({
          payee:
            "<AddtlNtryInf>a &lt;b&gt; &quot;c&quot; &apos;d&apos;</AddtlNtryInf>",
        }),
      ),
      "camt053",
    ),
    "a <b> \"c\" 'd'",
  );
  assert.equal(payee(ofx(ofxRow({ payee: "&amp;lt;" }))), "&lt;");
  assert.equal(payee(ofx(ofxRow({ payee: "A&B" }), { sgml: true })), "A&B");

  const joined = ofx(undefined, { sgml: true }).replace("\n\n<OFX>", "\n<OFX>");
  assert.equal(parse(joined).entries.length, 1);
  reject(sgmlHeader, "IMPORT_INVALID_STATEMENT");

  const named = "<NAME>Fixture shop</NAME>";
  const aggregate = "<PAYEE><NAME>Aggregated</NAME></PAYEE>";
  assert.equal(payee(ofx(ofxRow().replace(named, aggregate))), "Aggregated");
  assert.equal(
    payee(ofx(ofxRow().replace(named, named + aggregate))),
    "Fixture shop",
  );
  assert.equal(
    payee(ofx(ofxRow().replace(named, "<MEMO>Memo only</MEMO>"))),
    "Memo only",
  );

  assert.equal(
    parse(camt(camtRow({ status: "<Sts>BOOK</Sts>" })), "camt053").entries
      .length,
    1,
  );
  for (const status of [
    "",
    "<Sts/>",
    "<Sts>PDNG</Sts>",
    "<Sts><Cd>INFO</Cd></Sts>",
    "<Sts><Prtry>BOOK</Prtry></Sts>",
  ])
    reject(camt(camtRow({ status })), "IMPORT_INVALID_STATEMENT", "camt053");
});

test("SGML closes every empty known leaf, preserves whitespace and also accepts explicit leaf closures", () => {
  for (const leaf of [
    "FITID",
    "NAME",
    "MEMO",
    "DTSTART",
    "DTEND",
    "DTPOSTED",
    "TRNAMT",
    "CURDEF",
    "TRNTYPE",
    "ACCTID",
    "BANKID",
    "BRANCHID",
    "ACCTTYPE",
    "CODE",
    "SEVERITY",
    "DTSERVER",
    "LANGUAGE",
    "ORG",
    "FID",
    "TRNUID",
    "BALAMT",
    "DTASOF",
  ]) {
    const content = ofx(undefined, { sgml: true }).replace(
      "<OFX>",
      `<OFX><Metadata> \n <${leaf}> \n <Following>kept</Following></Metadata>`,
    );
    assert.equal(parse(content).entries[0].payee, "Fixture shop", leaf);
  }
  const body = ofx().slice(ofx().indexOf("<OFX>"));
  assert.equal(parse(sgmlHeader + body).entries.length, 1);
  assert.equal(
    parse(
      sgmlHeader +
        body.replace(
          "<OFX>",
          "<OFX><Metadata><Unknown>text<Following>kept</Following></Metadata>",
        ),
    ).entries.length,
    1,
  );
});

test("Canonical base64 rejects ignored characters, extra padding and nonzero padding bits around a valid statement", () => {
  const content = ofx().padEnd(Math.ceil(ofx().length / 3) * 3 + 1, " ");
  const encoded = Buffer.from(content).toString("base64");
  assert.ok(encoded.endsWith("IA=="));
  for (const poisoned of [
    "!" + encoded,
    encoded + "!",
    "\n" + encoded,
    encoded + "=",
    encoded.slice(0, -2),
    encoded.slice(0, -3) + "B==",
  ])
    reject(
      poisoned,
      {
        code: "IMPORT_INVALID_STATEMENT",
        message: "Extracto incompleto, ambiguo o no compatible.",
      },
      "ofx",
      { content_encoding: "base64" },
    );
});

test("Header boundaries, ASCII bytes and UTF-8 declarations retain their exact charset semantics", () => {
  for (const encoding of ["UTF-8", "UNICODE"])
    assert.equal(
      parse(
        ofx(ofxRow({ payee: "Café" }), { sgml: true }).replace(
          "USASCII",
          encoding,
        ),
      ).entries[0].payee,
      "Café",
    );
  const ascii = ofx(undefined, { sgml: true }).replace("1252", "NONE");
  assert.equal(parse(Buffer.from(ascii)).entries.length, 1);
  const cases = [
    [
      Buffer.from(ascii.replace("Fixture shop", "Fixture\x7f")),
      "IMPORT_UNSAFE_XML",
      "No se admiten DOCTYPE, entidades propias ni declaraciones XML adicionales.",
    ],
    [
      Buffer.from(ascii.replace("Fixture shop", "Fixture\x80"), "latin1"),
      "IMPORT_CHARSET",
      "El archivo no es US-ASCII.",
    ],
    [
      Buffer.from(
        ofx(ofxRow({ payee: "Fixture\x80" }), { sgml: true }).replace(
          "1252",
          "ISO-8859-1",
        ),
        "latin1",
      ),
      "IMPORT_UNSAFE_XML",
      "No se admiten DOCTYPE, entidades propias ni declaraciones XML adicionales.",
    ],
    [
      ofx(undefined, { sgml: true }).replace("1252", "unknown"),
      "IMPORT_CHARSET",
      "Charset OFX no compatible.",
    ],
    [
      ofx(undefined, { sgml: true }).replace("USASCII", "unknown"),
      "IMPORT_CHARSET",
      "Codificación OFX no compatible.",
    ],
    [
      Buffer.from([255]),
      "IMPORT_CHARSET",
      "Bytes inválidos para el charset declarado.",
    ],
    [
      ofx(ofxRow({ payee: "Café" }), { sgml: true }),
      "IMPORT_CHARSET",
      "Enviá los bytes originales OFX en base64 para respetar su charset.",
    ],
    [
      " \n" +
        ofx().replace(
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<?xml  version="1.0" encoding="UTF-16"?>',
        ),
      "IMPORT_CHARSET",
      "XML requiere UTF-8.",
    ],
    [
      "text" + ofx().replace("UTF-8", "UTF-16"),
      "IMPORT_INVALID_STATEMENT",
      "Extracto incompleto, ambiguo o no compatible.",
    ],
  ];
  for (const [content, code, message] of cases)
    reject(content, { code, message });
  for (const version of ["0102", "1020"])
    reject(
      ofx(undefined, { sgml: true }).replace(
        "VERSION:102",
        "VERSION:" + version,
      ),
      "IMPORT_INVALID_STATEMENT",
    );
  // Text after the header must not override header fields, including without a blank line.
  const injected = ofx(ofxRow({ payee: "Café\nCHARSET:NONE\n" }), {
    sgml: true,
  }).replace("\n\n<OFX>", "\n<OFX>");
  assert.equal(
    parse(Buffer.from(injected, "latin1")).entries[0].payee,
    "Café\nCHARSET:NONE",
  );
  // A declaration past the old 1024-character prefix is still a declaration.
  const longDeclaration = ofx().replace(
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?xml version="1.0"' + " ".repeat(1100) + 'encoding="UTF-16"?>',
  );
  for (const content of [longDeclaration, Buffer.from(longDeclaration)])
    reject(content, { code: "IMPORT_CHARSET", message: "XML requiere UTF-8." });
  reject(Buffer.from("\uFEFF" + ofx().replace("UTF-8", "UTF-16")), {
    code: "IMPORT_CHARSET",
    message: "XML requiere UTF-8.",
  });
});

test("Malformed fields and markup are rejected for their actual structure, not a second unrelated failure", () => {
  const beforeRoot = (attributes) =>
    ofx().replace("<OFX>", `<OFX ${attributes}>`);
  for (const [format, content, rowError = false] of [
    ["ofx", ofx().replace("</OFX>", "</Wrong>")],
    ["ofx", beforeRoot("a=unquoted")],
    ["ofx", beforeRoot('a="first" a="second"')],
    ["ofx", beforeRoot('a="first" unexpected')],
    ["ofx", ofx().replaceAll("OFX>", "a:b:OFX>")],
    ["ofx", ofx().replaceAll("OFX>", "p:OFX>")],
    [
      "ofx",
      ofx().replace(
        "<NAME>Fixture shop</NAME>",
        "<NAME><Nested/>Fixture shop</NAME>",
      ),
      true,
    ],
    [
      "ofx",
      ofx().replace(
        "<NAME>Fixture shop</NAME>",
        "<NAME>Fixture shop<Nested/></NAME>",
      ),
    ],
    ["ofx", ofx().replace("</OFX>", '<Foreign xmlns="urn:other"/></OFX>')],
    [
      "ofx",
      ofx().replace(
        "<NAME>Fixture shop</NAME>",
        '<NAME xmlns="urn:other">Fixture shop</NAME>',
      ),
    ],
    ["camt053", camt().replaceAll("Document", "WrongRoot")],
    ["camt053", camt().replace('xmlns="urn:', 'xmlns="prefix:urn:')],
    ["camt053", camt().replace("camt.053.001.08", "camt.053.001.080")],
    ["camt053", camt().replace("</Stmt>", "<Nested><Stmt/></Nested></Stmt>")],
    [
      "camt053",
      camt().replace("</Stmt>", "<Nested>" + camtRow() + "</Nested></Stmt>"),
    ],
    [
      "camt053",
      camt(camtRow().replace(">120.00</Amt>", "><Nested/>120.00</Amt>")),
      true,
    ],
  ])
    reject(
      content,
      {
        code: "IMPORT_INVALID_STATEMENT",
        message:
          (rowError ? "Fila 1: " : "") +
          "Extracto incompleto, ambiguo o no compatible.",
      },
      format,
    );
  for (const content of [
    ofx().replace("</OFX>", "</OFX \n>"),
    beforeRoot("  a  =  \"first\"   b = 'second'  "),
  ])
    assert.equal(parse(content).entries.length, 1);
  assert.equal(
    parse(ofx().replace('<?OFX OFXHEADER="200"', '<?OFX  OFXHEADER="200"'))
      .entries.length,
    1,
  );
});

test("Every financial producer error preserves its message, row number, code and cause", () => {
  for (const [format, content, code, message] of [
    ["other", ofx(), "IMPORT_FORMAT", "Formato de importación desconocido."],
    [
      "ofx",
      ofx(undefined, { currency: "USD" }),
      "IMPORT_CURRENCY",
      "La moneda del extracto debe ser PYG; no se convierte moneda.",
    ],
    [
      "ofx",
      ofx().replace("</STMTTRN>", "<CURRENCY/></STMTTRN>"),
      "IMPORT_CURRENCY",
      "No se admiten importes en otra moneda.",
    ],
    [
      "ofx",
      ofx(ofxRow({ amount: "1.5" })),
      "IMPORT_AMOUNT",
      "El importe debe representar guaraníes enteros sin pérdida; no se redondea.",
    ],
    [
      "ofx",
      ofx(ofxRow({ amount: "0" })),
      "IMPORT_AMOUNT",
      "Importe cero o fuera del límite de 1 billón.",
    ],
    [
      "ofx",
      ofx(ofxRow({ date: "invalid" })),
      "IMPORT_INVALID_DATE",
      "Fecha de extracto inválida.",
    ],
    [
      "ofx",
      ofx(ofxRow({ date: "20260230" })),
      "IMPORT_INVALID_DATE",
      "Fecha de extracto inválida.",
    ],
    [
      "camt053",
      camt(camtRow({ status: "<Sts><Cd>PDNG</Cd></Sts>" })),
      "IMPORT_INVALID_STATEMENT",
      "Sólo se importan movimientos con estado BOOK.",
    ],
  ]) {
    const rowError =
      ["IMPORT_AMOUNT", "IMPORT_INVALID_DATE"].includes(code) ||
      message.startsWith("Sólo se importan");
    assert.throws(
      () => parse(content, format),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.message, rowError ? "Fila 1: " + message : message);
        if (rowError) {
          assert.equal(error.cause.code, code);
          assert.equal(error.cause.message, message);
        }
        return true;
      },
    );
  }
  assert.equal(
    parse(
      camt(camtRow({ status: "<Sts> \n BOOK \t</Sts>", amount: " 120.00 " })),
      "camt053",
    ).entries[0].amount,
    -120,
  );
  assert.throws(
    () => parse(ofx(ofxRow() + ofxRow({ id: "bad", amount: "0" }))),
    {
      code: "IMPORT_AMOUNT",
      message: "Fila 2: Importe cero o fuera del límite de 1 billón.",
    },
  );
});

test("Date lexical variants keep fractional time and offsets while rejecting prefix, suffix and malformed time", () => {
  for (const [format, valid, invalid] of [
    [
      "ofx",
      [
        "20261002123456.123[-3.50:TEST]",
        "20261002123456[3]",
        "20261002123456.12[3.25]",
        "20261002123456[+3]",
      ],
      [
        "x20261002",
        "20261002x",
        "20261002123456.xyz[-3]",
        "20261002123456[3.x]",
        "20261002123456[3:]",
      ],
    ],
    [
      "camt053",
      [
        "2026-10-02T01:02:03.123Z",
        "2026-10-02T01:02:03.12+03:00",
        "2026-10-02T01:02:03.12",
        "2026-10-02T01:02:03Z",
      ],
      [
        "x2026-10-02",
        "2026-10-02x",
        "2026-10-02T01:02:03.xyzZ",
        "2026-10-02T01:02:03Zx",
      ],
    ],
  ]) {
    const content = (date) =>
      format === "ofx"
        ? ofx(ofxRow({ date }))
        : camt(camtRow({ date: `<DtTm>${date}</DtTm>` }));
    for (const date of valid)
      assert.equal(parse(content(date), format).entries[0].date, "2026-10-02");
    for (const date of invalid)
      reject(
        content(date),
        {
          code: "IMPORT_INVALID_DATE",
          message: "Fila 1: Fecha de extracto inválida.",
        },
        format,
      );
  }
});

test("Source hashes include every declared account component and keep reference identity exact", () => {
  const digest = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const check = (content, format, components) => {
    const batch = parse(content, format);
    const source = digest(components);
    assert.equal(batch.provenance.source, format + ":" + source);
    assert.equal(batch.entries[0].id, digest([format, 1, source, "fixture-1"]));
  };
  for (const [bank, branch, type] of [
    ["fixture-bank", "", "CHECKING"],
    ["other-bank", "branch-a", "SAVINGS"],
  ])
    check(
      ofx()
        .replace("fixture-bank", bank)
        .replace(
          "<ACCTTYPE>CHECKING",
          `<BRANCHID>${branch}</BRANCHID><ACCTTYPE>${type}`,
        ),
      "ofx",
      [bank, branch, "fixture-account", type],
    );
  for (const [identity, components] of [
    ["<IBAN>FICTIONAL-ACCOUNT</IBAN>", ["FICTIONAL-ACCOUNT", ""]],
    [
      "<Othr><Id>other-account</Id><Issr>issuer-a</Issr></Othr>",
      ["other-account", "issuer-a"],
    ],
    ["<Othr><Id>other-account</Id></Othr>", ["other-account", ""]],
    [
      "<IBAN>FICTIONAL-ACCOUNT</IBAN><Othr><Id>ignored-account</Id><Issr>issuer-b</Issr></Othr>",
      ["FICTIONAL-ACCOUNT", "issuer-b"],
    ],
  ])
    check(
      camt().replace("<IBAN>FICTIONAL-ACCOUNT</IBAN>", identity),
      "camt053",
      components,
    );
  for (const identity of [
    "",
    "<Othr/>",
    "<Othr><Issr>issuer-only</Issr></Othr>",
  ])
    reject(
      camt().replace("<IBAN>FICTIONAL-ACCOUNT</IBAN>", identity),
      "IMPORT_INVALID_STATEMENT",
      "camt053",
    );
});

test("CAMT description filters unrelated and foreign remittance fields and rejects nested text leaves", () => {
  const description = (inner) =>
    `<NtryDtls><TxDtls>${inner}</TxDtls></NtryDtls>`;
  const row = (inner) => camt(camtRow({ payee: description(inner) }));
  assert.equal(
    parse(
      row(
        '<RmtInf><Other>ignored</Other><Ustrd xmlns="urn:foreign">ignored too</Ustrd><Ustrd>  fixture  </Ustrd><Ustrd>  memo  </Ustrd></RmtInf>',
      ),
      "camt053",
    ).entries[0].payee,
    "fixture memo",
  );
  assert.equal(
    parse(
      row(
        "<AddtlTxInf>priority</AddtlTxInf><RmtInf><Ustrd>ignored</Ustrd></RmtInf>",
      ),
      "camt053",
    ).entries[0].payee,
    "priority",
  );
  for (const content of [
    camt(camtRow({ payee: "<NtryDtls/>" })),
    row("<RmtInf><Ustrd><Nested/>fixture</Ustrd></RmtInf>"),
    row("<RmtInf><Other>ignored</Other></RmtInf>"),
  ])
    reject(
      content,
      {
        code: "IMPORT_INVALID_STATEMENT",
        message: "Fila 1: Extracto incompleto, ambiguo o no compatible.",
      },
      "camt053",
    );
});

test("CAMT child lookup ignores foreign fields even when they share a required field name", () => {
  const content = camt().replace(
    "<Ccy>PYG</Ccy>",
    '<Ccy>PYG</Ccy><Ccy xmlns="urn:foreign">USD</Ccy>',
  );
  assert.equal(parse(content, "camt053").entries[0].amount, -120);
});
