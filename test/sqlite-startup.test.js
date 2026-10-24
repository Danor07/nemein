import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { enableWal } from "../src/sqlite-startup.js";

function connection(
  busy,
  error = Object.assign(Error("busy"), { code: "SQLITE_BUSY" }),
  mode = "wal",
) {
  const state = { calls: 0, timeout: 1234, waits: 0 };
  return {
    state,
    pragma(sql, options) {
      if (sql === "busy_timeout") {
        assert.deepEqual(options, { simple: true });
        return state.timeout;
      }
      if (sql.startsWith("busy_timeout = ")) {
        state.timeout = Number(sql.slice("busy_timeout = ".length));
        return;
      }
      assert.equal(sql, "journal_mode = WAL");
      assert.deepEqual(options, { simple: true });
      assert.equal(state.timeout, 0);
      state.calls++;
      if (state.calls > 101) throw Error("unbounded retry");
      if (state.calls <= busy) throw error;
      return mode;
    },
  };
}

test("PBT: WAL startup retries only transient contention and restores the timeout", (t) => {
  let current;
  t.mock.method(Atomics, "wait", (array, index, value, delay) => {
    assert.ok(array instanceof Int32Array);
    assert.equal(array.length, 1);
    assert.equal(array[0], 0);
    assert.equal(index, 0);
    assert.equal(value, 0);
    assert.equal(delay, 50);
    current.state.waits++;
  });
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 99 }), (busy) => {
      current = connection(busy);
      enableWal(current);
      assert.equal(current.state.calls, busy + 1);
      assert.equal(current.state.waits, busy);
      assert.equal(current.state.timeout, 1234);
    }),
    { seed: 424242, numRuns: 120 },
  );
});

test("WAL contention has a finite budget and preserves the original failure", (t) => {
  const error = Object.assign(Error("locked"), { code: "SQLITE_BUSY" });
  const db = connection(100, error);
  t.mock.method(Atomics, "wait", () => {
    db.state.waits++;
  });
  assert.throws(
    () => enableWal(db),
    (e) => e === error,
  );
  assert.equal(db.state.calls, 100);
  assert.equal(db.state.waits, 99);
  assert.equal(db.state.timeout, 1234);
});

test("WAL does not retry other failures or silently accept another mode", (t) => {
  t.mock.method(Atomics, "wait", () => assert.fail("unexpected retry"));
  for (const code of ["SQLITE_CORRUPT", "SQLITE_READONLY", undefined]) {
    const error = Object.assign(Error("failed"), { code });
    const db = connection(1, error);
    assert.throws(
      () => enableWal(db),
      (e) => e === error,
    );
    assert.equal(db.state.calls, 1);
    assert.equal(db.state.timeout, 1234);
  }
  const db = connection(0, undefined, "delete");
  assert.throws(() => enableWal(db), /activar WAL/);
  assert.equal(db.state.calls, 1);
  assert.equal(db.state.timeout, 1234);
});
