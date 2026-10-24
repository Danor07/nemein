// Journal-mode lock upgrades can return BUSY without honoring busy_timeout.
export function enableWal(db) {
  const timeout = db.pragma("busy_timeout", { simple: true });
  const pause = new Int32Array(new SharedArrayBuffer(4));
  db.pragma("busy_timeout = 0");
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if (db.pragma("journal_mode = WAL", { simple: true }) !== "wal")
          throw Error("SQLite no pudo activar WAL.");
        return;
      } catch (error) {
        if (error.code !== "SQLITE_BUSY" || attempt === 99) throw error;
        Atomics.wait(pause, 0, 0, 50);
      }
    }
  } finally {
    db.pragma("busy_timeout = " + timeout);
  }
}
