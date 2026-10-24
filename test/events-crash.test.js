import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openBudget } from "../src/core.js";

test("events: abrupt exit preserves committed pair and discards uncommitted pair", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nemein-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let b = openBudget(dir);
  const after = b.eventSnapshot().cursor;
  b.close();
  const core = new URL("../src/core.js", import.meta.url).href;
  for (const mode of ["rollback", "commit"]) {
    const program = `import {openBudget} from ${JSON.stringify(core)};
      const b=openBudget(process.argv[1]);
      if(process.argv[2]==="rollback") b.db.transaction(()=>{
        b.createGroup({name:"Uncommitted"});
        process.exit(17);
      })();
      else {b.createGroup({name:"Committed"});process.exit(17);}`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", program, dir, mode],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(child.status, 17, child.stderr);
    b = openBudget(dir);
    try {
      const page = b.readEvents({ after });
      assert.equal(page.events.length, mode === "commit" ? 1 : 0);
      assert.equal(
        b.snapshot().groups.some((x) => x.name === "Uncommitted"),
        false,
      );
      assert.equal(
        b.snapshot().groups.some((x) => x.name === "Committed"),
        mode === "commit",
      );
    } finally {
      b.close();
    }
  }
});
