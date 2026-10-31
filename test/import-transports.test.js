import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openBudget } from "../src/core.js";
import { createApp } from "../src/server.js";

import { ofx, camt } from "./fixtures/statements.js";

for (const format of ["csv", "ofx", "camt053"])
  test(
    format +
      " v1 preserves CLI/MCP preview, permissions, results and the owner HTTP review flow",
    async (t) => {
      const dir = mkdtempSync(
        path.join(os.tmpdir(), "nemein-import-transports-"),
      );
      const b = openBudget(dir);
      const account_id = b.createAccount({
        name: "Transport fixture",
        type: "corriente",
      });
      const connection = b.createConnection({ label: "Fixture" });
      const env = {
        ...process.env,
        BUDGET_DATA_DIR: dir,
        BUDGET_AGENT_TOKEN: connection.token,
        BUDGET_AGENT_TOKEN_FILE: "",
        BUDGET_AGENT_VERSION: "1",
      };
      const client = new Client({ name: "import-fixture", version: "1" });
      const server = createApp(b).listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      t.after(async () => {
        await client.close();
        await new Promise((resolve) => server.close(resolve));
        b.close();
        rmSync(dir, { recursive: true, force: true });
      });
      const p = {
        account_id,
        content: "date,payee,amount\n2026-10-02,Café,-10",
        config: {
          date: "date",
          payee: "payee",
          amount: "amount",
          category_id: 1,
          delimiter: ",",
          dateFormat: "iso",
          thousands: "none",
        },
      };
      if (format !== "csv") {
        p.content = Buffer.from(format === "ofx" ? ofx() : camt()).toString(
          "base64",
        );
        p.config = { format, content_encoding: "base64", category_id: 1 };
      }
      const cli = (action) => {
        const r = spawnSync(
          process.execPath,
          ["src/cli.js", action, "--stdin"],
          {
            env,
            input: JSON.stringify(p),
            encoding: "utf8",
            timeout: 15000,
          },
        );
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout).result;
      };
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [path.resolve("src/mcp.js")],
          env,
        }),
      );
      const mcp = (action) =>
        client.callTool({
          name: "ejecutar_accion",
          arguments: { action, arguments: p },
        });
      assert.equal(
        JSON.parse((await mcp("import")).content[0].text).code,
        "PERMISSION_DENIED",
      );
      for (const action of ["import-preview", "import"])
        b.setRule({ connection_id: connection.id, action, decision: "allow" });
      const expected = b.csvPreview(p.content, p.config, account_id);
      assert.deepEqual(cli("import-preview"), expected);
      assert.deepEqual(
        JSON.parse((await mcp("import-preview")).content[0].text),
        expected,
      );
      assert.deepEqual(cli("import"), { added: 1, duplicates: 0 });
      assert.deepEqual(JSON.parse((await mcp("import")).content[0].text), {
        added: 0,
        duplicates: 1,
      });
      const base = "http://127.0.0.1:" + server.address().port;
      const html = await (await fetch(base + "/?view=import")).text();
      const _csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
      const post = (action, data) =>
        fetch(base + "/action/" + action, {
          method: "POST",
          body: new URLSearchParams({ _csrf, view: "import", ...data }),
          redirect: "manual",
        });
      const preview = await post("preview", {
        account_id,
        content: p.content,
        ...(format === "csv" ? {} : { format, content_encoding: "base64" }),
        dateColumn: "date",
        payeeColumn: "payee",
        amountColumn: "amount",
        category_id: 1,
        delimiter: ",",
        dateFormat: "iso",
        thousands: "none",
      });
      assert.equal(preview.status, 200);
      const previewHtml = await preview.text();
      assert.match(previewHtml, /Revisá antes de guardar/);
      const previewId = previewHtml.match(
        /name="previewId" value="([^"]+)"/,
      )[1];
      const confirmed = await post("import", { previewId });
      assert.equal(confirmed.status, 302);
      assert.equal(
        new URL(confirmed.headers.get("location"), base).searchParams.get(
          "notice",
        ),
        "Se importaron 0 movimientos. 1 ya existían.",
      );
      assert.equal(b.accountTransactions(account_id).length, 1);
      assert.equal((await post("import", { previewId })).status, 400);
    },
  );
