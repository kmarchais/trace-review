import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "runtime", "scripts", "trace-review.mjs");

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test("prepare and finish provide one bounded orchestration path", (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-flow-"));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));

  run("git", ["init", "-b", "main"], repository);
  run("git", ["config", "user.email", "test@example.com"], repository);
  run("git", ["config", "user.name", "Trace Review Test"], repository);
  fs.writeFileSync(path.join(repository, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], repository);
  run("git", ["commit", "-m", "Initial"], repository);
  fs.writeFileSync(path.join(repository, "app.js"), "export const value = 2;\n");

  const prepared = run(
    process.execPath,
    [cli, "prepare", "--repo", repository, "--pr", "none", "--base", "HEAD", "--mode", "lm"],
    repository,
  );
  assert.match(prepared.stdout, /Write one combined result/);

  const reviewDir = path.join(repository, ".review");
  const inputPath = path.join(reviewDir, "analysis-input.json");
  const resultPath = path.join(reviewDir, "review-result.json");
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const changeIds = input.facts.changeGroups.inventory.map((change: { id: string }) => change.id);

  assert.equal(input.mode, "lm-analysis");
  assert.equal(input.target.branch, "main");
  assert.equal(input.resultContract.reviewRequired, true);
  assert.equal(input.workflow.patch, "context.patch");
  assert.ok(changeIds.length > 0);
  assert.match(
    fs.readFileSync(path.join(repository, ".git", "info", "exclude"), "utf8"),
    /^\.review\/$/m,
  );
  assert.doesNotMatch(run("git", ["status", "--short"], repository).stdout, /\.review/);

  fs.writeFileSync(
    resultPath,
    `${JSON.stringify(
      {
        summary: "Updates the exported application value.",
        groups: [
          {
            title: "Application value update",
            intent: "Review the exported value change as one decision.",
            risk: "low",
            confidence: 0.95,
            evidence: ["The application export is the only changed unit."],
            reviewerChecks: ["Confirm consumers expect the new value."],
            titleEvidence: {
              changeIds: [changeIds[0]],
              rationale: "The changed hunk directly updates the application value.",
            },
            changeIds,
            readAfter: [],
          },
        ],
        review: {
          verdict: "comment",
          global: "The focused change is internally consistent.",
          findings: [],
        },
      },
      null,
      2,
    )}\n`,
  );

  run(process.execPath, [cli, "finish", "--input", inputPath, "--result", resultPath], repository);

  assert.ok(fs.statSync(path.join(reviewDir, "review-lm-analysis-main.html")).size > 0);
  const spec = JSON.parse(fs.readFileSync(path.join(reviewDir, "spec.json"), "utf8"));
  const metrics = JSON.parse(fs.readFileSync(path.join(reviewDir, "run-metrics.json"), "utf8"));
  assert.equal(spec.mode, "lm-analysis");
  assert.equal(spec.prs[0].review.verdict, "comment");
  assert.equal(metrics.expectedAgentActions, 5);
  assert.equal(metrics.prepare.internalCommands, 3);
  assert.equal(metrics.finish.internalCommands, 3);
});

test("refine applies adaptive detector rules before semantic grouping", (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-refine-"));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));

  run("git", ["init", "-b", "main"], repository);
  run("git", ["config", "user.email", "test@example.com"], repository);
  run("git", ["config", "user.name", "Trace Review Test"], repository);
  for (const name of ["a", "b", "c"]) {
    fs.writeFileSync(
      path.join(repository, `${name}.h`),
      `#ifndef ${name.toUpperCase()}_H\n#define ${name.toUpperCase()}_H\nfloat value;\n#endif // ${name.toUpperCase()}_H\n`,
    );
  }
  run("git", ["add", "a.h", "b.h", "c.h"], repository);
  run("git", ["commit", "-m", "Initial"], repository);
  for (const name of ["a", "b", "c"]) {
    fs.writeFileSync(path.join(repository, `${name}.h`), "#pragma once\nScalar value;\n");
  }

  run(
    process.execPath,
    [cli, "prepare", "--repo", repository, "--pr", "none", "--base", "HEAD", "--mode", "lm"],
    repository,
  );
  const reviewDir = path.join(repository, ".review");
  const inputPath = path.join(reviewDir, "analysis-input.json");
  const rulesPath = path.join(reviewDir, "detector-rules.json");
  fs.writeFileSync(
    rulesPath,
    `${JSON.stringify({
      schemaVersion: 1,
      rules: [
        {
          id: "header-guards",
          title: "Replace header guards",
          minimumFiles: 3,
          operations: [
            { side: "add", pattern: "# pragma once", location: "start" },
            { side: "delete", pattern: "# ifndef $guard", location: "start" },
            { side: "delete", pattern: "# define $guard", location: "start" },
            { side: "delete", pattern: "# endif // $guard", location: "end" },
          ],
        },
      ],
    })}\n`,
  );

  run(process.execPath, [cli, "refine", "--input", inputPath, "--rules", rulesPath], repository);

  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const adaptiveGroup = input.facts.changeGroups.groups.find(
    (group: { title: string }) => group.title === "Replace header guards",
  );
  const metrics = JSON.parse(fs.readFileSync(path.join(reviewDir, "run-metrics.json"), "utf8"));
  assert.ok(adaptiveGroup);
  assert.equal(adaptiveGroup.changes.length, 3);
  assert.ok(adaptiveGroup.changes.every((change: { rows: string[] }) => change.rows.length === 4));
  assert.equal(input.adaptiveDetection.ruleCount, 1);
  assert.equal(metrics.expectedAgentActions, 7);

  const resultPath = path.join(reviewDir, "review-result.json");
  fs.writeFileSync(
    resultPath,
    `${JSON.stringify({
      summary: "Updates repeated header patterns and scalar declarations.",
      groups: input.facts.changeGroups.groups.map(
        (
          group: {
            title: string;
            kind: string;
            risk: string;
            confidence: number;
            changes: Array<{ id: string }>;
          },
          index: number,
        ) => ({
          title: group.title,
          kind: group.kind,
          intent: `Review repeated decision ${index + 1}.`,
          risk: group.risk,
          confidence: group.confidence,
          evidence: [`The deterministic detector found ${group.changes.length} occurrences.`],
          reviewerChecks: ["Confirm every occurrence matches the inferred transformation."],
          titleEvidence: {
            changeIds: [group.changes[0].id],
            rationale: "The cited occurrence grounds the repeated-change title.",
          },
          changeIds: group.changes.map((change) => change.id),
          readAfter: [],
        }),
      ),
      review: {
        verdict: "comment",
        global: "The repeated transformations remain isolated.",
        findings: [],
      },
    })}\n`,
  );
  run(process.execPath, [cli, "finish", "--input", inputPath, "--result", resultPath], repository);
  const finishedMetrics = JSON.parse(
    fs.readFileSync(path.join(reviewDir, "run-metrics.json"), "utf8"),
  );
  assert.ok(fs.statSync(path.join(reviewDir, "review-lm-analysis-main.html")).size > 0);
  assert.equal(finishedMetrics.expectedAgentActions, 7);
});

