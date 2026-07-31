import { test } from "bun:test";
import assert from "node:assert/strict";

import { partitionRowsAtLineGaps } from "../src/diff-gaps.js";

test("separates projected rows when omitted additions leave new-line gaps", () => {
  const rows = [
    { t: "c", o: 19, n: 20 },
    { t: "c", o: 20, n: 21 },
    { t: "c", o: 21, n: 22 },
    { t: "a", n: 33 },
    { t: "a", n: 38 },
    { t: "a", n: 47 },
    { t: "c", o: 22, n: 61 },
  ];

  assert.deepEqual(
    partitionRowsAtLineGaps(rows).map((segment) => segment.map((row) => row.n)),
    [[20, 21, 22], [33], [38], [47], [61]],
  );
});

test("keeps an ordinary replacement in one continuous segment", () => {
  const rows = [
    { t: "c", o: 1, n: 1 },
    { t: "d", o: 2 },
    { t: "a", n: 2 },
    { t: "c", o: 3, n: 3 },
  ];

  assert.equal(partitionRowsAtLineGaps(rows).length, 1);
});
