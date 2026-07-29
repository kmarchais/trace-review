import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  detectChangeGroups,
  parsePatchChanges,
  validateGrouping,
} from "../scripts/lib/change-groups.mjs";
import { analyzePatch } from "../scripts/lib/preflight.mjs";
import { validateReviewSpec } from "../scripts/lib/review-spec.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const patch = `diff --git a/src/parse.js b/src/parse.js
index 1111111..2222222 100644
--- a/src/parse.js
+++ b/src/parse.js
@@ -1 +1,4 @@
 export const old = true;
+export function parse(value) {
+  return String(value);
+}
diff --git a/src/use.js b/src/use.js
index 1111111..2222222 100644
--- a/src/use.js
+++ b/src/use.js
@@ -1 +1,2 @@
 import { parse } from "./parse.js";
+console.log(parse(42));
diff --git a/src/a.cpp b/src/a.cpp
index 1111111..2222222 100644
--- a/src/a.cpp
+++ b/src/a.cpp
@@ -1 +1,2 @@
 int a;
+#include "trace.h"
diff --git a/src/b.cpp b/src/b.cpp
index 1111111..2222222 100644
--- a/src/b.cpp
+++ b/src/b.cpp
@@ -1 +1,2 @@
 int b;
+#include "trace.h"
diff --git a/src/mixed.cpp b/src/mixed.cpp
index 1111111..2222222 100644
--- a/src/mixed.cpp
+++ b/src/mixed.cpp
@@ -1 +1,3 @@
 int mixed;
+#include "trace.h"
+int behavior = 42;
diff --git a/test/parse.test.js b/test/parse.test.js
index 1111111..2222222 100644
--- a/test/parse.test.js
+++ b/test/parse.test.js
@@ -1 +1,2 @@
 import { parse } from "../src/parse.js";
+assert.equal(parse(1), "1");
diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-{"scripts":{}}
+{"scripts":{"test":"node --test"}}
`;

test("detects hunk-level groups with rationale, dependencies, and full coverage", () => {
  const grouping = detectChangeGroups(patch, analyzePatch(patch));

  assert.equal(grouping.schemaVersion, 1);
  assert.equal(grouping.validation.valid, true);
  assert.equal(grouping.groups.flatMap((group) => group.changes).length, grouping.inventory.length);
  const includes = grouping.groups.find((group) => group.title.startsWith("Repeat #include"));
  assert.equal(includes.changes.length, 3);
  assert.ok(includes.changes.some((change) => change.file === "src/mixed.cpp"));
  assert.ok(
    includes.changes
      .find((change) => change.file === "src/mixed.cpp")
      ?.rows.every((row) => row.includes(":a")),
  );
  assert.equal(includes.confidence, 1);
  assert.ok(includes.evidence.length);
  assert.ok(includes.reviewerChecks.length);
  assert.ok(grouping.groups.some((group) => group.title === "Definitions"));
  assert.ok(grouping.groups.some((group) => group.title === "Associated tests"));
  assert.ok(grouping.dependencyGraph.edges.some((edge) => edge.reason === "definition-usage"));
  assert.ok(grouping.dependencyGraph.edges.some((edge) => edge.reason === "associated-tests"));
  assert.equal(
    grouping.dependencyGraph.suggestedOrder.at(-1),
    grouping.groups.find((group) => group.title === "Associated tests").id,
  );
});

test("extracts repeated rows from mixed hunks without duplicating them in substantive groups", () => {
  const mixedRepeatedPatch = ["a", "b", "c"]
    .map(
      (name, index) => `diff --git a/src/${name}.cpp b/src/${name}.cpp
--- a/src/${name}.cpp
+++ b/src/${name}.cpp
@@ -1 +1,3 @@
 int ${name};
