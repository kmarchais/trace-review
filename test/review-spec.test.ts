import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REVIEW_MODES,
  REVIEW_SPEC_VERSION,
  validateReviewSpec,
} from "../scripts/lib/review-spec.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "test", "fixtures");

test("review modes and schema version are stable public constants", () => {
  assert.equal(REVIEW_SPEC_VERSION, 1);
  assert.deepEqual(REVIEW_MODES, ["workspace", "lm-analysis", "deep-audit"]);
  const schema = JSON.parse(
    fs.readFileSync(path.join(root, "schemas", "review-spec.v1.schema.json"), "utf8"),
  );
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.properties.mode.enum, REVIEW_MODES);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("legacy focused-analysis mode names are rejected", () => {
  for (const mode of ["ai-analysis", "review"]) {
    const result = validateReviewSpec({
      schemaVersion: 1,
      mode,
      prs: [
        {
          title: "Legacy mode",
          diff: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n",
          review: { verdict: "approve", global: "Done.", comments: [] },
        },
      ],
    });
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some((item) => item.code === "invalid-mode"));
  }
});

test("provider-specific reviewer attribution is rejected", () => {
  const result = validateReviewSpec({
    schemaVersion: 1,
    mode: "lm-analysis",
    reviewer: "A model-provided identity",
    prs: [
      {
        title: "Neutral attribution",
        diff: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n",
        review: { verdict: "approve", global: "Done.", comments: [] },
      },
    ],
  });

  assert.equal(result.valid, false);
  assert.ok(
    result.diagnostics.some((item) => item.code === "unknown-field" && item.path === "reviewer"),
  );
});

test("portable block and diagram schemas enforce the runtime contract", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(root, "schemas", "review-spec.v1.schema.json"), "utf8"),
  );
  const diagram = schema.$defs.diagram;
  const block = schema.$defs.block;

  assert.equal(diagram.additionalProperties, false);
  assert.equal(block.additionalProperties, false);
  assert.equal(diagram.properties.svg.minLength, 1);
  assert.equal(block.properties.svg.minLength, 1);
  assert.ok(Array.isArray(block.allOf), "block variants should carry conditional requirements");
  assert.deepEqual(
    block.allOf.map((rule) => rule.if.properties.type.const),
    ["diagram", "stats", "table"],
  );

  const invalidBlocks = [
    { type: "diagram", svg: "<svg/>", surprise: true },
    { type: "diagram" },
    { type: "stats" },
    { type: "table" },
  ];
  for (const invalidBlock of invalidBlocks) {
    const result = validateReviewSpec({
      schemaVersion: 1,
      mode: "workspace",
      prs: [
        {
          title: "Invalid block",
          diff: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n",
          blocks: [invalidBlock],
        },
      ],
    });
    assert.equal(
      result.valid,
      false,
      `${invalidBlock.type} specimen should fail runtime validation`,
    );
  }
});

test("workspace and LM-analysis fixtures satisfy the versioned contract", () => {
  for (const name of ["workspace-spec.json", "lm-analysis-spec.json"]) {
    const spec = JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"));
    const result = validateReviewSpec(spec, { baseDir: fixtures, checkFiles: true });
    assert.deepEqual(result, { valid: true, schemaVersion: 1, diagnostics: [] });
  }
});

test("deep audit uses the explicit LM finding contract", () => {
  const spec = {
    schemaVersion: 1,
    mode: "deep-audit",
    prs: [
      {
        title: "Audit",
        diff: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n",
        review: { verdict: "approve", global: "Audited.", comments: [] },
      },
    ],
  };
  assert.equal(validateReviewSpec(spec).valid, true);
});

test("GitHub publication context requires a repository, PR number, and head commit", () => {
  const diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n";
  const valid = validateReviewSpec({
    schemaVersion: 1,
    mode: "workspace",
    prs: [
      {
        title: "Publishable review",
        url: "https://github.com/acme/widgets/pull/42",
        diff,
        github: {
          repository: "acme/widgets",
          pullRequest: 42,
          headSha: "abc123",
        },
      },
    ],
  });
  assert.equal(valid.valid, true);

  const invalid = validateReviewSpec({
    schemaVersion: 1,
    mode: "workspace",
    prs: [
      {
        title: "Incomplete publication target",
        diff,
        github: { repository: "acme/widgets", pullRequest: 0 },
      },
    ],
  });
  assert.equal(invalid.valid, false);
  assert.ok(
    invalid.diagnostics.some(
      (item) => item.path === "prs[0].github.headSha" && item.code === "expected-string",
    ),
  );
  assert.ok(
    invalid.diagnostics.some(
      (item) => item.path === "prs[0].github.pullRequest" && item.code === "invalid-pr-number",
    ),
  );
});

test("LM findings require confidence and rationale in rendered review specs", () => {
  const result = validateReviewSpec({
    schemaVersion: 1,
    mode: "lm-analysis",
    prs: [
      {
        title: "Focused analysis",
        diff: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n",
        review: {
          verdict: "comment",
          global: "One finding.",
          comments: [{ file: "a", line: 1, severity: "concern", body: "Issue." }],
        },
      },
    ],
  });

  assert.equal(result.valid, false);
  assert.ok(
    result.diagnostics.some((item) => item.path === "prs[0].review.comments[0].confidence"),
  );
  assert.ok(result.diagnostics.some((item) => item.path === "prs[0].review.comments[0].rationale"));
});

test("validator returns actionable paths and hints for contract violations", () => {
  const result = validateReviewSpec({
    schemaVersion: 2,
    mode: "workspace",
    prs: [
      {
        id: "same",
        title: "",
        diff: "patch",
        diffFile: "also.patch",
        groups: [
          { id: "one", title: "One", files: ["src/a.js"] },
          { id: "two", title: "Two", files: ["src/a.js"] },
        ],
        review: { comments: [{ file: "src/a.js", line: 0, body: "" }] },
        surprise: true,
      },
    ],
  });

  assert.equal(result.valid, false);
  assert.ok(
    result.diagnostics.some(
      (item) =>
        item.code === "unsupported-schema-version" && item.path === "schemaVersion" && item.hint,
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "invalid-diff-source" && item.path === "prs[0]",
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "overlapping-groups" && item.path === "prs[0].groups[1].files[0]",
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "review-not-allowed" && item.path === "prs[0].review",
    ),
  );
  assert.ok(result.diagnostics.some((item) => item.code === "invalid-line-anchor"));
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "unknown-field" && item.path === "prs[0].surprise",
    ),
  );
});

test("validation CLI emits machine-readable diagnostics and exits 2", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-spec-"));
  const specPath = path.join(tempDir, "invalid.json");
  fs.writeFileSync(specPath, JSON.stringify({ schemaVersion: 1, mode: "workspace", prs: [] }));
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "dist", "runtime", "scripts", "validate-review-spec.mjs"),
      "--spec",
      specPath,
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  const validation = JSON.parse(result.stdout);
  assert.equal(validation.valid, false);
  assert.equal(validation.diagnostics[0].code, "missing-pull-requests");
});

test("validation CLI accepts the comprehensive workspace fixture", () => {
  const output = execFileSync(
    process.execPath,
    [
      path.join(root, "dist", "runtime", "scripts", "validate-review-spec.mjs"),
      "--spec",
      path.join(fixtures, "workspace-spec.json"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(JSON.parse(output).valid, true);
});
