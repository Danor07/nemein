import { exportData } from "./export.js";
import { AsyncLocalStorage } from "node:async_hooks";
export const reviewedReadContext = new AsyncLocalStorage();
import { Buffer } from "node:buffer";

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
function encode(position) {
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}
export function decodeCursor(token) {
  try {
    if (
      typeof token !== "string" ||
      token.length > 1024 ||
      !/^[A-Za-z0-9_-]+$/.test(token)
    )
      throw Error();
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) throw Error();
    const p = JSON.parse(bytes.toString("utf8"));
    if (
      !p ||
      Object.keys(p).sort().join(",") !== "id,sequence,source,version" ||
      p.version !== 1 ||
      typeof p.source !== "string" ||
      !Number.isSafeInteger(p.sequence) ||
      p.sequence < 0 ||
      (p.sequence === 0 ? p.id !== null : typeof p.id !== "string" || !p.id)
    )
      throw Error();
    return p;
  } catch {
    throw failure(
      "INVALID_CURSOR",
      "Cursor inválido. Obtené un nuevo snapshot de eventos.",
    );
  }
}

export function attachEventReads(budget) {
  const db = budget.db;
  const identity = db.prepare(
    "SELECT source FROM event_identity WHERE singleton=1",
  );
  const latest = db.prepare(
    "SELECT sequence,id FROM budget_events ORDER BY sequence DESC LIMIT 1",
  );
  const highWater = db.prepare(
    "SELECT seq FROM sqlite_sequence WHERE name='budget_events'",
  );
  const anchor = db.prepare("SELECT id FROM budget_events WHERE sequence=?");
  const page = db.prepare(
    "SELECT sequence,id,envelope FROM budget_events WHERE sequence>? ORDER BY sequence LIMIT ?",
  );
  const gap = () =>
    failure(
      "EVENT_HISTORY_GAP",
      "El historial de eventos está incompleto. Obtené un nuevo snapshot después de recuperar la base.",
    );

  function head() {
    const source = identity.get().source;
    const last = latest.get() || { sequence: 0, id: null };
    if (last.sequence !== (highWater.get()?.seq || 0)) throw gap();
    return { version: 1, source, ...last };
  }
  function readTransaction(fn) {
    // A cursor must never describe uncommitted writes owned by a caller.
    if (db.inTransaction && reviewedReadContext.getStore() === true)
      return fn();
    if (db.inTransaction)
      throw failure(
        "EVENT_READ_IN_TRANSACTION",
        "Leé eventos fuera de una transacción de escritura.",
      );
    return db.transaction(fn).deferred();
  }

  budget.eventSnapshot = (p = {}) =>
    readTransaction(() => {
      const position = head(); // First read pins the SQLite snapshot, including the cursor.
      const snapshot = budget.snapshot(p.month);
      return {
        version: 1,
        cursor: encode(position),
        snapshot,
        goals: budget.listGoals(snapshot.month),
        recurring: budget.listRecurring(),
      };
    });

  budget.exportData = (options) =>
    readTransaction(() => {
      const position = head();
      return exportData(
        db,
        { source: position.source, cursor: encode(position) },
        options,
      );
    });

  budget.readEvents = ({ after, limit = 100 } = {}) => {
    const position = decodeCursor(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw failure(
        "INVALID_EVENT_LIMIT",
        "El límite debe ser un entero entre 1 y 1000.",
      );
    return readTransaction(() => {
      const current = head();
      if (
        position.source !== current.source ||
        position.sequence > current.sequence ||
        (position.sequence > 0 &&
          anchor.get(position.sequence)?.id !== position.id)
      )
        throw failure(
          "CURSOR_MISMATCH",
          "El cursor no corresponde a esta historia del presupuesto. Obtené un nuevo snapshot.",
        );
      const rows = page.all(position.sequence, limit + 1);
      let expected = position.sequence + 1;
      for (const row of rows) {
        if (row.sequence !== expected++) throw gap();
      }
      const hasMore = rows.length > limit;
      const events = rows.slice(0, limit).map((row) => ({
        cursor: encode({
          version: 1,
          source: current.source,
          sequence: row.sequence,
          id: row.id,
        }),
        event: JSON.parse(row.envelope),
      }));
      return {
        version: 1,
        events,
        cursor: events.at(-1)?.cursor || after,
        hasMore,
      };
    });
  };
  return budget;
}
