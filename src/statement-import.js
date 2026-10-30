import { createHash } from "node:crypto";
import { date } from "./date.js";
import { importIdentity, validateImportBatch } from "./import-contract.js";

const fail = (code, message) => Object.assign(new Error(message), { code });
const invalid = () =>
  fail(
    "IMPORT_INVALID_STATEMENT",
    "Extracto incompleto, ambiguo o no compatible.",
  );
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const maxBytes = 5e6;
const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(content, encoding) {
  if (encoding !== undefined && encoding !== "base64") throw invalid();
  if (typeof content !== "string" && !Buffer.isBuffer(content)) throw invalid();
  if (encoding === "base64") {
    if (content.length > 6666668)
      throw fail("IMPORT_LIMIT", "El extracto supera 5 MB.");
    const original = content;
    content = Buffer.from(content, "base64");
    if (content.toString("base64") !== original) throw invalid();
  }
  if (Buffer.byteLength(content) > maxBytes)
    throw fail("IMPORT_LIMIT", "El extracto supera 5 MB.");
  const head = Buffer.isBuffer(content) ? content.toString("utf8") : content;
  const sgml = head.startsWith("OFXHEADER:100");
  let charset = "utf-8";
  if (sgml) {
    const start = head.indexOf("<OFX>");
    if (start < 0) throw invalid();
    const header = head.slice(0, start);
    const fields = Object.fromEntries(
      header.split(/\r?\n/).map((line) => line.split(":")),
    );
    if (
      fields.DATA !== "OFXSGML" ||
      !/^1\d\d$/.test(fields.VERSION) ||
      fields.SECURITY !== "NONE" ||
      fields.COMPRESSION !== "NONE"
    )
      throw invalid();
    if (fields.ENCODING === "USASCII") {
      if (fields.CHARSET === "1252") charset = "windows-1252";
      else if (fields.CHARSET === "ISO-8859-1") charset = "iso-8859-1";
      else if (fields.CHARSET === "NONE") charset = "ascii";
      else throw fail("IMPORT_CHARSET", "Charset OFX no compatible.");
    } else if (!["UTF-8", "UNICODE"].includes(fields.ENCODING))
      throw fail("IMPORT_CHARSET", "Codificación OFX no compatible.");
  } else {
    const declared = /^\s*<\?xml\s[^?]*encoding=["']([^"']+)["']/.exec(
      head,
    )?.[1];
    if (declared && declared.toLowerCase() !== "utf-8")
      throw fail("IMPORT_CHARSET", "XML requiere UTF-8.");
  }
  if (Buffer.isBuffer(content)) {
    if (charset === "ascii" && content.some((byte) => byte > 127))
      throw fail("IMPORT_CHARSET", "El archivo no es US-ASCII.");
    try {
      content =
        charset === "iso-8859-1"
          ? content.toString("latin1")
          : new TextDecoder(charset, { fatal: true }).decode(content);
    } catch {
      throw fail(
        "IMPORT_CHARSET",
        "Bytes inválidos para el charset declarado.",
      );
    }
  } else if (charset !== "utf-8" && /[^\p{ASCII}]/u.test(content)) {
    throw fail(
      "IMPORT_CHARSET",
      "Enviá los bytes originales OFX en base64 para respetar su charset.",
    );
  }
  if (sgml) {
    content = content.slice(content.indexOf("<OFX>"));
  }
  return { content, sgml };
}

