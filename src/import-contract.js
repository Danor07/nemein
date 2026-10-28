import Ajv2020 from "ajv/dist/2020.js";
import schema from "./contracts/import-batch.v1.schema.json" with { type: "json" };
import { date } from "./date.js";

const validate = new Ajv2020({ strict: true }).compile(schema);
const fail = (code, message) => Object.assign(new Error(message), { code });
function importDate(value) {
  try {
    date(value);
  } catch (cause) {
    throw Object.assign(new Error(cause.message, { cause }), {
      code: "IMPORT_INVALID_DATE",
    });
  }
}

// Pure boundary: validation never grants permission or writes to the ledger.
export function validateImportBatch(batch) {
  if (!validate(batch))
    throw fail(
      "IMPORT_INVALID_BATCH",
      "El lote no cumple el contrato de importación v1.",
    );
  if (batch.period !== null) {
    importDate(batch.period.from);
    importDate(batch.period.to);
    if (batch.period.from > batch.period.to)
      throw fail(
        "IMPORT_INVALID_PERIOD",
        "El período de importación está invertido.",
      );
  }
  const ids = new Set();
  for (const entry of batch.entries) {
    importDate(entry.date);
    if (
      batch.period !== null &&
      (entry.date < batch.period.from || entry.date > batch.period.to)
    )
      throw fail(
        "IMPORT_OUTSIDE_PERIOD",
        "Un movimiento está fuera del período declarado.",
      );
    if (ids.has(entry.id))
      throw fail(
        "IMPORT_DUPLICATE_ID",
        "El lote repite un identificador de movimiento.",
      );
    ids.add(entry.id);
  }
  return batch;
}

// CSV has no declared coverage; keep its legacy identities across connector versions.
export function csvImportBatch(accountId, entries) {
  return validateImportBatch({
    version: 1,
    provenance: { source: "csv", connector: "nemein.csv", version: "1" },
    period: null,
    currency: "PYG",
    amount_unit: "integer",
    account_id: accountId,
    entries,
  });
}
