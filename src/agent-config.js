import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
function registeredInstalls() {
  if (process.platform !== "win32") return [];
  return ["HKCU", "HKLM"].flatMap((hive) => {
    const result = spawnSync(
      "reg.exe",
      [
        "query",
        hive +
          "\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Nemein",
        "/v",
        "InstallLocation",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 2000 },
    );
    const value = result.stdout
      ?.match(/REG_SZ\s+(.+)/)?.[1]
      ?.trim()
      .replace(/^"|"$/g, "");
    return value ? [value] : [];
  });
}
export function installedAgentConfig(
  dataDir,
  { runtimeRoot, installDirs, agentToken, connectionVersion = "1" } = {},
) {
  if (!agentToken) return null;
  const roots = installDirs ?? [
    runtimeRoot && path.dirname(runtimeRoot),
    process.env.NEMEIN_INSTALL_DIR,
    ...registeredInstalls(),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Nemein"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Nemein"),
  ];
  for (const candidate of roots.filter(Boolean)) {
    try {
      const root = realpathSync(candidate);
      if (
        /(^|[\\/])(src-tauri[\\/]target|desktop-resources)([\\/]|$)/i.test(root)
      )
        continue;
      let ancestor = root,
        development = false;
      while (true) {
        if (existsSync(path.join(ancestor, ".git"))) {
          development = true;
          break;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      if (development) continue;
      const runtime = realpathSync(path.join(root, "runtime"));
      const command = realpathSync(path.join(runtime, "node.exe"));
      const script = realpathSync(path.join(runtime, "src", "mcp.js"));
      if (
        !existsSync(path.join(root, "nemein.exe")) ||
        !existsSync(path.join(root, "uninstall.exe")) ||
        path.dirname(runtime) !== root ||
        path.dirname(command) !== runtime ||
        path.dirname(script) !== path.join(runtime, "src") ||
        JSON.parse(readFileSync(path.join(runtime, "package.json"), "utf8"))
          .name !== "nemein"
      )
        continue;
      const pkg = JSON.parse(
        readFileSync(path.join(runtime, "package.json"), "utf8"),
      );
      const [major, minor] = (pkg.version || "").split(".").map(Number);
      if (
        !existsSync(path.join(runtime, "src", "access.js")) ||
        !(major > 0 || (major === 0 && minor >= 2))
      )
        continue;
      return {
        mcpServers: {
          nemein: {
            command,
            args: [script],
            env: {
              BUDGET_DATA_DIR: dataDir,
              BUDGET_AGENT_TOKEN: agentToken,
              BUDGET_AGENT_VERSION: connectionVersion,
            },
          },
        },
      };
    } catch {
      /* Incomplete installations are never exported. */
    }
  }
  return null;
}
