import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analysisResultToReview,
  prepareAnalysisInput,
  validateAnalysisResult,
} from "../scripts/lib/lm-analysis.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const context = {
  schemaVersion: 1,
  source: "github",
  selection: { mode: "auto", requested: "auto" },
  repository: {
    root: "C:/work/widgets",
    nameWithOwner: "acme/widgets",
    branch: "feature/widgets",
    headSha: "abc123",
  },
  pullRequest: {
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    title: "Harden widget parsing",
    body: "Reject malformed widget records.",
    labels: ["bug"],
    checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    reviews: [],
    comments: [],
    reviewComments: [],
  },
  preflight: {
    totals: { files: 1, additions: 3, deletions: 1, bytes: 240 },
    patch: { valid: true, gitApply: { valid: true }, diagnostics: [] },
    files: [{ path: "src/widget.js", additions: 3, deletions: 1, type: "javascript" }],
    whitespaceErrors: [],
  },
  changeGroups: {
    schemaVersion: 1,
    groups: [{
      id: "g1",
      title: "Definitions",
      intent: "Change widget parsing.",
      evidence: ["One definition changed."],
      risk: "medium",
      confidence: 0.82,
      reviewerChecks: ["Check malformed records."],
      changes: [{
        id: "src/widget.js#h0",
        file: "src/widget.js",
        hunk: 0,
        topic: "parseWidget",
        oldRange: { start: 1, end: 3, count: 3 },
        newRange: { start: 1, end: 5, count: 5 },
      }],
    }],
    dependencyGraph: { nodes: [], edges: [], suggestedOrder: ["g1"] },
    inventory: [{
      id: "src/widget.js#h0",
      file: "src/widget.js",
      hunk: 0,
      oldRange: { start: 1, end: 3, count: 3 },
      newRange: { start: 1, end: 5, count: 5 },
    }],
    validation: { valid: true, diagnostics: [] },
  },
  diff: {
    path: "context.patch",
    source: "github",
    bytes: 240,
  },
  validation: { valid: true, diagnostics: [] },
};

test("focused LM analysis receives compact facts and candidate groups, not raw diff text", () => {
  const input = prepareAnalysisInput(context, { mode: "lm-analysis" });

  assert.equal(input.schemaVersion, 1);
  assert.equal(input.mode, "lm-analysis");
  assert.equal(input.target.title, "Harden widget parsing");
  assert.equal(input.diff.path, "context.patch");
  assert.equal(input.facts.preflight.totals.files, 1);
  assert.equal(input.facts.changeGroups.groups[0].changes[0].topic, "parseWidget");
  assert.equal(input.findingContract.maxFindings, 3);
  assert.deepEqual(input.findingContract.required, [
    "file",
    "line",
    "severity",
    "body",
    "confidence",
    "rationale",
  ]);
  assert.equal("raw" in input.diff, false);
  assert.equal(JSON.stringify(input).includes("diff --git"), false);
});

test("legacy focused-analysis names are rejected", () => {
  for (const mode of ["ai-analysis", "review"]) {
    assert.throws(
      () => prepareAnalysisInput(context, { mode }),
      /Analysis mode must be one of: lm-analysis, deep-audit/,
    );
  }
});

test("focused analysis rejects missing or invalid deterministic facts", () => {
  assert.throws(
    () => prepareAnalysisInput({}, { mode: "lm-analysis" }),
    /valid preflight fact pack/i,
  );
  const invalidGroups = structuredClone(context);
  invalidGroups.changeGroups.validation.valid = false;
  assert.throws(
    () => prepareAnalysisInput(invalidGroups, { mode: "lm-analysis" }),
    /valid candidate groups/i,
  );
});

test("LM findings require confidence and a brief rationale", () => {
  const input = prepareAnalysisInput(context, { mode: "lm-analysis" });
  const validation = validateAnalysisResult({
    verdict: "comment",
    global: "One issue needs attention.",
    findings: [{
      file: "src/widget.js",
      line: 3,
      severity: "concern",
      body: "Malformed records can still pass.",
    }],
  }, input);

  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.some((item) => item.path === "findings[0].confidence"));
  assert.ok(validation.diagnostics.some((item) => item.path === "findings[0].rationale"));
});

