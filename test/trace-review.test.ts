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

  assert.ok(fs.statSync(path.join(reviewDir, "review.html")).size > 0);
  const spec = JSON.parse(fs.readFileSync(path.join(reviewDir, "spec.json"), "utf8"));
  const metrics = JSON.parse(fs.readFileSync(path.join(reviewDir, "run-metrics.json"), "utf8"));
  assert.equal(spec.mode, "lm-analysis");
  assert.equal(spec.prs[0].review.verdict, "comment");
  assert.equal(metrics.expectedAgentActions, 5);
  assert.equal(metrics.prepare.internalCommands, 3);
  assert.equal(metrics.finish.internalCommands, 3);
});
