import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectChangeGroups } from "../scripts/lib/change-groups.mjs";
import {
  finalizeLmGrouping,
  validateLmGroupingResult,
} from "../scripts/lib/lm-groups.mjs";
import { analyzePatch } from "../scripts/lib/preflight.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const patch = `diff --git a/src/session.js b/src/session.js
index 1111111..2222222 100644
--- a/src/session.js
+++ b/src/session.js
@@ -1 +1,2 @@
 export const session = {};
+export function openSession() {}
@@ -8 +9,2 @@
 export function closeSession() {}
+export const timeout = 30;
diff --git a/test/session.test.js b/test/session.test.js
index 1111111..2222222 100644
--- a/test/session.test.js
+++ b/test/session.test.js
@@ -1 +1,2 @@
 import { openSession } from "../src/session.js";
+assert.ok(openSession);
`;

function candidates() {
  return detectChangeGroups(patch, analyzePatch(patch));
}

test("LM grouping uses change-specific names and keeps every file in one group", () => {
  const facts = candidates();
  const sourceIds = facts.inventory
    .filter((change) => change.file === "src/session.js")
    .map((change) => change.id);
  const testIds = facts.inventory
    .filter((change) => change.file === "test/session.test.js")
    .map((change) => change.id);
  const result = {
    groups: [
      {
        title: "Session lifecycle contract",
        intent: "Introduce opening and timeout behavior as one source-file decision.",
        risk: "medium",
        confidence: 0.91,
        evidence: ["The source file owns both lifecycle hunks."],
        reviewerChecks: ["Check lifecycle compatibility and timeout behavior."],
        changeIds: sourceIds,
      },
      {
        title: "Lifecycle verification",
        intent: "Exercise the new session opening contract.",
        risk: "low",
        confidence: 0.94,
        evidence: ["The test imports the new entry point."],
        reviewerChecks: ["Confirm the assertion fails without the implementation."],
        changeIds: testIds,
        readAfter: ["Session lifecycle contract"],
      },
    ],
  };

  assert.equal(validateLmGroupingResult(result, facts).valid, true);
  const grouping = finalizeLmGrouping(result, facts);
  assert.equal(grouping.provenance, "lm");
  assert.deepEqual(grouping.groups.map((group) => group.title), [
    "Session lifecycle contract",
    "Lifecycle verification",
  ]);
  assert.equal(
    grouping.groups[0].changes.filter((change) => change.file === "src/session.js").length,
    2,
  );
  assert.equal(grouping.validation.valid, true);
});

test("LM grouping rejects generic classifier names and split files", () => {
  const facts = candidates();
  const [firstSource, secondSource] = facts.inventory.filter(
    (change) => change.file === "src/session.js",
  );
  const result = {
    groups: [
      {
        title: "Definitions",
        intent: "First half.",
        risk: "medium",
        confidence: 0.8,
        evidence: ["One hunk."],
        reviewerChecks: ["Inspect it."],
        changeIds: [firstSource.id],
      },
      {
        title: "Consumers",
        intent: "Second half.",
        risk: "medium",
        confidence: 0.8,
        evidence: ["Another hunk."],
        reviewerChecks: ["Inspect it."],
        changeIds: [secondSource.id],
      },
    ],
  };

  const validation = validateLmGroupingResult(result, facts);
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.some((item) => item.code === "generic-group-title"));
  assert.ok(validation.diagnostics.some((item) => item.code === "split-file-across-groups"));
});

test("grouped rendering shows a multi-hunk file once", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-lm-groups-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const facts = candidates();
  const sourceIds = facts.inventory
    .filter((change) => change.file === "src/session.js")
    .map((change) => change.id);
  const testIds = facts.inventory
    .filter((change) => change.file === "test/session.test.js")
    .map((change) => change.id);
  const grouping = finalizeLmGrouping(
    {
      groups: [
        {
          title: "Session lifecycle contract",
          intent: "Review lifecycle changes together.",
          risk: "medium",
          confidence: 0.9,
          evidence: ["Two hunks belong to one source file."],
          reviewerChecks: ["Review both lifecycle subtopics."],
          changeIds: sourceIds,
        },
        {
          title: "Lifecycle verification",
          intent: "Verify session opening.",
          risk: "low",
          confidence: 0.9,
          evidence: ["The test uses the new entry point."],
          reviewerChecks: ["Check failure sensitivity."],
          changeIds: testIds,
        },
      ],
    },
    facts,
  );
  const diffPath = path.join(tempDir, "change.patch");
  const groupPath = path.join(tempDir, "groups.json");
  const specPath = path.join(tempDir, "spec.json");
  const outPath = path.join(tempDir, "review.html");
  fs.writeFileSync(diffPath, patch);
  fs.writeFileSync(groupPath, JSON.stringify(grouping));
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "workspace",
      title: "Semantic grouping",
      prs: [{ title: "Lifecycle", diffFile: "change.patch", groupFile: "groups.json" }],
    }),
  );

  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts", "build-review.mjs"),
      "--spec",
      specPath,
      "--out",
      outPath,
    ],
    { cwd: root },
  );
  const html = fs.readFileSync(outPath, "utf8");
  const grouped = html.slice(
    html.indexOf('data-order-view="grouped"'),
    html.indexOf('data-order-view="raw"'),
  );
  assert.equal(
    [...grouped.matchAll(/data-file="src\/session\.js"/g)].length,
    1,
  );
  assert.match(grouped, /2 change units/);
});
