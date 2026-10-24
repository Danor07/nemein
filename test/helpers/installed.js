import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
export function fakeInstall(root) {
  mkdirSync(path.join(root, "runtime", "src"), { recursive: true });
  for (const f of [
    "nemein.exe",
    "uninstall.exe",
    "runtime/node.exe",
    "runtime/src/mcp.js",
    "runtime/src/access.js",
  ])
    writeFileSync(path.join(root, f), "fixture");
  writeFileSync(
    path.join(root, "runtime", "package.json"),
    JSON.stringify({ name: "nemein", version: "0.2.0" }),
  );
}
