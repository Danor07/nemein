import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { saveCredential, readAgentToken } from "../src/credentials.js";
test("PBT: credential files retain exact bytes without embedding them in paths", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-credential-"));
  try {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (bytes) => {
        const token = Buffer.from(bytes).toString("hex"),
          file = saveCredential(dir, token);
        assert.ok(!file.includes(token));
        assert.ok(file.startsWith(dir + path.sep));
        assert.equal(readAgentToken({ BUDGET_AGENT_TOKEN_FILE: file }), token);
        assert.equal(
          readFileSync(file, "utf8"),
          "BUDGET_AGENT_TOKEN=" + token + "\n",
        );
        if (process.platform !== "win32")
          assert.equal(statSync(file).mode & 0o777, 0o600);
        const env = { ...process.env };
        delete env.BUDGET_AGENT_TOKEN;
        const child = spawnSync(
          process.execPath,
          [
            "--env-file=" + file,
            "-e",
            "if(process.env.BUDGET_AGENT_TOKEN.length!==64)process.exit(1)",
          ],
          { env, encoding: "utf8" },
        );
        assert.equal(child.status, 0, child.stderr);
      }),
      { seed: 424242, numRuns: 8 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("credential writer fails closed on invalid secrets", () => {
  assert.throws(() => saveCredential(os.tmpdir(), "invalid"));
});

test("credential file takes precedence over an inherited token and fails closed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-read-")),
    token = "a".repeat(64);
  try {
    const file = saveCredential(dir, token);
    assert.equal(
      readAgentToken({
        BUDGET_AGENT_TOKEN: "wrong",
        BUDGET_AGENT_TOKEN_FILE: file,
      }),
      token,
    );
    assert.equal(readAgentToken({ BUDGET_AGENT_TOKEN: token }), token);
    assert.equal(readAgentToken({}), undefined);
    for (const text of [
      "",
      "BUDGET_AGENT_TOKEN=" + token + "\nEXTRA=1\n",
      "BUDGET_AGENT_TOKEN=" + token.slice(1) + "\n",
    ]) {
      writeFileSync(file, text);
      assert.throws(() => readAgentToken({ BUDGET_AGENT_TOKEN_FILE: file }), {
        code: "INVALID_CREDENTIAL_FILE",
      });
    }
    assert.throws(
      () =>
        readAgentToken({ BUDGET_AGENT_TOKEN_FILE: path.join(dir, "missing") }),
      { code: "CREDENTIAL_UNAVAILABLE" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Windows credential ACL command fails closed and restricts inheritance", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-acl-"));
  const script =
    'import assert from "node:assert/strict";\nimport child from "node:child_process";\nimport {syncBuiltinESMExports} from "node:module";\nimport fs from "node:fs";\nimport path from "node:path";\nprocess.env.SystemRoot=path.resolve("windows-fixture");\nconst calls=[];\nchild.execFileSync=(command,args,options)=>{\n calls.push({command,args,options});\n assert.ok(path.isAbsolute(command));\n assert.equal(path.dirname(command),path.join(process.env.SystemRoot,"System32"));\n if(path.basename(command)==="whoami.exe")return \'"fixture","S-1-5-21-123-456-789-1001"\';\n assert.equal(path.basename(command),"icacls.exe");\n if(calls.length===2)assert.deepEqual(args.slice(1),["/reset"]);\n if(calls.length===3)assert.deepEqual(args.slice(1),["/inheritance:r","/grant:r","*S-1-5-21-123-456-789-1001:(OI)(CI)F","*S-1-5-18:(OI)(CI)F"]);\n if(calls.length===4){assert.deepEqual(args.slice(1),["/reset"]);assert.equal(fs.readFileSync(args[0],"utf8"),"");}\n return "";\n};\nsyncBuiltinESMExports();\nObject.defineProperty(process,"platform",{value:"win32"});\nconst {saveCredential}=await import(process.argv[1]);\nconst file=saveCredential(process.argv[2],"b".repeat(64));\nassert.ok(path.isAbsolute(file));assert.ok(file.startsWith(process.argv[2]+path.sep));assert.equal(path.basename(file),"connection.env");\nassert.equal(calls.length,4);assert.equal(path.basename(calls[0].command),"whoami.exe");assert.deepEqual(calls[0].args,["/user","/fo","csv","/nh"]);\nassert.equal(calls[0].options.encoding,"utf8");\nfor(const call of calls)assert.equal(call.options.windowsHide,true);\nfor(const call of calls.slice(1))assert.equal(call.options.stdio,"pipe");\nassert.equal(calls[1].args[0],path.dirname(file));assert.equal(calls[2].args[0],path.dirname(file));assert.equal(calls[3].args[0],file);assert.ok(fs.existsSync(file));\nassert.equal(fs.readFileSync(file,"utf8"),"BUDGET_AGENT_TOKEN="+"b".repeat(64)+"\\n");\nchild.execFileSync=()=>"invalid identity";syncBuiltinESMExports();\nassert.throws(()=>saveCredential(process.argv[2],"c".repeat(64)),/identify credential owner/);\nfor(const failedCall of [2,3,4]){\n let count=0,emptyFile;\n child.execFileSync=(command,args)=>{\n  count++;\n  if(path.basename(command)==="whoami.exe")return "S-1-5-21-123";\n  if(count===failedCall){if(failedCall===4)emptyFile=args[0];throw Error("ACL failure");}\n  return "";\n };syncBuiltinESMExports();\n assert.throws(()=>saveCredential(process.argv[2],"d".repeat(64)),/ACL failure/);\n assert.equal(count,failedCall);\n if(emptyFile)assert.equal(fs.readFileSync(emptyFile,"utf8"),"");\n}\n';
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        new URL("../src/credentials.js", import.meta.url).href,
        dir,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PBT: credential syntax is exact, diagnostics preserve their cause", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-credential-syntax-")),
    valid = "e".repeat(64);
  try {
    for (const value of [
      null,
      [],
      [valid],
      {},
      Object(valid),
      Buffer.from(valid),
      1,
      "x" + valid,
      valid + "x",
      "",
    ]) {
      assert.throws(
        () => saveCredential(dir, value),
        /Invalid connection credential/,
      );
    }
    const file = saveCredential(dir, valid);
    for (const text of [
      "BUDGET_AGENT_TOKEN=" + valid,
      "BUDGET_AGENT_TOKEN=" + valid + "\r\n",
      "BUDGET_AGENT_TOKEN=" + valid + "\n",
    ]) {
      writeFileSync(file, text);
      assert.equal(readAgentToken({ BUDGET_AGENT_TOKEN_FILE: file }), valid);
    }
    for (const text of [
      "xBUDGET_AGENT_TOKEN=" + valid + "\n",
      " BUDGET_AGENT_TOKEN=" + valid + "\n",
    ]) {
      writeFileSync(file, text);
      assert.throws(
        () => readAgentToken({ BUDGET_AGENT_TOKEN_FILE: file }),
        (e) => e.code === "INVALID_CREDENTIAL_FILE" && e.message.length > 0,
      );
    }
    assert.throws(
      () =>
        readAgentToken({ BUDGET_AGENT_TOKEN_FILE: path.join(dir, "missing") }),
      (e) =>
        e.code === "CREDENTIAL_UNAVAILABLE" &&
        e.cause instanceof Error &&
        e.message.length > 0,
    );
    const old = process.env.BUDGET_AGENT_TOKEN_FILE;
    try {
      writeFileSync(file, "BUDGET_AGENT_TOKEN=" + valid + "\n");
      process.env.BUDGET_AGENT_TOKEN_FILE = file;
      assert.equal(readAgentToken(), valid);
    } finally {
      if (old === undefined) delete process.env.BUDGET_AGENT_TOKEN_FILE;
      else process.env.BUDGET_AGENT_TOKEN_FILE = old;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "Windows credential files grant access only to this user and SYSTEM",
  { skip: process.platform !== "win32" },
  () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-real-acl-"));
    try {
      const file = saveCredential(dir, "f".repeat(64));
      const r = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $file=Get-Acl -LiteralPath $env:NEMEIN_TEST_CREDENTIAL_FILE; $dir=Get-Acl -LiteralPath (Split-Path -Parent $env:NEMEIN_TEST_CREDENTIAL_FILE); @{user=$sid;protected=$dir.AreAccessRulesProtected;ids=@($file.Access | ForEach-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value})} | ConvertTo-Json -Compress",
        ],
        {
          env: {
            ...process.env,
            NEMEIN_TEST_CREDENTIAL_FILE: file,
            PSModulePath: path.join(
              process.env.SystemRoot,
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "Modules",
            ),
          },
          encoding: "utf8",
          windowsHide: true,
        },
      );
      assert.equal(r.status, 0, r.stderr);
      const acl = JSON.parse(r.stdout);
      assert.equal(acl.protected, true);
      assert.deepEqual(
        [...new Set(acl.ids)].sort(),
        [acl.user, "S-1-5-18"].sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("credential creation is exclusive and POSIX never invokes Windows tools", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-exclusive-"));
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import assert from "node:assert/strict";import fs from "node:fs";import child from "node:child_process";import {syncBuiltinESMExports} from "node:module";import path from "node:path";\nchild.execFileSync=()=>{throw Error("Native commands must not run on POSIX");};syncBuiltinESMExports();Object.defineProperty(process,"platform",{value:"linux"});\nconst {saveCredential}=await import(process.argv[1]),dir=process.argv[2];\nconst file=saveCredential(dir,"b".repeat(64));assert.ok(fs.existsSync(file));\nconst existing=path.join(dir,"connection.env");fs.writeFileSync(existing,"preserve");\nfs.mkdtempSync=()=>dir;syncBuiltinESMExports();\nassert.throws(()=>saveCredential(dir,"c".repeat(64)),{code:"EEXIST"});assert.equal(fs.readFileSync(existing,"utf8"),"preserve");',
        new URL("../src/credentials.js", import.meta.url).href,
        dir,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
