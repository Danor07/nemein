import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { apiFixture } from "../helpers/local-api.js";

test("Resuming SSE from every cursor yields exactly its strict suffix, including interrupted processing", async (t) => {
  const { budget, rule, stream } = await apiFixture(t);
  rule("events");
  let serial = 0;
  const receive = async (after, count) => {
    const s = await stream(after);
    try {
      await s.waitFor((frames) =>
        count
          ? frames.filter((f) => f.event === "budget-event").length >= count
          : frames.some((f) => f.raw === ": connected"),
      );
      const items = s.frames.filter((f) => f.event === "budget-event");
      for (const item of items) assert.equal(item.id, item.data.cursor);
      return items.map((f) => f.data);
    } finally {
      s.close();
      await s.finished;
    }
  };
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.string({ minLength: 1, maxLength: 30 }), {
        minLength: 1,
        maxLength: 8,
      }),
      fc.nat(),
      async (names, splitValue) => {
        const base = budget.eventSnapshot().cursor;
        for (const name of names)
          budget.createGroup({ name: "Fictional " + serial++ + name });
        const expected = budget
          .readEvents({ after: base })
          .events.map((e) => ({ version: 1, ...e }));
        const cursors = [base, ...expected.map((e) => e.cursor)];
        for (let i = 0; i < cursors.length; i++)
          assert.deepEqual(
            await receive(cursors[i], expected.length - i),
            expected.slice(i),
          );

        const split = splitValue % (expected.length + 1);
        const first = (await receive(base, expected.length)).slice(0, split);
        const resumed = await receive(cursors[split], expected.length - split);
        const processed = [...first, ...resumed];
        assert.deepEqual(processed, expected);
        assert.equal(
          new Set(processed.map((e) => e.event.source + " " + e.event.id)).size,
          expected.length,
        );
      },
    ),
    { seed: 903001, numRuns: 20 },
  );
});
