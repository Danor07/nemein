import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeDesktopNotices } from "./desktop-notices.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "desktop-resources", "runtime");
fs.mkdirSync(target, { recursive: true });
const modules = path.resolve(target, "node_modules");
if (
  !fs.realpathSync(target).startsWith(fs.realpathSync(root) + path.sep) ||
  (fs.existsSync(modules) && fs.lstatSync(modules).isSymbolicLink())
)
  throw Error("Unsafe generated runtime path");
for (const name of ["src", "public", "views"])
  fs.cpSync(path.join(root, name), path.join(target, name), {
    recursive: true,
  });
// Keep development-only test and mutation tools out of desktop installers.
const npm =
  process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const packages = execFileSync(
  process.execPath,
  [npm, "ls", "--omit=dev", "--all", "--parseable"],
  { cwd: root, encoding: "utf8", windowsHide: true },
)
  .trim()
  .split(/\r?\n/)
  .filter((p) => path.resolve(p) !== root);
fs.rmSync(modules, { recursive: true, force: true });
for (const source of packages) {
  const relative = path.relative(root, source);
  if (
    !relative.startsWith("node_modules" + path.sep) ||
    relative.split(path.sep).includes("..")
  )
    throw Error("Dependency outside project");
  fs.cpSync(source, path.join(target, relative), { recursive: true });
}
for (const name of ["package.json", "LICENSE", "PRIVACIDAD.md"])
  fs.copyFileSync(path.join(root, name), path.join(target, name));
fs.copyFileSync(
  process.execPath,
  path.join(target, process.platform === "win32" ? "node.exe" : "node"),
);
console.log("Runtime local preparado: " + target);
writeDesktopNotices(root, target);