// Deliberately restricted markup: no DTD, custom entities, CDATA, comments or external
// resolution. Only the five predefined XML entities decode; SGML has no DTD, so a bare & is text.
// Every loop traverses a finite snapshot, including under mutation; no cursor-driven loops.
function markup(content, sgml) {
  if (
    (!sgml && /&(?!(?:amp|lt|gt|quot|apos);)/.test(content)) ||
    /[^\t\n\r\P{Cc}]/u.test(content) ||
    content.includes("<!")
  )
    throw fail(
      "IMPORT_UNSAFE_XML",
      "No se admiten DOCTYPE, entidades propias ni declaraciones XML adicionales.",
    );
  const root = { children: [], text: "", namespaces: {} };
  const stack = [root],
    nodes = [];
  const leaves = new Set([
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
  ]);
  let consumed = 0;
  for (const match of content.matchAll(/<[^<>]*>|[^<]+/g)) {
    const token = match[0];
    consumed += token.length;
    let parent = stack.at(-1);
    if (!token.startsWith("<")) {
      if (parent === root && token.trim()) throw invalid();
      parent.text += token.replace(
        /&(amp|lt|gt|quot|apos);/g,
        (_, name) => entities[name],
      );
      continue;
    }
    if (token.length > 4096)
      throw fail("IMPORT_LIMIT", "Etiqueta de extracto demasiado larga.");
    if (token.startsWith("<?")) {
      if (nodes.length || !/<\?(?:xml|OFX)\s[^<>?]*\?>/.test(token))
        throw invalid();
      continue;
    }
    const closing = /<\/([A-Za-z_][\w.:-]*)\s*>/.exec(token);
    if (
      sgml &&
      (parent.text.trim() || leaves.has(parent.name)) &&
      closing?.[1] !== parent.qname
    ) {
      stack.pop();
      parent = stack.at(-1);
    }
    if (closing) {
      if (closing[1] !== parent.qname) throw invalid();
      stack.pop();
      continue;
    }
    const opening = /<([A-Za-z_][\w.:-]*)(\s[^<>]*?)?\s*(\/?)>/.exec(token);
    if (!opening || parent.text.trim()) throw invalid();
    const [, qname, raw = "", selfClosing] = opening;
    const attrs = Object.create(null);
    const attributes = [
      ...raw.matchAll(
        /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/g,
      ),
    ];
    if (
      attributes
        .map((match) => match[0])
        .join("")
        .trim() !== raw.trim()
    )
      throw invalid();
    for (const [, key, double, single] of attributes) {
      if (Object.hasOwn(attrs, key)) throw invalid();
      attrs[key] = double ?? single;
    }
    const namespaces = { ...parent.namespaces };
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "xmlns") namespaces[""] = value;
      else if (key.startsWith("xmlns:")) namespaces[key.slice(6)] = value;
    }
    const parts = qname.split(":");
    if (parts.length > 2 || (parts.length === 2 && !namespaces[parts[0]]))
      throw invalid();
    const node = {
      name: parts.at(-1),
      qname,
      attrs,
      namespaces,
      ns: namespaces[parts.length === 2 ? parts[0] : ""] || "",
      children: [],
      text: "",
    };
    parent.children.push(node);
    nodes.push(node);
    if (nodes.length > 250000 || stack.length > 64)
      throw fail(
        "IMPORT_LIMIT",
        "Extracto demasiado complejo (profundidad máxima 64).",
      );
    if (!selfClosing) stack.push(node);
  }
  if (
    consumed !== content.length ||
    stack.length !== 1 ||
    root.children.length !== 1
  )
    throw invalid();
  return { root: root.children[0], nodes };
}