+enableNewCache();
+int value = ${index};
`,
    )
    .join("");

  const grouping = detectChangeGroups(mixedRepeatedPatch, analyzePatch(mixedRepeatedPatch));
  const repeated = grouping.groups.find((group) => group.title.includes("enableNewCache"));

  assert.ok(repeated);
  assert.equal(repeated.kind, "mechanical");
  assert.equal(repeated.changes.length, 3);
  assert.ok(repeated.changes.every((change) => change.rows?.length === 1));
  const repeatedRowIds = new Set(repeated.changes.flatMap((change) => change.rows || []));
  const otherRowIds = grouping.groups
    .filter((group) => group !== repeated)
    .flatMap((group) => group.changes)
    .flatMap((change) => change.rows || []);
  assert.ok(otherRowIds.every((rowId) => !repeatedRowIds.has(rowId)));
  assert.equal(grouping.validation.valid, true);
});

test("rejects overlapping and missing assignments instead of hiding them", () => {
  const inventory = parsePatchChanges(patch, analyzePatch(patch));
  const grouping = detectChangeGroups(patch, analyzePatch(patch));
  grouping.groups[1].changes.push(grouping.groups[0].changes[0]);
  grouping.groups.at(-1).changes = [];

  const validation = validateGrouping(grouping, inventory);
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.some((diagnostic) => diagnostic.code === "overlapping-change"));
  assert.ok(validation.diagnostics.some((diagnostic) => diagnostic.code === "unclassified-change"));
});

test("quoted paths remain visible and formatting detection preserves string whitespace", () => {
  const quotedPatch = fs.readFileSync(
    path.join(root, "test", "fixtures", "quoted-path.patch"),
    "utf8",
  );
  const quoted = detectChangeGroups(quotedPatch, analyzePatch(quotedPatch));
  assert.equal(quoted.validation.valid, true);
  assert.equal(quoted.inventory.length, 1);
  assert.equal(quoted.inventory[0].file, "café.js");

  const semanticWhitespace = `diff --git a/src/message.js b/src/message.js
index 1111111..2222222 100644
--- a/src/message.js
+++ b/src/message.js
@@ -1 +1 @@
-const message = "a b";
+const message = "ab";
`;
  const semantic = detectChangeGroups(semanticWhitespace, analyzePatch(semanticWhitespace));
  assert.ok(!semantic.groups.some((group) => group.title === "Formatting-only changes"));

  const indentationOnly = semanticWhitespace
    .replace('const message = "a b";', '  const message = "a b";')
    .replace('const message = "ab";', '\tconst message = "a b";');
  const formatting = detectChangeGroups(indentationOnly, analyzePatch(indentationOnly));
  assert.equal(
    formatting.groups.find((group) => group.title === "Formatting-only changes").changes.length,
    1,
  );
});

test("hunk ranges retain zero-count sides for anchor validation", () => {
  const insertion = `diff --git a/src/new.js b/src/new.js
