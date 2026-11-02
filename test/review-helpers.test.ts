import assert from "node:assert/strict";
import test from "node:test";

import {
  STATE_VERSION,
  hunkGaps,
  isTypingTarget,
  markdownCodeBlock,
  markdownFence,
  markdownListItem,
  normalizeStoredState,
  shortcutAction,
} from "../src/review-helpers.js";

test("markdown fences outgrow any backtick run in the code", () => {
  assert.equal(markdownFence("plain"), "```");
  assert.equal(markdownFence("a ``` b"), "````");
  assert.equal(markdownFence("````` five"), "``````");
  const block = markdownCodeBlock("const s = `x`;\n```", "ts");
  assert.equal(block, "  ````ts\n  const s = `x`;\n  ```\n  ````\n");
});

test("markdown list items keep multi-line bodies and suggestion blocks verbatim", () => {
  assert.equal(markdownListItem("**L3** —", "one line"), "- **L3** — one line\n");
  assert.equal(
    markdownListItem("**L3** —", "First line\n\n```suggestion\n    return x;\n```"),
    "- **L3** — First line\n\n  ```suggestion\n      return x;\n  ```\n",
  );
  assert.equal(
    markdownListItem("**L3** —", "```suggestion\nreturn x;\n```"),
    "- **L3** —\n  ```suggestion\n  return x;\n  ```\n",
  );
  assert.equal(markdownListItem("**File:**", "a\r\nb\n\n"), "- **File:** a\n  b\n");
});

test("hunk gaps locate rows hidden by a group filter", () => {
  const original = [
    { t: "d" as const, o: 7 },
    { t: "d" as const, o: 8 },
    { t: "a" as const, n: 7 },
    { t: "a" as const, n: 8 },
    { t: "a" as const, n: 9 },
  ];
  const shown = [original[1], original[3]];
  const gaps = hunkGaps(shown, original);
  assert.deepEqual(
    [...gaps.before],
    [
      [0, 1],
      [1, 1],
    ],
  );
  assert.equal(gaps.after, 1);

  // without the unfiltered hunk, numbering holes between shown rows are used
  const fallback = hunkGaps([
    { t: "c", o: 288, n: 289 },
    { t: "c", o: 294, n: 295 },
  ]);
  assert.deepEqual([...fallback.before], [[1, 5]]);
  assert.equal(fallback.after, 0);
  assert.equal(hunkGaps(original, original).before.size, 0);
});

test("shortcuts map keys and ignore typing targets and modifiers", () => {
  assert.equal(shortcutAction({ key: "j" }), "next-file");
  assert.equal(shortcutAction({ key: "k" }), "previous-file");
  assert.equal(shortcutAction({ key: "n" }), "next-finding");
  assert.equal(shortcutAction({ key: "p" }), "previous-finding");
  assert.equal(shortcutAction({ key: "v" }), "toggle-viewed");
  assert.equal(shortcutAction({ key: "c" }), "comment");
  assert.equal(shortcutAction({ key: "?" }), "help");
  assert.equal(shortcutAction({ key: "x" }), null);
  assert.equal(shortcutAction({ key: "1" }), "finding-option");
  assert.equal(shortcutAction({ key: "9" }), "finding-option");
  assert.equal(shortcutAction({ key: "0" }), null);
  assert.equal(shortcutAction({ key: "r" }), "finding-reply");
  assert.equal(shortcutAction({ key: "2", targetTag: "TEXTAREA" }), null);
  assert.equal(shortcutAction({ key: "j", ctrlKey: true }), null);
  assert.equal(shortcutAction({ key: "j", targetTag: "TEXTAREA" }), null);
  assert.equal(shortcutAction({ key: "j", targetTag: "INPUT", targetType: "search" }), null);
  assert.equal(shortcutAction({ key: "j", targetTag: "DIV", targetEditable: true }), null);
  assert.equal(
    shortcutAction({ key: "j", targetTag: "INPUT", targetType: "checkbox" }),
    "next-file",
  );
  assert.equal(isTypingTarget("select"), true);
  assert.equal(isTypingTarget("BUTTON"), false);
});

test("stored review state is versioned and validated defensively", () => {
  const empty = normalizeStoredState("not an object");
  assert.equal(empty.version, STATE_VERSION);
  assert.deepEqual(empty.lines, {});

  const state = normalizeStoredState({
    general: { pr: "overall", bad: 3 },
    lines: {
      ok: { pr: "pr", file: "a.ts", key: "4", text: "note" },
      noText: { pr: "pr", file: "a.ts", key: "5" },
      keyless: { pr: "pr", file: "a.ts", text: "x" },
    },
    viewed: { a: true, b: "yes" },
    grouping: { pr: "raw", other: "sideways" },
    attachments: { good: [{ name: "a", type: "image/png", data: "data:" }], bad: [{ name: 1 }] },
    aiState: [],
  });
  assert.deepEqual(state.general, { pr: "overall" });
  assert.deepEqual(Object.keys(state.lines), ["ok", "keyless"]);
  assert.equal(state.lines.keyless.key, "");
  assert.deepEqual(state.viewed, { a: true });
  assert.deepEqual(state.grouping, { pr: "raw" });
  assert.deepEqual(Object.keys(state.attachments), ["good"]);
  assert.deepEqual(state.aiState, {});
});
