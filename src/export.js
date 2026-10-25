import Ajv2020 from "ajv/dist/2020.js";
import documentSchema from "./contracts/budget-export.schema.json" with { type: "json" };
import resultSchema from "./contracts/export-result.schema.json" with { type: "json" };
const ajv = new Ajv2020({ strict: true });
const validateDocument = ajv.compile(documentSchema);
const validateRows = ajv.compile({
  type: "array",
  items: { $ref: documentSchema.$id + "#/$defs/transaction" },
});
const validateResult = ajv.compile(resultSchema);
const tables = {
  accounts: ["accounts", "id,name,type", "id"],
  groups: ["groups_", "id,name", "id"],
  categories: ["categories", "id,group_id,name", "id"],
  allocations: ["allocations", "month,category_id,amount", "month,category_id"],
  transactions: [
    "transactions",
    "id,account_id,date,payee,amount,category_id,kind,cleared,reconciled,transfer_key",
    "date,id",
  ],
  reconciliations: ["reconciliations", "id,account_id,date,balance", "id"],
  goals: ["goals", "category_id,amount,due_date", "category_id"],
  recurring: [
    "recurring",
    "id,account_id,category_id,payee,amount,next_date,frequency,anchor_day,active",
    "id",
  ],
  recurring_occurrences: [
    "recurring_occurrences",
    "recurring_id,due_date,transaction_id",
    "recurring_id,due_date",
  ],
};
export const maxExportRows = 20000;
export const maxExportBytes = 5000000;
const fail = (code, message) => Object.assign(new Error(message), { code });
function scalar(value) {
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number))
      throw fail(
        "EXPORT_UNSAFE_NUMBER",
        "La exportación contiene un entero que JSON no puede representar exactamente.",
      );
    return number;
  }
  if (value === null || typeof value === "string") return value;
  throw fail(
    "EXPORT_INVALID_VALUE",
    "La exportación contiene un valor fuera del contrato financiero.",
  );
}
const cell = (value) => '"' + String(value ?? "").replaceAll('"', '""') + '"';

// The caller holds one SQLite read snapshot, including its cursor.
export function exportData(db, position, options = {}) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((k) => k !== "format") ||
    (options.format !== undefined && !["json", "csv"].includes(options.format))
  )
    throw fail(
      "INVALID_EXPORT_OPTIONS",
      "Elegí format json o csv, sin otras opciones.",
    );
  const format = options.format ?? "json";
  const data = {};
  let count = 0;
  for (const [name, [table, columns, order]] of Object.entries(tables)) {
    if (format === "csv" && name !== "transactions") continue;
    const rows = db
      .prepare(
        "SELECT " +
          columns +
          " FROM " +
          table +
          " ORDER BY " +
          order +
          " LIMIT ?",
      )
      .safeIntegers()
      .all(maxExportRows - count + 1);
    count += rows.length;
    if (count > maxExportRows)
      throw fail(
        "EXPORT_TOO_LARGE",
        "La exportación supera las 20.000 filas; no se entregó un resultado parcial.",
      );
    data[name] = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, scalar(value)]),
      ),
    );
  }
  const metadata = {
    version: 1,
    source: position.source,
    cursor: position.cursor,
    exported_at: new Date().toISOString(),
    currency: "PYG",
    amount_unit: "integer",
  };
  const document = { ...metadata, data };
  if (
    !(format === "json"
      ? validateDocument(document)
      : validateRows(data.transactions))
  )
    throw fail(
      "EXPORT_INVALID_VALUE",
      "Los datos financieros no cumplen el contrato de exportación.",
    );
  const content =
    format === "json"
      ? JSON.stringify(document, null, 2) + "\n"
      : [
          tables.transactions[1].split(","),
          ...data.transactions.map((row) => Object.values(row)),
        ]
          .map((row) => row.map(cell).join(","))
          .join("\r\n") + "\r\n";
  if (Buffer.byteLength(content, "utf8") > maxExportBytes)
    throw fail(
      "EXPORT_TOO_LARGE",
      "La exportación supera 5 MB; no se entregó un resultado parcial.",
    );
  const result = {
    ...metadata,
    format,
    media_type:
      format === "json"
        ? "application/json"
        : "text/csv;charset=utf-8;header=present",
    filename:
      format === "json"
        ? "nemein-budget-v1.json"
        : "nemein-transactions-v1.csv",
    row_count: count,
    content,
  };
  if (!validateResult(result))
    throw fail(
      "EXPORT_INVALID_VALUE",
      "Los metadatos no cumplen el contrato de exportación.",
    );
  return result;
}
