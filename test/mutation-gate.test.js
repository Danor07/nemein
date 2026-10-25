import fc from "fast-check";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { mutationGate } from "../scripts/mutation-gate.js";
const report = (statuses) => ({
  files: { file: { mutants: statuses.map((status) => ({ status })) } },
});
test("mutation gate rejects empty, failed and timed-out measurements", () => {
  for (const status of [
    "Timeout",
    "RuntimeError",
    "CompileError",
    "NoCoverage",
  ])
    assert.throws(() => mutationGate(report(["Killed", status])));
  assert.throws(() => mutationGate(report([])));
});
test("mutation gate requires at least 90 percent killed, without rounding up", () => {
  assert.equal(
    mutationGate(report([...Array(9).fill("Killed"), "Survived"])),
    90,
  );
  assert.throws(() =>
    mutationGate(
      report([...Array(89).fill("Killed"), ...Array(11).fill("Survived")]),
    ),
  );
});

test("PBT: mutation gate honors every integer boundary and rejects contaminated measurements", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 100 }), (killed) => {
      const statuses = [
        ...Array(killed).fill("Killed"),
        ...Array(100 - killed).fill("Survived"),
      ];
      if (killed >= 90) assert.equal(mutationGate(report(statuses)), killed);
      else
        assert.throws(
          () => mutationGate(report(statuses)),
          /Mutation score below 90:/,
        );
      for (const invalid of [
        "Timeout",
        "RuntimeError",
        "CompileError",
        "NoCoverage",
        "Ignored",
      ])
        assert.throws(
          () => mutationGate(report([...Array(99).fill("Killed"), invalid])),
          /Mutation run contains/,
        );
    }),
    { seed: 424242, numRuns: 200 },
  );
  assert.throws(() => mutationGate({}), /No mutants were evaluated/);
});
test("mutation gate CLI enforces the same pass/fail contract", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-mutation-gate-"));
  try {
    mkdirSync(path.join(dir, "reports", "mutation"), { recursive: true });
    const file = path.join(dir, "reports", "mutation", "mutation.json"),
      script = fileURLToPath(
        new URL("../scripts/mutation-gate.js", import.meta.url),
      );
    writeFileSync(
      file,
      JSON.stringify(report([...Array(9).fill("Killed"), "Survived"])),
    );
    let r = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "Mutation gate: 90.00%");
    writeFileSync(
      file,
      JSON.stringify(
        report([...Array(8).fill("Killed"), ...Array(2).fill("Survived")]),
      ),
    );
    r = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Mutation score below 90:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation gate validates the selected report and never substitutes the default", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-selected-report-"));
  try {
    mkdirSync(path.join(dir, "reports", "mutation"), { recursive: true });
    writeFileSync(
      path.join(dir, "reports", "mutation", "mutation.json"),
      JSON.stringify(report(Array(10).fill("Survived"))),
    );
    const chosen = path.join(dir, "chosen.json"),
      script = fileURLToPath(
        new URL("../scripts/mutation-gate.js", import.meta.url),
      );
    writeFileSync(chosen, JSON.stringify(report(Array(10).fill("Killed"))));
    let child = spawnSync(process.execPath, [script, chosen], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "Mutation gate: 100.00%");
    child = spawnSync(
      process.execPath,
      [script, path.join(dir, "missing.json")],
      { cwd: dir, encoding: "utf8" },
    );
    assert.notEqual(child.status, 0);
    writeFileSync(chosen, JSON.stringify(report(["Killed", "Timeout"])));
    child = spawnSync(process.execPath, [script, chosen], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /contains timeouts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
