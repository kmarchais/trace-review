import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectChangeGroups } from "../scripts/lib/change-groups.mjs";
import { finalizeLmGrouping, validateLmGroupingResult } from "../scripts/lib/lm-groups.mjs";
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
@@ -15 +17,2 @@
 export function refreshSession() {}
+export const retryLimit = 2;
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

test("LM grouping uses change-specific names and keeps same-group hunks together", () => {
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
        titleEvidence: {
          changeIds: [sourceIds[0]],
          rationale: "The cited source hunk introduces the session lifecycle entry point.",
        },
      },
      {
        title: "Lifecycle verification",
        intent: "Exercise the new session opening contract.",
        risk: "low",
        confidence: 0.94,
        evidence: ["The test imports the new entry point."],
        reviewerChecks: ["Confirm the assertion fails without the implementation."],
        changeIds: testIds,
        titleEvidence: {
          changeIds: [testIds[0]],
          rationale: "The cited test hunk verifies the lifecycle entry point.",
        },
        readAfter: ["Session lifecycle contract"],
      },
    ],
  };

  assert.equal(validateLmGroupingResult(result, facts).valid, true);
  const grouping = finalizeLmGrouping(result, facts);
  assert.equal(grouping.provenance, "lm");
  assert.deepEqual(
    grouping.groups.map((group) => group.title),
    ["Session lifecycle contract", "Lifecycle verification"],
  );
  assert.equal(
    grouping.groups[0].changes.filter((change) => change.file === "src/session.js").length,
    3,
  );
  assert.ok(
    grouping.dependencyGraph.nodes
      .find((node) => node.id === grouping.groups[0].id)
      .definitions.includes("openSession"),
  );
  assert.equal(grouping.validation.valid, true);
});

test("LM grouping allows one file to participate in distinct semantic groups", () => {
  const facts = candidates();
  const [firstSource, secondSource, thirdSource] = facts.inventory.filter(
    (change) => change.file === "src/session.js",
  );
  const [testChange] = facts.inventory.filter((change) => change.file === "test/session.test.js");
  const result = {
    groups: [
      {
        title: "Session opening contract",
        intent: "Review the session opening entry point.",
        risk: "medium",
        confidence: 0.8,
        evidence: ["One hunk."],
        reviewerChecks: ["Inspect it."],
        changeIds: [firstSource.id, secondSource.id],
        titleEvidence: {
          changeIds: [firstSource.id],
          rationale: "The cited hunk introduces session opening.",
        },
      },
      {
        title: "Session timeout policy",
        intent: "Review timeout behavior as a separate decision.",
        risk: "medium",
        confidence: 0.8,
        evidence: ["Another hunk."],
        reviewerChecks: ["Inspect it."],
        changeIds: [thirdSource.id],
        titleEvidence: {
          changeIds: [thirdSource.id],
          rationale: "The cited hunk introduces timeout behavior.",
        },
      },
      {
        title: "Session opening verification",
        intent: "Verify the opening contract.",
        risk: "low",
        confidence: 0.9,
        evidence: ["The test imports the opening entry point."],
        reviewerChecks: ["Confirm failure sensitivity."],
        changeIds: [testChange.id],
        titleEvidence: {
          changeIds: [testChange.id],
          rationale: "The cited test hunk verifies session opening.",
        },
      },
    ],
  };

  const validation = validateLmGroupingResult(result, facts);
  assert.equal(validation.valid, true);
  const grouping = finalizeLmGrouping(result, facts);
  assert.equal(
    grouping.groups.filter((group) =>
      group.changes.some((change) => change.file === "src/session.js"),
    ).length,
    2,
  );
});

