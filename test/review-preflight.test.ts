import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzePatch } from "../scripts/lib/preflight.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("review-preflight normalizes a CRLF patch and inventories review hazards", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-preflight-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const diffPath = path.join(tempDir, "mixed.patch");
  const fixture = fs.readFileSync(path.join(root, "test", "fixtures", "mixed.patch"), "utf8");
  const patchText = fixture
    .replace('+console.log("world");', '+console.log("world");   ')
    .replace(/\r?\n/g, "\r\n");
  const normalizedPatchText = patchText.replace(/\r\n?/g, "\n");
  fs.writeFileSync(diffPath, patchText);
  const stdout = execFileSync(
    process.execPath,
    [path.join(root, "dist", "runtime", "scripts", "review-preflight.mjs"), "--diff", diffPath],
    { cwd: root, encoding: "utf8" },
  );

  const result = JSON.parse(stdout);
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.totals, {
    files: 3,
    additions: 2,
    deletions: 1,
    bytes: Buffer.byteLength(normalizedPatchText),
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
      path.join(root, "dist", "runtime", "scripts", "review-preflight.mjs"),
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
      path.join(root, "dist", "runtime", "scripts", "review-preflight.mjs"),
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

test("comprehensive fixture covers C++, CMake, rename, generated, and binary changes", () => {
  const patch = fs.readFileSync(path.join(root, "test", "fixtures", "comprehensive.patch"), "utf8");
  const result = analyzePatch(patch);
  const byPath = new Map(result.files.map((file) => [file.path, file]));

  assert.equal(result.totals.files, 6);
  assert.equal(byPath.get("src/widget.hpp").type, "cpp");
  assert.equal(byPath.get("CMakeLists.txt").type, "cmake");
  assert.equal(byPath.get("docs/widget-name.md").oldPath, "docs/old-name.md");
  assert.equal(byPath.get("generated/api.generated.js").generated, true);
  assert.equal(byPath.get("assets/widget.png").binary, true);
});

test("documented example patch passes deterministic preflight", () => {
  const stdout = execFileSync(
    process.execPath,
    [
      path.join(root, "dist", "runtime", "scripts", "review-preflight.mjs"),
      "--diff",
      path.join(root, "examples", "pr-1.patch"),
    ],
    { cwd: root, encoding: "utf8" },
  );

  const preflight = JSON.parse(stdout);
  assert.equal(preflight.patch.valid, true);
  assert.equal(preflight.patch.gitApply.valid, true);
});
