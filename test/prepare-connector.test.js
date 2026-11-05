import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { prepareConnector } from "../scripts/prepare-connector.js";

function fixture(t, triple, { build = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nemein-connector-prep-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const extension = triple.includes("windows") ? ".exe" : "";
  const run = (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === "rustc")
      return `rustc 1.99.1\nbinary: rustc\nhost: ${triple}\nrelease: 1.99.1\n`;
    if (build) {
      const out = path.join(cwd, "target", "release");
      mkdirSync(out, { recursive: true });
      writeFileSync(
        path.join(out, "nemein-connector" + extension),
        "binario ficticio " + triple,
      );
    }
    return "";
  };
  return { root, run, calls };
}

test("connector build: production binary only, copied with Tauri's sidecar name", (t) => {
  for (const [triple, file] of [
    ["x86_64-pc-windows-msvc", "nemein-connector-x86_64-pc-windows-msvc.exe"],
    ["x86_64-unknown-linux-gnu", "nemein-connector-x86_64-unknown-linux-gnu"],
  ]) {
    const f = fixture(t, triple);
    const target = prepareConnector(f.root, f.run);
    assert.equal(target, path.join(f.root, "src-tauri", "binaries", file));
    assert.equal(readFileSync(target, "utf8"), "binario ficticio " + triple);
    const workspace = path.join(f.root, "src-tauri", "connector");
    assert.deepEqual(f.calls, [
      { command: "rustc", args: ["-vV"], cwd: workspace },
      // The license notices read the whole workspace's metadata offline.
      { command: "cargo", args: ["fetch", "--locked"], cwd: workspace },
      {
        command: "cargo",
        args: [
          "build",
          "--locked",
          "--release",
          "-p",
          "nemein-connector",
          "--bin",
          "nemein-connector",
        ],
        cwd: workspace,
      },
    ]);
    // Never the test double, its probe or the test-worker feature.
    assert.ok(
      !f.calls[2].args.some((a) =>
        /feature|test|probe|all-targets|bins/.test(a),
      ),
    );
  }
});

test("connector build: fails closed without a host triple or a built binary", (t) => {
  const missing = fixture(t, "x86_64-pc-windows-msvc", { build: false });
  assert.throws(
    () => prepareConnector(missing.root, missing.run),
    /No se generó el binario del conector/,
  );
  assert.ok(!existsSync(path.join(missing.root, "src-tauri", "binaries")));
  const f = fixture(t, "x86_64-pc-windows-msvc");
  for (const output of [
    "",
    "host:\n",
    "release: 1.99.1\n",
    "host x86_64-pc-windows-msvc\n",
  ])
    assert.throws(
      () =>
        prepareConnector(f.root, (command, ...rest) =>
          command === "rustc" ? output : f.run(command, ...rest),
        ),
      /No se pudo leer la plataforma de rustc/,
    );
  assert.equal(f.calls.length, 0, "cargo never runs without a triple");
});