test("focused analysis rejects findings beyond its fact-derived budget", () => {
  const input = prepareAnalysisInput(context, { mode: "lm-analysis" });
  const finding = {
    file: "src/widget.js",
    line: 3,
    severity: "concern",
    body: "Malformed records can still pass.",
    confidence: 0.9,
    rationale: "The new branch returns before validating the record shape.",
  };
  const validation = validateAnalysisResult({
    verdict: "request-changes",
    global: "Too many findings.",
    findings: Array.from({ length: 4 }, () => ({ ...finding })),
  }, input);

  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.some((item) => item.code === "finding-budget-exceeded"));
});

test("finding anchors must resolve to an actual changed hunk range", () => {
  const input = prepareAnalysisInput(context, { mode: "lm-analysis" });
  const result = {
    verdict: "request-changes",
    global: "One issue needs attention.",
    findings: [{
      file: "src/widget.js",
      line: 999,
      severity: "concern",
      body: "This anchor is outside the change.",
      confidence: 0.9,
      rationale: "The line does not exist in any changed hunk.",
    }],
  };

  const validation = validateAnalysisResult(result, input);
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.some((item) => item.code === "anchor-not-in-diff"));

  result.findings[0].line = "o2";
  assert.equal(validateAnalysisResult(result, input).valid, true);

  const insertion = structuredClone(input);
  insertion.facts.changeGroups.inventory[0].oldRange = {
    start: 4,
    end: 4,
    count: 0,
  };
  result.findings[0].line = "o4";
  assert.ok(
    validateAnalysisResult(result, insertion).diagnostics.some(
      (item) => item.code === "anchor-not-in-diff",
    ),
  );
});

test("deep audit is reserved for explicit requests or high-risk changes", () => {
  assert.throws(
    () => prepareAnalysisInput(context, { mode: "deep-audit" }),
    /requires --explicit or a high-risk fact pack/i,
  );
});

test("deep audit opens for a high-risk group or an explicit request", () => {
  const highRisk = structuredClone(context);
  highRisk.changeGroups.groups[0].risk = "high";

  assert.equal(
    prepareAnalysisInput(highRisk, { mode: "deep-audit" }).risk.level,
    "high",
  );
  assert.equal(
    prepareAnalysisInput(context, {
      mode: "deep-audit",
      explicitDeepAudit: true,
    }).mode,
    "deep-audit",
  );
});

test("prepare-lm-analysis CLI writes the validated focused fact pack", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-analysis-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const contextPath = path.join(tempDir, "context.json");
  const outputPath = path.join(tempDir, "analysis", "analysis-input.json");
  fs.writeFileSync(contextPath, JSON.stringify(context));

  const result = spawnSync(process.execPath, [
    path.join(root, "scripts", "prepare-lm-analysis.mjs"),
    "--context", contextPath,
    "--out", outputPath,
  ], { cwd: root, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(output.mode, "lm-analysis");
  assert.equal(output.diff.path, "../context.patch");
  assert.equal(output.facts.changeGroups.validation.valid, true);
  assert.equal(output.findingContract.maxFindings, 3);
});

test("a validated analysis result converts directly to a review-spec review", () => {
  const input = prepareAnalysisInput(context, { mode: "lm-analysis" });
  const result = {
    verdict: "request-changes",
    global: "One issue needs attention.",
    findings: [{
      file: "src/widget.js",
      line: 3,
      severity: "concern",
      body: "Malformed records can still pass.",
      confidence: 0.9,
      rationale: "The new branch returns before validating the record shape.",
    }],
  };

  assert.deepEqual(analysisResultToReview(result, input), {
    verdict: "request-changes",
    global: "One issue needs attention.",
    comments: result.findings,
  });
});

test("finalize-lm-analysis CLI rejects noise and writes review-spec output", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-result-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, "analysis-input.json");
  const resultPath = path.join(tempDir, "analysis-result.json");
  const outputPath = path.join(tempDir, "review.json");
  const input = prepareAnalysisInput(context, { mode: "lm-analysis" });
  const result = {
    verdict: "approve",
    global: "No actionable issues.",
    findings: [],
  };
  fs.writeFileSync(inputPath, JSON.stringify(input));
  fs.writeFileSync(resultPath, JSON.stringify(result));

  const cli = spawnSync(process.execPath, [
    path.join(root, "scripts", "finalize-lm-analysis.mjs"),
    "--input", inputPath,
    "--result", resultPath,
    "--out", outputPath,
  ], { cwd: root, encoding: "utf8" });

  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), {
    verdict: "approve",
    global: "No actionable issues.",
    comments: [],
  });
});