function child(node, name) {
  const found = node.children.filter(
    (item) => item.name === name && item.ns === node.ns,
  );
  if (found.length > 1) throw invalid();
  return found[0];
}
function value(node, name) {
  const item = child(node, name);
  if (!item) return "";
  if (item.children.length) throw invalid();
  return item.text.trim();
}
function required(value) {
  if (!value) throw invalid();
  return value;
}
function currency(value) {
  if (value !== "PYG")
    throw fail(
      "IMPORT_CURRENCY",
      "La moneda del extracto debe ser PYG; no se convierte moneda.",
    );
}
function amount(value, unsigned = false) {
  if (!(unsigned ? /^\d+(?:\.0+)?$/ : /^[+-]?\d+(?:\.0+)?$/).test(value))
    throw fail(
      "IMPORT_AMOUNT",
      "El importe debe representar guaraníes enteros sin pérdida; no se redondea.",
    );
  const result = Number(value);
  if (result === 0 || Math.abs(result) > 1e12)
    throw fail("IMPORT_AMOUNT", "Importe cero o fuera del límite de 1 billón.");
  return result;
}
function statementDate(value, ofx = false) {
  const pattern = ofx
    ? /^(\d{4})(\d{2})(\d{2})(?:\d{6}(?:\.\d+)?(?:\[[+-]?\d+(?:\.\d+)?(?::[^\]]+)?\])?)?$/
    : /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
  const match = pattern.exec(value);
  if (!match) throw fail("IMPORT_INVALID_DATE", "Fecha de extracto inválida.");
  const day = ofx ? `${match[1]}-${match[2]}-${match[3]}` : match[1];
  try {
    return date(day);
  } catch {
    throw fail("IMPORT_INVALID_DATE", "Fecha de extracto inválida.");
  }
}
function ofx(tree) {
  if (tree.root.name !== "OFX" || tree.nodes.some((node) => node.ns))
    throw invalid();
  const statements = tree.nodes.filter((node) =>
    ["STMTRS", "CCSTMTRS"].includes(node.name),
  );
  if (statements.length !== 1) throw invalid();
  const statement = statements[0];
  currency(value(statement, "CURDEF"));
  // Currency overrides would change the meaning of TRNAMT; do not guess conversion.
  if (
    tree.nodes.some((node) => ["CURRENCY", "ORIGCURRENCY"].includes(node.name))
  )
    throw fail("IMPORT_CURRENCY", "No se admiten importes en otra moneda.");
  const account = required(
    child(
      statement,
      statement.name === "STMTRS" ? "BANKACCTFROM" : "CCACCTFROM",
    ),
  );
  const source = hash([
    value(account, "BANKID"),
    value(account, "BRANCHID"),
    required(value(account, "ACCTID")),
    value(account, "ACCTTYPE"),
  ]);
  const list = required(child(statement, "BANKTRANLIST"));
  const rows = list.children.filter((node) => node.name === "STMTTRN");
  if (
    rows.length !== tree.nodes.filter((node) => node.name === "STMTTRN").length
  )
    throw invalid();
  const from = value(list, "DTSTART"),
    to = value(list, "DTEND");
  if (!!from !== !!to) throw invalid();
  return {
    source,
    period: from
      ? { from: statementDate(from, true), to: statementDate(to, true) }
      : null,
    rows,
    entry: (row) => ({
      external: value(row, "FITID"),
      date: statementDate(required(value(row, "DTPOSTED")), true),
      payee: required(
        value(row, "NAME") ||
          (child(row, "PAYEE") && value(child(row, "PAYEE"), "NAME")) ||
          value(row, "MEMO"),
      ),
      amount: amount(required(value(row, "TRNAMT"))),
    }),
  };
}

