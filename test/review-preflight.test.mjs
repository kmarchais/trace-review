import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("review-preflight inventories a patch and flags review hazards", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-preflight-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const diffPath = path.join(tempDir, "mixed.patch");
  const fixture = fs.readFileSync(
    path.join(root, "test", "fixtures", "mixed.patch"),
    "utf8",
  );
  fs.writeFileSync(
    diffPath,
    fixture.replace('+console.log("world");', '+console.log("world");   '),
  );
  const stdout = execFileSync(
    process.execPath,
    [
      path.join(root, "scripts", "review-preflight.mjs"),
      "--diff",
      diffPath,
    ],
    { cwd: root, encoding: "utf8" },
  );

  const result = JSON.parse(stdout);
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.totals, {
    files: 3,
    additions: 2,
    deletions: 1,
    bytes: 496,
  });
  assert.equal(result.patch.valid, true);
  assert.equal(result.patch.gitApply.valid, true);
  assert.match(result.patch.gitApply.numstat, /assets\/logo\.png/);
  assert.equal(result.files[0].type, "javascript");
  assert.equal(result.files[1].generated, true);
  assert.equal(result.files[2].binary, true);
  assert.deepEqual(result.whitespaceErrors, [
    { file: "src/app.js", line: 2, kind: "trailing-whitespace" },
  ]);
});

test("review-preflight rejects malformed patches with actionable diagnostics", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts", "review-preflight.mjs"),
      "--diff",
      path.join(root, "test", "fixtures", "malformed.patch"),
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  const preflight = JSON.parse(result.stdout);
  assert.equal(preflight.patch.valid, false);
  assert.equal(preflight.patch.gitApply.valid, false);
  assert.deepEqual(
    preflight.patch.diagnostics.map((diagnostic) => diagnostic.code),
    ["invalid-patch", "git-apply-check-failed"],
  );
});

test("review-preflight decodes Git-quoted paths", () => {
  const stdout = execFileSync(
    process.execPath,
    [
      path.join(root, "scripts", "review-preflight.mjs"),
      "--diff",
      path.join(root, "test", "fixtures", "quoted-path.patch"),
    ],
    { cwd: root, encoding: "utf8" },
  );

  const preflight = JSON.parse(stdout);
  assert.equal(preflight.patch.valid, true);
  assert.equal(preflight.files[0].path, "café.js");
  assert.equal(preflight.files[0].type, "javascript");
});