index 1111111..2222222 100644
--- a/src/new.js
+++ b/src/new.js
@@ -4,0 +5 @@
+const added = true;
`;
  const [change] = parsePatchChanges(insertion, analyzePatch(insertion));

  assert.deepEqual(change.oldRange, { start: 4, end: 4, count: 0 });
  assert.deepEqual(change.newRange, { start: 5, end: 5, count: 1 });
});

test("CLI writes a validated group fact pack", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-groups-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const diffPath = path.join(tempDir, "change.patch");
  const outPath = path.join(tempDir, "groups.json");
  fs.writeFileSync(diffPath, patch);

  execFileSync(
    process.execPath,
    [
      path.join(root, "dist", "runtime", "scripts", "detect-mechanical-groups.mjs"),
      "--diff",
      diffPath,
      "--out",
      outPath,
    ],
    { cwd: root },
  );

  const result = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(result.validation.valid, true);
  assert.ok(result.dependencyGraph.suggestedOrder.length > 0);
  assert.ok(result.groups.flatMap((group) => group.changes).every((change) => change.topic));
});

test("builder consumes group files as reviewer-visible, read-only decisions", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-build-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const diffPath = path.join(tempDir, "change.patch");
  const groupPath = path.join(tempDir, "groups.json");
  const specPath = path.join(tempDir, "spec.json");
  const outPath = path.join(tempDir, "review.html");
  fs.writeFileSync(diffPath, patch);
  fs.writeFileSync(groupPath, JSON.stringify(detectChangeGroups(patch, analyzePatch(patch))));
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "workspace",
      title: "Grouping review",
      prs: [
        {
          title: "Phase 2",
          diffFile: "change.patch",
          groupFile: "groups.json",
        },
      ],
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
  const embeddedData =
    /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(embeddedData);
  const renderedFiles = Object.entries(
    JSON.parse(embeddedData[1]) as Record<
      string,
      { path: string; hunks: Array<{ rows: Array<{ c: string }> }> }
    >,
  )
    .filter(([key]) => key.includes("__cg"))
    .map(([, file]) => file);
  const mixedViews = renderedFiles.filter((file) => file.path === "src/mixed.cpp");
  const includeView = mixedViews.find((file) =>
    file.hunks.some((hunk) => hunk.rows.some((row) => row.c.includes('#include "trace.h"'))),
  );
  const behaviorView = mixedViews.find((file) =>
    file.hunks.some((hunk) => hunk.rows.some((row) => row.c.includes("int behavior = 42"))),
  );
  assert.ok(includeView);
  assert.ok(behaviorView);
  assert.ok(
    !includeView.hunks.some((hunk) => hunk.rows.some((row) => row.c.includes("int behavior = 42"))),
  );
  assert.ok(
    !behaviorView.hunks.some((hunk) =>
      hunk.rows.some((row) => row.c.includes('#include "trace.h"')),
    ),
  );
  assert.doesNotMatch(html, /Suggested reading order/);
  assert.doesNotMatch(html, /change-group-select/);
  assert.match(html, /Reviewer checks/);
  assert.doesNotMatch(html, /Grouping corrections/);
  assert.match(html, /class="change-range"[^>]*title=/);
  assert.match(html, /data-change=/);
  assert.match(html, /class="ft-topic"/);
  assert.match(html, /paste a screenshot directly into this comment/i);
  assert.match(html, /attachmentMarkdown/);
  assert.match(html, /class="group-intent-card"/);
  assert.doesNotMatch(html, /Read first/);
  assert.doesNotMatch(html, /Dependent changes/);
  const consumerStart = html.indexOf('class="group-title">Consumers');
  const consumerEnd = html.indexOf('class="group gk-', consumerStart + 1);
  assert.ok(consumerStart > -1, "consumer group should render");
  assert.match(html.slice(consumerStart, consumerEnd), /<code>parse<\/code>/);
  assert.match(html, /data-order-view="grouped"/);
  assert.match(html, /data-order-view="raw"/);
  assert.match(html, /class="raw-order-toggle"/);
});

test("dependent groups preview the definition when source-group usage appears first", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-definition-preview-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const diffPath = path.join(tempDir, "consumer-first.patch");
  const specPath = path.join(tempDir, "spec.json");
  const outPath = path.join(tempDir, "review.html");
  const consumerFirst = `diff --git a/src/use.js b/src/use.js
index 1111111..2222222 100644
--- a/src/use.js
+++ b/src/use.js
@@ -1 +1,2 @@
 import { parse } from "./parse.js";
+console.log(parse(42));
diff --git a/src/helpers.js b/src/helpers.js
index 1111111..2222222 100644
--- a/src/helpers.js
+++ b/src/helpers.js
@@ -0,0 +1 @@
+export function helper() { return parse(1); }
diff --git a/src/parse.js b/src/parse.js
index 1111111..2222222 100644
--- a/src/parse.js
+++ b/src/parse.js
@@ -1 +1,4 @@
 export const old = true;
+export function parse(value) {
+  return String(value);
+}
`;
  fs.writeFileSync(diffPath, consumerFirst);
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "workspace",
      title: "Consumer-first definition preview",
      prs: [{ title: "Preview", diffFile: "consumer-first.patch", autoGroups: true }],
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
  const consumerStart = html.indexOf('class="group-title">Consumers');
  const previewStart = html.indexOf('class="definition-preview"', consumerStart);
  const previewEnd = html.indexOf("</details>", previewStart);
  const preview = html.slice(previewStart, previewEnd);
  assert.match(preview, /export function parse\(value\) \{/);
  assert.doesNotMatch(preview, /console\.log\(parse\(42\)\)/);
  assert.doesNotMatch(preview, /function helper/);
});

test("review-spec validation accepts one Phase 2 group source and rejects ambiguity", () => {
  const base = {
    schemaVersion: 1,
    mode: "workspace",
    prs: [{ title: "Grouped", diff: patch, autoGroups: true }],
  };
  assert.equal(validateReviewSpec(base, { checkFiles: false }).valid, true);

  const ambiguous = structuredClone(base);
  ambiguous.prs[0].changeGroups = { schemaVersion: 1, groups: [] };
  const result = validateReviewSpec(ambiguous, { checkFiles: false });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "multiple-group-sources"));
});