function camt(tree) {
  if (
    tree.root.name !== "Document" ||
    !/^urn:iso:std:iso:20022:tech:xsd:camt\.053\.001\.\d{2}$/.test(tree.root.ns)
  )
    throw invalid();
  const message = required(child(tree.root, "BkToCstmrStmt"));
  const statement = required(child(message, "Stmt"));
  if (tree.nodes.some((node) => node.name === "Stmt" && node !== statement))
    throw invalid();
  const account = required(child(statement, "Acct"));
  const ccy = value(account, "Ccy");
  if (ccy) currency(ccy);
  const id = required(child(account, "Id"));
  const other = child(id, "Othr");
  const source = hash([
    value(id, "IBAN") || required(other && value(other, "Id")),
    other ? value(other, "Issr") : "",
  ]);
  const rows = statement.children.filter(
    (node) => node.name === "Ntry" && node.ns === statement.ns,
  );
  if (rows.length !== tree.nodes.filter((node) => node.name === "Ntry").length)
    throw invalid();
  const period = child(statement, "FrToDt");
  return {
    source,
    period: period
      ? {
          from: statementDate(required(value(period, "FrDtTm"))),
          to: statementDate(required(value(period, "ToDtTm"))),
        }
      : null,
    rows,
    // One ledger movement per Ntry, including bank-batched entries; never split totals.
    entry: (row) => {
      // Only BOOK is settled; a pending entry must not enter the ledger as a fact.
      const status = required(child(row, "Sts"));
      if ((value(status, "Cd") || status.text.trim()) !== "BOOK")
        throw fail(
          "IMPORT_INVALID_STATEMENT",
          "Sólo se importan movimientos con estado BOOK.",
        );
      const amt = required(child(row, "Amt"));
      currency(amt.attrs.Ccy);
      if (amt.children.length) throw invalid();
      const indicator = value(row, "CdtDbtInd");
      if (!["CRDT", "DBIT"].includes(indicator)) throw invalid();
      const booking = required(child(row, "BookgDt"));
      const dt = value(booking, "Dt"),
        dtm = value(booking, "DtTm");
      if (!!dt === !!dtm) throw invalid();
      return {
        external: value(row, "AcctSvcrRef") || value(row, "NtryRef"),
        date: statementDate(dt || dtm),
        payee: required(camtPayee(row, indicator)),
        amount: amount(amt.text.trim(), true) * (indicator === "DBIT" ? -1 : 1),
      };
    },
  };
}

function camtPayee(row, indicator) {
  const info = value(row, "AddtlNtryInf");
  if (info) return info;
  const details = child(row, "NtryDtls");
  const tx = details && child(details, "TxDtls");
  if (!tx) return "";
  const parties = child(tx, "RltdPties");
  const party =
    parties && child(parties, indicator === "DBIT" ? "Cdtr" : "Dbtr");
  const named = party && (child(party, "Pty") || party);
  if (named && value(named, "Nm")) return value(named, "Nm");
  const remittance = child(tx, "RmtInf");
  return (
    value(tx, "AddtlTxInf") ||
    (remittance &&
      remittance.children
        .filter((node) => node.name === "Ustrd" && node.ns === tx.ns)
        .map((node) => {
          if (node.children.length) throw invalid();
          return node.text.trim();
        })
        .join(" "))
  );
}

// Pure producer. The host alone resolves categories, duplicates, permissions and writes.
export function statementImportBatch(content, config, accountId) {
  if (!["ofx", "camt053"].includes(config.format))
    throw fail("IMPORT_FORMAT", "Formato de importación desconocido.");
  const decoded = decode(content, config.content_encoding);
  const tree = markup(decoded.content, decoded.sgml);
  const parsed = config.format === "ofx" ? ofx(tree) : camt(tree);
  if (parsed.rows.length > 20000)
    throw fail("IMPORT_LIMIT", "Máximo 20.000 filas por importación.");
  const occurrences = new Map();
  const entries = parsed.rows.map((row, index) => {
    try {
      const { external, ...entry } = parsed.entry(row);
      const id = external
        ? hash([config.format, accountId, parsed.source, external])
        : importIdentity(
            accountId,
            entry.date,
            entry.payee,
            entry.amount,
            occurrences,
          );
      return { ...entry, category_id: null, id };
    } catch (cause) {
      throw Object.assign(
        new Error(`Fila ${index + 1}: ${cause.message}`, { cause }),
        { code: cause.code },
      );
    }
  });
  return validateImportBatch({
    version: 1,
    provenance: {
      source: `${config.format}:${parsed.source}`,
      connector: `nemein.${config.format}`,
      version: "1",
    },
    period: parsed.period,
    currency: "PYG",
    amount_unit: "integer",
    account_id: accountId,
    entries,
  });
}
