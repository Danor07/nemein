import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
export function saveCredential(dataDir, token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
    throw Error("Invalid connection credential");
  const dir = mkdtempSync(path.join(dataDir, "credential-"));
  if (process.platform === "win32") {
    const sid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
    }).match(/S-1-5-(?:\d+-)*\d+/)?.[0];
    if (!sid) throw Error("Cannot identify credential owner");
    execFileSync(
      "icacls.exe",
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
  writeFileSync(file, "BUDGET_AGENT_TOKEN=" + token + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
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
