import { attachEventReads } from "./event-reads.js";
import { randomUUID } from "node:crypto";

// Public mutation boundary. Nested calls belong to the outer operation.
export const eventOperations = Object.freeze([
  "createAccount",
  "addTransaction",
  "allocate",
  "transfer",
  "reconcile",
  "importCsv",
  "categorize",
  "createGroup",
  "createCategory",
  "deleteTransaction",
  "setGoal",
  "removeGoal",
  "createRecurring",
  "postRecurring",
  "toggleRecurring",
]);

export function attachEvents(budget) {
  const db = budget.db;
  const source = db
    .prepare("SELECT source FROM event_identity WHERE singleton=1")
    .get().source;
  const changes = db.prepare("SELECT total_changes() AS n");
  const insert = db.prepare(
    "INSERT INTO budget_events(id,envelope) VALUES (?,?)",
  );
  let depth = 0;
  for (const operation of eventOperations) {
    const original = budget[operation];
    if (typeof original !== "function")
      throw Error("Missing event operation: " + operation);
    budget[operation] = (...args) => {
      if (depth) return original(...args);
      // Lock before state-dependent validation; nested SQLite transactions use savepoints.
      return db
        .transaction(() => {
          depth++;
          try {
            const before = changes.get().n;
            const result = original(...args);
            if (changes.get().n !== before) {
              const id = randomUUID();
              insert.run(
                id,
                JSON.stringify({
                  specversion: "1.0",
                  id,
                  source,
                  type: "io.nemein.budget.changed.v1",
                  time: new Date().toISOString(),
                  datacontenttype: "application/json",
                  dataschema: "urn:nemein:schema:budget-changed:1",
                  data: { operation },
                }),
              );
            }
            return result;
          } finally {
            depth--;
          }
        })
        .immediate();
    };
  }
  return attachEventReads(budget);
}
