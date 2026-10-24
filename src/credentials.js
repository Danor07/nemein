import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  openSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
export function saveCredential(dataDir, token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
    throw Error("Invalid connection credential");
  const dir = mkdtempSync(path.join(dataDir, "credential-"));
  const system32 =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot, "System32")
      : null;
  if (process.platform === "win32") {
    const sid = execFileSync(
      path.join(system32, "whoami.exe"),
      ["/user", "/fo", "csv", "/nh"],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    ).match(/S-1-5-(?:\d+-)*\d+/)?.[0];
    if (!sid) throw Error("Cannot identify credential owner");
    // Remove explicit entries as well as inherited ones before storing a secret.
    execFileSync(path.join(system32, "icacls.exe"), [dir, "/reset"], {
      stdio: "pipe",
      windowsHide: true,
    });
    execFileSync(
      path.join(system32, "icacls.exe"),
      [
        dir,
        "/inheritance:r",
        "/grant:r",
        "*" + sid + ":(OI)(CI)F",
        "*S-1-5-18:(OI)(CI)F",
      ],
      { stdio: "pipe", windowsHide: true },
    );
  }
  const file = path.join(dir, "connection.env");
  const descriptor = openSync(file, "wx", 0o600);
  try {
    // Windows may add explicit Administrators access when creating a file.
    if (process.platform === "win32")
      execFileSync(path.join(system32, "icacls.exe"), [file, "/reset"], {
        stdio: "pipe",
        windowsHide: true,
      });
    writeFileSync(descriptor, "BUDGET_AGENT_TOKEN=" + token + "\n", "utf8");
  } finally {
    closeSync(descriptor);
  }
  return file;
}

export function readAgentToken(env = process.env) {
  if (!env.BUDGET_AGENT_TOKEN_FILE) return env.BUDGET_AGENT_TOKEN;
  let text;
  try {
    text = readFileSync(env.BUDGET_AGENT_TOKEN_FILE, "utf8");
  } catch (cause) {
    throw Object.assign(
      new Error("No se pudo leer la credencial de la conexión.", { cause }),
      { code: "CREDENTIAL_UNAVAILABLE" },
    );
  }
  const match = /^BUDGET_AGENT_TOKEN=([a-f0-9]{64})\r?\n?$/.exec(text);
  if (!match)
    throw Object.assign(new Error("El archivo de credencial no es válido."), {
      code: "INVALID_CREDENTIAL_FILE",
    });
  return match[1];
}
