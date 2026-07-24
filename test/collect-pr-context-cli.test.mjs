import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

test("CLI writes validated local context and patch files", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-context-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, "init", "-b", "main");
  fs.writeFileSync(path.join(repo, "app.js"), "const value = 1;\n");
  git(repo, "add", "app.js");
  git(
    repo,
    "-c",
    "user.name=Trace Review Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  );
  fs.writeFileSync(path.join(repo, "app.js"), "const value = 2;\n");

  const out = path.join(repo, "facts", "context.json");
  const diffOut = path.join(repo, "facts", "changes.patch");
  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts", "collect-pr-context.mjs"),
      "--repo",
      repo,
      "--pr",
      "none",
      "--base",
      "HEAD",
      "--out",
      out,
      "--diff-out",
      diffOut,
    ],
    { encoding: "utf8" },
  );

  const context = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(context.source, "local");
  assert.deepEqual(context.diff, {
    path: "changes.patch",
    source: "local",
    bytes: fs.statSync(diffOut).size,
  });
  assert.equal(context.preflight.totals.files, 1);
  assert.equal(context.validation.valid, true);
  assert.match(fs.readFileSync(diffOut, "utf8"), /diff --git a\/app\.js b\/app\.js/);
});