test("the command defaults to a quick workspace review", (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-quick-"));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));

  run("git", ["init", "-b", "main"], repository);
  run("git", ["config", "user.email", "test@example.com"], repository);
  run("git", ["config", "user.name", "Trace Review Test"], repository);
  fs.writeFileSync(path.join(repository, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], repository);
  run("git", ["commit", "-m", "Initial"], repository);
  fs.writeFileSync(path.join(repository, "app.js"), "export const value = 2;\n");

  const result = run(process.execPath, [cli, "--repo", repository, "--no-open"], repository);

  const reviewDir = path.join(repository, ".review");
  const reviewResult = JSON.parse(
    fs.readFileSync(path.join(reviewDir, "review-result.json"), "utf8"),
  );
  assert.match(result.stdout, /Existing review files: none/);
  assert.match(result.stdout, /Built .*review-working-tree-changes\.html/);
  assert.ok(fs.statSync(path.join(reviewDir, "review-working-tree-changes.html")).size > 0);
  assert.match(reviewResult.summary, /1 changed file/);
  assert.ok(reviewResult.groups.length > 0);
  assert.equal(reviewResult.review, undefined);
  const grouping = JSON.parse(fs.readFileSync(path.join(reviewDir, "groups.json"), "utf8"));
  assert.equal(grouping.provenance, "deterministic");
  assert.doesNotMatch(
    fs.readFileSync(path.join(reviewDir, "review-working-tree-changes.html"), "utf8"),
    /Suggested reading order/,
  );
});

test(
  "quick review accepts two Git revisions and reads files from the ending revision",
  { timeout: 10_000 },
  (t) => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-revisions-"));
    t.after(() => fs.rmSync(repository, { recursive: true, force: true }));

    run("git", ["init", "-b", "main"], repository);
    run("git", ["config", "user.email", "test@example.com"], repository);
    run("git", ["config", "user.name", "Trace Review Test"], repository);
    fs.writeFileSync(path.join(repository, "app.js"), "export const value = 1;\n");
    run("git", ["add", "app.js"], repository);
    run("git", ["commit", "-m", "Initial"], repository);
    run("git", ["switch", "-c", "feature"], repository);
    fs.writeFileSync(path.join(repository, "app.js"), "export const value = 2;\n");
    run("git", ["add", "app.js"], repository);
    run("git", ["commit", "-m", "Feature"], repository);
    run("git", ["switch", "main"], repository);

    run(process.execPath, [cli, "main", "feature", "--repo", repository, "--no-open"], repository);

    const reviewDir = path.join(repository, ".review");
    const context = JSON.parse(fs.readFileSync(path.join(reviewDir, "context.json"), "utf8"));
    const fileContents = JSON.parse(
      fs.readFileSync(path.join(reviewDir, "context.files.json"), "utf8"),
    );
    assert.deepEqual(context.git.diffArgs, ["main", "feature"]);
    assert.equal(context.git.diffLabel, "main ↔ feature");
    assert.match(fs.readFileSync(path.join(reviewDir, "context.patch"), "utf8"), /value = 2/);
    assert.equal(fileContents.files[0].content, "export const value = 2;\n");
    assert.ok(fs.statSync(path.join(reviewDir, "review-main-feature.html")).size > 0);

    const second = run(
      process.execPath,
      [cli, "main...feature", "--repo", repository, "--no-open"],
      repository,
    );
    const rangeContext = JSON.parse(fs.readFileSync(path.join(reviewDir, "context.json"), "utf8"));
    assert.deepEqual(rangeContext.git.diffArgs, ["main...feature"]);
    assert.equal(rangeContext.git.diffLabel, "main...feature");
    assert.match(second.stdout, /Existing review files: review-main-feature\.html/);
    assert.ok(fs.statSync(path.join(reviewDir, "review-main-feature-2.html")).size > 0);
  },
);
