// Test double of the nemein-connector supervisor, for tests on any platform.
// `node fake-connector.js <mode> <response.json>` reads one request frame and
// then behaves as `mode` says. Next to response.json it leaves `.pid` (its
// process id) and `.request.json` (the request header and the environment it
// got), so tests can check what reached it and that it is gone afterwards.
// Fictitious data only.
import { closeSync, readFileSync, writeFileSync } from "node:fs";

const [mode, responseFile] = process.argv.slice(2);
const response = JSON.parse(readFileSync(responseFile, "utf8"));
writeFileSync(responseFile + ".pid", String(process.pid));

// No test waits this long: a fake the runner forgot to stop still ends, so a
// broken runner fails its assertions instead of hanging the suite.
setTimeout(() => process.exit(7), 8000).unref();

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function frame(header, blobs) {
  const h = Buffer.from(JSON.stringify(header));
  return Buffer.concat([
    Buffer.from("NMC"),
    Buffer.from([1, "R".charCodeAt(0)]),
    u32(h.length),
    h,
    Buffer.from([blobs.length]),
    ...blobs.flatMap((b) => [u32(b.length), b]),
  ]);
}

const answer = () =>
  frame(
    response.header,
    (response.blobs ?? []).map((b) => Buffer.from(b, "utf8")),
  );

const hang = () => setInterval(() => {}, 1000);

if (mode === "close-stdin") {
  // Stops reading before the request arrives, and stays alive.
  closeSync(0);
  hang();
} else {
  let input = Buffer.alloc(0);
  let answered = false;
  let ended = false;
  process.stdin.on("end", () => {
    ended = true;
    if (mode === "require-open" && !answered) process.exit(5);
  });
  process.stdin.on("data", (chunk) => {
    input = Buffer.concat([input, chunk]);
    if (answered || !requestComplete(input)) return;
    answered = true;
    const headerLength = input.readUInt32LE(5);
    writeFileSync(
      responseFile + ".request.json",
      JSON.stringify({
        header: JSON.parse(input.subarray(9, 9 + headerLength)),
        env: process.env,
      }),
    );
    act(() => ended);
  });
}

function requestComplete(input) {
  if (input.length < 9) return false;
  let end = 9 + input.readUInt32LE(5);
  if (input.length < end + 1) return false;
  const count = input[end];
  end += 1;
  for (let i = 0; i < count; i++) {
    if (input.length < end + 4) return false;
    end += 4 + input.readUInt32LE(end);
  }
  return input.length >= end;
}

function act(isEnded) {
  switch (mode) {
    case "answer":
      return process.stdout.write(answer());
    case "require-open":
      // Answers only if stdin is still open a moment after the request.
      return setTimeout(() => {
        if (!isEnded()) process.stdout.write(answer());
      }, 100);
    case "slow": {
      const bytes = answer();
      let i = 0;
      const tick = setInterval(() => {
        process.stdout.write(bytes.subarray(i, i + 7));
        i += 7;
        if (i >= bytes.length) clearInterval(tick);
      }, 2);
      return;
    }
    case "linger":
      // Answers, then outlives its stdin for a while.
      process.stdout.write(answer());
      return setTimeout(() => process.exit(0), 3000);
    case "extra":
      return process.stdout.write(Buffer.concat([answer(), Buffer.from("x")]));
    case "truncate": {
      const bytes = answer();
      return process.stdout.write(bytes.subarray(0, bytes.length - 1), () =>
        process.exit(0),
      );
    }
    case "huge-blob":
      process.stdout.write(
        Buffer.concat([
          Buffer.from("NMC\x01R"),
          u32(2),
          Buffer.from("{}"),
          Buffer.from([1]),
          u32(25_165_825),
        ]),
      );
      // Keep writing: the reader must refuse at the declared length.
      return setInterval(() => process.stdout.write(Buffer.alloc(65536)), 1);
    case "garbage":
      process.stdout.write("HTTP/1.1 200 OK\r\n\r\n");
      return hang();
    case "crash":
      return process.exit(9);
    case "hang":
      return hang();
    default:
      throw Error("modo desconocido: " + mode);
  }
}
