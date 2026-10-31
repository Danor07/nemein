import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { Worker } from "node:worker_threads";
import { statementImportBatch } from "../../src/statement-import.js";
import { ofx, ofxRow, camt, camtRow } from "../fixtures/statements.js";

test("fuzz statements: arbitrary input and truncation cannot yield partial imports", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 1500 }), fc.nat(), (noise, cut) => {
      for (const [format, wrap, row] of [
        ["ofx", ofx, ofxRow],
        ["camt053", camt, camtRow],
      ]) {
        const content = wrap(row());
        assert.throws(() =>
          statementImportBatch(
            content.slice(0, cut % content.length),
            { format },
            1,
          ),
        );
        assert.throws(
          () =>
            statementImportBatch(
              wrap(row({ payee: "<!DOCTYPE hostile>" + noise })),
              { format },
              1,
            ),
          { code: "IMPORT_UNSAFE_XML" },
        );
        try {
          const batch = statementImportBatch(noise, { format }, 1);
          assert.fail(
            "Arbitrary non-statement was accepted: " + JSON.stringify(batch),
          );
        } catch (error) {
          assert.match(error.code, /^IMPORT_/);
        }
      }
    }),
    { seed: 805303, numRuns: 250 },
  );
});

async function boundedWorker(code, timeout = 2500) {
  const worker = new Worker(code, { eval: true });
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Parser worker exceeded ${timeout} ms`)),
        timeout,
      );
      worker.once("message", (message) => {
        assert.equal(message, "done");
        resolve();
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error("Parser worker exit " + code));
      });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

test("fuzz statements: watchdog fails and terminates an intentionally blocked worker", async () => {
  await assert.rejects(
    boundedWorker(
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)",
      100,
    ),
    /Parser worker exceeded 100 ms/,
  );
});

test("fuzz statements: pathological tags and base64 finish before the mutation runner deadline", async () => {
  // A worker deadline fails as an assertion and terminates even if a regex mutant spins.
  const moduleUrl = new URL("../../src/statement-import.js", import.meta.url)
    .href;
  await boundedWorker(`
    const { parentPort } = require('node:worker_threads');
    import(${JSON.stringify(moduleUrl)}).then(({ statementImportBatch: parse }) => {
      for (const input of ['<a ' + ' '.repeat(4000000) + '!>', '<' + 'a'.repeat(4000000) + '>', 'A'.repeat(5000000) + '!', '<a>'.repeat(100000), '<a x="' + ' '.repeat(1000000) + '">']) {
        for (const content_encoding of [undefined, 'base64']) {
          try { parse(input, {format:'ofx', content_encoding}, 1); } catch {}
        }
      }
      parentPort.postMessage('done');
    }).catch(error => { throw error; });
  `);
});
