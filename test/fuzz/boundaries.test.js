import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { openBudget } from "../../src/core.js";
import { decodeCursor } from "../../src/event-reads.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
test("fuzz: malformed cursors are rejected with a stable error", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const token = Buffer.from(JSON.stringify(value)).toString("base64url");
      try {
        const decoded = decodeCursor(token);
        assert.equal(decoded.version, 1);
        assert.equal(typeof decoded.source, "string");
        assert.ok(
          Number.isSafeInteger(decoded.sequence) && decoded.sequence >= 0,
        );
      } catch (e) {
        assert.equal(e.code, "INVALID_CURSOR");
      }
    }),
    { seed: 91337, numRuns: 1500 },
  );
});
test("fuzz: hostile requests cannot change an ungranted budget", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-fuzz-")),
    b = openBudget(dir);
  try {
    const c = b.createConnection({ label: "Fuzz" }),
      agent = b.forAgent(c.token);
    const before = b.snapshot("2026-10");
    fc.assert(
      fc.property(
        fc.constantFrom(
          "transaction",
          "import",
          "allocate",
          "backup",
          "constructor",
          "__proto__",
          "account",
        ),
        fc.jsonValue(),
        (action, args) => {
          assert.throws(
            () => agent.request(action, args),
            (e) =>
              [
                "PERMISSION_DENIED",
                "INVALID_ARGUMENTS",
                "INVALID_ACTION",
              ].includes(e.code),
          );
          assert.deepEqual(b.snapshot("2026-10"), before);
          assert.equal(
            b.db.prepare("SELECT COUNT(*) n FROM budget_events").get().n,
            0,
          );
        },
      ),
      { seed: 91337, numRuns: 600 },
    );
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
