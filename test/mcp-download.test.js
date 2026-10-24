import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const code = () => readFileSync("public/mcp-download.js", "utf8");
function fixture(fetch) {
  const label = {},
    icon = {},
    status = {
      dataset: {},
      setAttribute(k, v) {
        this[k] = v;
      },
    };
  const button = {
    dataset: {},
    disabled: false,
    setAttribute(k, v) {
      this[k] = v;
    },
    querySelector(s) {
      if (s === "[data-feedback-label]") return label;
      assert.equal(s, "[data-feedback-icon]");
      return icon;
    },
  };
  const events = { prevented: 0 };
  const timers = [],
    calls = [],
    links = [],
    revoked = [];
  let submit;
  const form = {
    action: "/agent-config",
    querySelector(selector) {
      assert.equal(selector, "[data-mcp-download]");
      return button;
    },
    addEventListener(event, fn) {
      assert.equal(event, "submit");
      submit = fn;
    },
  };
  const document = {
    querySelector(s) {
      if (s === "[data-mcp-form]") return form;
      assert.equal(s, "#mcp-download-status");
      return status;
    },
    createElement(tag) {
      assert.equal(tag, "a");
      return {
        click() {
          assert.equal(this.attached, true);
          links.push({
            href: this.href,
            download: this.download,
            element: this,
          });
        },
        remove() {
          this.removed = true;
        },
      };
    },
    body: {
      append(link) {
        link.attached = true;
      },
    },
  };
  vm.runInNewContext(code(), {
    document,
    fetch: async (...args) => {
      calls.push(args);
      return fetch(...args);
    },
    FormData: class extends Map {
      constructor() {
        super([
          ["_csrf", "fixture"],
          ["export_id", "export"],
        ]);
      }
    },
    URLSearchParams,
    URL: {
      createObjectURL(blob) {
        assert.equal(blob, "configuration");
        return "blob:fixture";
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
    setTimeout(fn, ms) {
      timers.push({ fn, ms });
    },
    process: {
      env: { __STRYKER_ACTIVE_MUTANT__: process.env.__STRYKER_ACTIVE_MUTANT__ },
    },
  });
  return {
    button,
    label,
    icon,
    status,
    calls,
    links,
    revoked,
    timers,
    events,
    submit: () =>
      submit({
        preventDefault() {
          events.prevented++;
        },
      }),
    tick(ms) {
      timers.filter((t) => t.ms === ms).forEach((t) => t.fn());
    },
  };
}
test("download uses submit (including keyboard), reports only preparation and prevents duplicates", async () => {
  let resolve;
  const f = fixture(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = f.submit();
  assert.equal(f.button.disabled, true);
  assert.equal(f.button["aria-busy"], "true");
  assert.equal(f.label.textContent, "Preparando…");
  assert.equal(f.status.role, "status");
  assert.equal(f.status.dataset.kind, "info");
  const duplicate = f.submit();
  assert.equal(f.calls.length, 1);
  await duplicate;
  assert.equal(f.events.prevented, 2);
  assert.equal(f.status.textContent, "Preparando nemein-mcp.json…");
  resolve({ ok: true, status: 200, blob: async () => "configuration" });
  await pending;
  const [url, options] = f.calls[0];
  assert.equal(url, "/agent-config");
  assert.equal(options.method, "POST");
  assert.equal(options.credentials, "same-origin");
  assert.equal(options.body.get("_csrf"), "fixture");
  assert.equal(options.body.get("export_id"), "export");
  assert.equal(f.links.length, 1);
  assert.equal(f.links[0].element.removed, true);
  assert.deepEqual(
    f.links.map(({ href, download }) => ({ href, download })),
    [{ href: "blob:fixture", download: "nemein-mcp.json" }],
  );
  assert.equal(f.label.textContent, "Preparada");
  assert.equal(f.icon.textContent, "✓");
  assert.equal(f.button.dataset.state, "prepared");
  assert.equal(f.button["aria-busy"], "false");
  assert.match(f.status.textContent, /suele quedar en Descargas/);
  assert.match(f.status.textContent, /Ver configuración para copiar/);
  assert.doesNotMatch(f.status.textContent, /descargada/i);
  assert.equal(f.button.disabled, true);
  assert.deepEqual(
    f.timers.map((t) => t.ms).sort((a, b) => a - b),
    [2500, 60000],
  );
  f.tick(2500);
  assert.equal(f.button.disabled, false);
  assert.equal(f.label.textContent, "Descargar configuración MCP");
  assert.equal(f.button.dataset.state, "idle");
  assert.equal(f.icon.textContent, "");
  f.tick(60000);
  assert.deepEqual(f.revoked, ["blob:fixture"]);
});
test("PBT: HTTP failures keep an announced error and enable a retry", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 400, max: 599 }), async (status) => {
      const f = fixture(async () => ({ ok: false, status }));
      await f.submit();
      assert.equal(f.button.disabled, false);
      assert.equal(f.button["aria-busy"], "false");
      assert.equal(f.button.dataset.state, "error");
      assert.equal(f.label.textContent, "Reintentar");
      assert.equal(f.icon.textContent, "!");
      assert.equal(f.status.role, "alert");
      assert.equal(f.status.dataset.kind, "error");
      assert.match(
        f.status.textContent,
        status === 410 ? /venció/ : /Reintentá/,
      );
      assert.equal(f.timers.length, 0);
      assert.equal(f.links.length, 0);
      await f.submit();
      assert.equal(f.calls.length, 2);
    }),
    { seed: 424242, numRuns: 40 },
  );
  const expired = fixture(async () => ({ ok: false, status: 410 }));
  await expired.submit();
  assert.match(expired.status.textContent, /Renová el token/);
});
test("network and body errors stay visible without leaking diagnostics", async () => {
  for (const fetch of [
    async () => {
      throw Error("secret-internal-diagnostic");
    },
    async () => ({
      ok: true,
      status: 200,
      blob: async () => {
        throw Error("body unavailable");
      },
    }),
  ]) {
    const f = fixture(fetch);
    await f.submit();
    assert.equal(f.status.role, "alert");
    assert.equal(f.label.textContent, "Reintentar");
    assert.doesNotMatch(
      f.status.textContent,
      /secret|diagnostic|body unavailable/,
    );
    assert.equal(f.links.length, 0);
    assert.equal(f.button.disabled, false);
  }
});
test("pages without a download form do not register actions", () => {
  vm.runInNewContext(code(), {
    document: { querySelector: () => null },
    process: {
      env: { __STRYKER_ACTIVE_MUTANT__: process.env.__STRYKER_ACTIVE_MUTANT__ },
    },
  });
});
