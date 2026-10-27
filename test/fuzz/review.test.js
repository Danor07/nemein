import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openBudget } from "../../src/core.js";
test("fuzz: malformed review packages never persist or move the financial cursor", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "review-fuzz-")),
    b = openBudget(dir);
  try {
    const before = b.eventSnapshot();
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        assert.throws(() =>
          b.saveReview({
            id: "bad",
            package: value,
            report: "",
            generator: "Fixture",
          }),
        );
        assert.equal(b.listReviews().total, 0);
        assert.deepEqual(b.eventSnapshot(), before);
      }),
      { seed: 261029, numRuns: 150 },
    );
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
