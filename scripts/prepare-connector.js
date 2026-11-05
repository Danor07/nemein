import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Builds the connector worker for the host and places it where Tauri's
// `bundle.externalBin` expects it: src-tauri/binaries/nemein-connector-<triple>.
// Only the production binary is built: never the test-worker feature or its
// helper binaries. Cargo runs inside src-tauri/connector so its pinned
// toolchain and static C runtime apply.
export function prepareConnector(root, run) {
  const workspace = path.join(root, "src-tauri", "connector");
  const triple = /^host: (\S+)$/m.exec(run("rustc", ["-vV"], workspace))?.[1];
  if (!triple) throw Error("No se pudo leer la plataforma de rustc.");
  // The whole workspace, not only the worker: desktop-notices reads its
  // metadata offline afterwards, and that resolves every member.
  run("cargo", ["fetch", "--locked"], workspace);
  run(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "-p",
      "nemein-connector",
      "--bin",
      "nemein-connector",
    ],
    workspace,
  );
  const extension = triple.includes("windows") ? ".exe" : "";
  const built = path.join(
    workspace,
    "target",
    "release",
    "nemein-connector" + extension,
  );
  if (!fs.existsSync(built))
    throw Error("No se generó el binario del conector: " + built);
  const binaries = path.join(root, "src-tauri", "binaries");
  fs.mkdirSync(binaries, { recursive: true });
  const target = path.join(binaries, `nemein-connector-${triple}${extension}`);
  fs.copyFileSync(built, target);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    "Conector preparado: " +
      prepareConnector(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
        (command, args, cwd) =>
          execFileSync(command, args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "inherit"],
            windowsHide: true,
          }),
      ),
  );
