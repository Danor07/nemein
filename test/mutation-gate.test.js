import fc from "fast-check";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { cargoMutantsReport, mutationGate } from "../scripts/mutation-gate.js";
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

const lab = (summaries, baseline = ["Success"]) => ({
  outcomes: [
    ...baseline.map((summary) => ({ scenario: "Baseline", summary })),
    ...summaries.map((summary, index) => ({
      scenario: { Mutant: { name: "m" + index } },
      summary,
    })),
  ],
});

test("cargo-mutants outcomes use the same gate, without unviable mutants", () => {
  assert.deepEqual(
    cargoMutantsReport(
      lab(["CaughtMutant", "MissedMutant", "Unviable", "Timeout", "Failure"]),
    ),
    {
      files: {
        "cargo-mutants": {
          mutants: [
            { status: "Killed" },
            { status: "Survived" },
            { status: "Timeout" },
            { status: "Failure" },
          ],
        },
      },
    },
  );
  assert.equal(
    mutationGate(
      cargoMutantsReport(
        lab([
          ...Array(9).fill("CaughtMutant"),
          "MissedMutant",
          ...Array(50).fill("Unviable"),
        ]),
      ),
    ),
    90,
  );
  for (const summary of ["Timeout", "Failure", "Success", "toString", "x"])
    assert.throws(
      () => mutationGate(cargoMutantsReport(lab(["CaughtMutant", summary]))),
      /Mutation run contains/,
      summary,
    );
  assert.throws(
    () => mutationGate(cargoMutantsReport(lab(["Unviable", "Unviable"]))),
    /No mutants were evaluated/,
  );
  for (const baseline of [[], ["Failure"], ["Timeout"], ["Success", "Success"]])
    assert.throws(
      () => cargoMutantsReport(lab(["CaughtMutant"], baseline)),
      /baseline did not succeed/,
    );
  for (const invalid of [undefined, null, {}, { outcomes: {} }, []])
    assert.throws(
      () => cargoMutantsReport(invalid),
      /Not a cargo-mutants outcomes report/,
    );
});

test("cargo-mutants shards are judged as one run, each with its own baseline", () => {
  const killed = (n) => Array(n).fill("CaughtMutant");
  // 9 of 10 overall, though the second shard alone is at 80 %.
  assert.equal(
    mutationGate(
      cargoMutantsReport(lab(killed(5)), lab([...killed(4), "MissedMutant"])),
    ),
    90,
  );
  assert.throws(
    () =>
      mutationGate(
        cargoMutantsReport(
          lab([...killed(4), "MissedMutant"]),
          lab([...killed(4), "MissedMutant"]),
        ),
      ),
    /Mutation score below 90: 80/,
  );
  assert.throws(
    () => cargoMutantsReport(lab(killed(5)), lab(killed(5), [])),
    /baseline did not succeed/,
  );
  assert.throws(
    () => mutationGate(cargoMutantsReport(lab(killed(5)), lab(["Timeout"]))),
    /Mutation run contains/,
  );
  assert.throws(() => cargoMutantsReport(), /Not a cargo-mutants/);
  assert.throws(
    () => cargoMutantsReport(lab(killed(5)), null),
    /Not a cargo-mutants/,
  );
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-cargo-shards-"));
  try {
    const script = fileURLToPath(
      new URL("../scripts/mutation-gate.js", import.meta.url),
    );
    const files = [lab(killed(5)), lab([...killed(4), "MissedMutant"])].map(
      (shard, index) => {
        const file = path.join(dir, `shard-${index}.json`);
        writeFileSync(file, JSON.stringify(shard));
        return file;
      },
    );
    let child = spawnSync(
      process.execPath,
      [script, "--cargo-mutants", ...files],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "Mutation gate: 90.00%");
    child = spawnSync(process.execPath, [script, "--cargo-mutants", files[1]], {
      encoding: "utf8",
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /below 90: 80/);
    child = spawnSync(process.execPath, [script, "--cargo-mutants"], {
      encoding: "utf8",
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Not a cargo-mutants/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PBT: cargo-mutants score ignores unviable mutants and keeps the 90 boundary", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom(
          "CaughtMutant",
          "CaughtMutant",
          "CaughtMutant",
          "MissedMutant",
          "Unviable",
          "Timeout",
        ),
        { maxLength: 120 },
      ),
      (summaries) => {
        const count = (summary) =>
          summaries.filter((s) => s === summary).length;
        const caught = count("CaughtMutant"),
          viable = caught + count("MissedMutant");
        const gate = () => mutationGate(cargoMutantsReport(lab(summaries)));
        if (count("Timeout")) assert.throws(gate, /Mutation run contains/);
        else if (!viable) assert.throws(gate, /No mutants were evaluated/);
        else if ((100 * caught) / viable >= 90)
          assert.equal(gate(), (100 * caught) / viable);
        else assert.throws(gate, /Mutation score below 90:/);
      },
    ),
    { seed: 525252, numRuns: 300 },
  );
});

test("mutation gate CLI reads cargo-mutants outcomes only when asked", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-cargo-mutants-"));
  try {
    const file = path.join(dir, "outcomes.json"),
      script = fileURLToPath(
        new URL("../scripts/mutation-gate.js", import.meta.url),
      ),
      run = (...args) =>
        spawnSync(process.execPath, [script, ...args], {
          cwd: dir,
          encoding: "utf8",
        });
    writeFileSync(
      file,
      JSON.stringify(
        lab([...Array(19).fill("CaughtMutant"), "MissedMutant", "Unviable"]),
      ),
    );
    let r = run("--cargo-mutants", file);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "Mutation gate: 95.00%");
    // Read as a Stryker report, the same file has no mutants.
    r = run(file);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /No mutants were evaluated/);
    r = run("--cargo-mutants");
    assert.notEqual(r.status, 0);
    writeFileSync(file, JSON.stringify(lab(["CaughtMutant", "Timeout"])));
    r = run("--cargo-mutants", file);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /contains timeouts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
