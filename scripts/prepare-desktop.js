import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "desktop-resources", "runtime");
fs.mkdirSync(target, { recursive: true });
for (const name of ["src", "public", "views", "node_modules"])
  fs.cpSync(path.join(root, name), path.join(target, name), {
    recursive: true,
  });
fs.copyFileSync(
  path.join(root, "package.json"),
  path.join(target, "package.json"),
);
fs.copyFileSync(
  process.execPath,
  path.join(target, process.platform === "win32" ? "node.exe" : "node"),
);
console.log("Runtime local preparado: " + target);