test("LM grouping rejects generic classifier names", () => {
  const facts = candidates();
  const result = {
    groups: [
      {
        title: "Definitions and consumers",
        intent: "Classify the entire patch.",
        risk: "medium",
        confidence: 0.8,
        evidence: ["All changes are assigned."],
        reviewerChecks: ["Inspect the patch."],
        changeIds: facts.inventory.map((change) => change.id),
        titleEvidence: {
          changeIds: [facts.inventory[0].id],
          rationale: "The title refers to the patch.",
        },
      },
    ],
  };

  const validation = validateLmGroupingResult(result, facts);
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.some((item) => item.code === "generic-group-title"));
});

test("grouped rendering shows a multi-hunk file once per semantic group", (t) => {
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
          kind: "mechanical",
          intent: "Review lifecycle changes together.",
          risk: "medium",
          confidence: 0.9,
          evidence: ["Two hunks belong to one source file."],
          reviewerChecks: ["Review both lifecycle subtopics."],
          changeIds: sourceIds.slice(0, 2),
          titleEvidence: {
            changeIds: [sourceIds[0]],
            rationale: "The source hunk introduces the lifecycle contract.",
          },
        },
        {
          title: "Session retry policy",
          intent: "Review retry behavior as a separate source-file decision.",
          risk: "medium",
          confidence: 0.88,
          evidence: ["The later source hunk introduces a retry limit."],
          reviewerChecks: ["Check retry and timeout interaction."],
          changeIds: [sourceIds[2]],
          titleEvidence: {
            changeIds: [sourceIds[2]],
            rationale: "The cited hunk introduces the retry limit.",
          },
          readAfter: ["Session lifecycle contract"],
        },
        {
          title: "Lifecycle verification",
          intent: "Verify session opening.",
          risk: "low",
          confidence: 0.9,
          evidence: ["The test uses the new entry point."],
          reviewerChecks: ["Check failure sensitivity."],
          changeIds: testIds,
          titleEvidence: {
            changeIds: [testIds[0]],
            rationale: "The test hunk verifies the lifecycle contract.",
          },
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
      path.join(root, "dist", "runtime", "scripts", "build-review.mjs"),
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
  assert.equal([...grouped.matchAll(/data-file="src\/session\.js"/g)].length, 2);
  assert.match(grouped, /2 change units/);
  assert.match(grouped, /data-view-key="g1::src\/session\.js"/);
  assert.match(grouped, /data-view-key="g2::src\/session\.js"/);
  assert.match(html, /data-view-key="raw::src\/session\.js"/);
  assert.match(html, /function viewedId\(fileEl\)/);
  assert.match(html, /grouped \? "Items" : "Files"/);
  assert.match(html, /delete state\.viewed\[legacyId\]/);
  assert.match(html, /filter\(\(candidate\)\s*=>\s*candidate\.dataset\.viewKey\)/);
  assert.doesNotMatch(html, /state\.viewed\[id\] \|\| state\.viewed\[legacyId\]/);
  assert.doesNotMatch(grouped, /class="file collapsed"[^>]*data-file="src\/session\.js"/);
});

test("declared prerequisites determine suggested reading order", () => {
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
          title: "Lifecycle verification",
          intent: "Verify session opening.",
          risk: "low",
          confidence: 0.9,
          evidence: ["The test uses the new entry point."],
          reviewerChecks: ["Check failure sensitivity."],
          changeIds: testIds,
          titleEvidence: {
            changeIds: [testIds[0]],
            rationale: "The test hunk verifies lifecycle behavior.",
          },
          readAfter: ["Session lifecycle contract"],
        },
        {
          title: "Session lifecycle contract",
          intent: "Review lifecycle changes together.",
          risk: "medium",
          confidence: 0.9,
          evidence: ["Two hunks belong to one source file."],
          reviewerChecks: ["Review both lifecycle subtopics."],
          changeIds: sourceIds,
          titleEvidence: {
            changeIds: [sourceIds[0]],
            rationale: "The source hunk introduces the lifecycle contract.",
          },
        },
      ],
    },
    facts,
  );

  assert.deepEqual(grouping.dependencyGraph.suggestedOrder, ["g2", "g1"]);
});
