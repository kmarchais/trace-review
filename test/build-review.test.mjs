import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "test", "fixtures");
const builder = path.join(root, "scripts", "build-review.mjs");

function build(specPath, outPath) {
  return spawnSync(process.execPath, [builder, "--spec", specPath, "--out", outPath], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

test("generator produces a complete, mode-labelled review document", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-build-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const out = path.join(tempDir, "review.html");
  const result = build(path.join(fixtures, "workspace-spec.json"), out);

  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<body data-review-mode="workspace">/);
  assert.match(html, /2026-07-24 · 1 PR · workspace/);
  assert.match(html, /class="app-header"/);
  assert.match(html, /class="pr-cols"/);
  assert.match(html, /class="diff-block"/);
  assert.match(html, /id="review-data" type="application\/json"/);
  assert.match(html, /src\/widget\.hpp/);
  assert.match(html, /CMakeLists\.txt/);
  assert.match(html, /Binary file not shown/);
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
});

test("generator rejects an invalid specification without writing output", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-invalid-build-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const specPath = path.join(tempDir, "invalid.json");
  const out = path.join(tempDir, "review.html");
  fs.writeFileSync(specPath, JSON.stringify({
    schemaVersion: 1,
    mode: "workspace",
    prs: [{ title: "Invalid", diff: "x", review: { comments: [] } }],
  }));
  const result = build(specPath, out);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /review-not-allowed/);
  assert.equal(fs.existsSync(out), false);
});

test("AI-analysis fixture renders its global assessment and line finding", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-ai-build-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const out = path.join(tempDir, "review.html");
  const result = build(path.join(fixtures, "ai-analysis-spec.json"), out);

  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");
  assert.match(html, /<body data-review-mode="ai-analysis">/);
  assert.match(html, /The implementation and build changes agree\./);
  assert.match(html, /Should the returned name be part of the public compatibility contract/);
});

test("generator reports malformed JSON without a stack trace", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-json-build-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const specPath = path.join(tempDir, "invalid.json");
  const out = path.join(tempDir, "review.html");
  fs.writeFileSync(specPath, "{");
  const result = build(specPath, out);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR \$ \[invalid-json\]/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  assert.equal(fs.existsSync(out), false);
});

test("visual contract matches the checked-in baseline", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-visual-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const out = path.join(tempDir, "review.html");
  const result = build(path.join(fixtures, "workspace-spec.json"), out);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");
  const baseline = JSON.parse(fs.readFileSync(path.join(fixtures, "visual-baseline.json"), "utf8"));

  for (const [token, value] of Object.entries(baseline.palette)) {
    assert.match(html, new RegExp(`--${token}:${value.replace("#", "\\#")}`), `palette token ${token}`);
  }
  for (const [selector, declaration] of Object.entries(baseline.layout)) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(html, new RegExp(`\\.${escaped}\\s*\\{[^}]*${declaration.replace(":", "\\s*:\\s*")}`), `layout contract ${selector}`);
  }
  let cursor = -1;
  for (const className of baseline.landmarks) {
    const next = html.indexOf(`class="${className}`, cursor + 1);
    assert.ok(next > cursor, `landmark ${className} should appear in baseline order`);
    cursor = next;
  }
});

test("change groups visually contain their files and confirm bulk review", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-groups-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const out = path.join(tempDir, "review.html");
  const result = build(path.join(fixtures, "workspace-spec.json"), out);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");

  assert.match(
    html,
    /\.group \{[^}]*border:1px solid var\(--border\);[^}]*border-top:3px solid var\(--group-accent\)/s,
  );
  assert.match(html, /if\(want && !window\.confirm\(/);
  assert.match(html, /Mark all .* files in .* as viewed/);
  assert.match(html, /files\.map\(f=> "• " \+ f\.dataset\.file\)/);
});

test("large-diff generation stays within the Phase 0 performance budget", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-large-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const patch = Array.from({ length: 300 }, (_, index) => [
    `diff --git a/src/file-${index}.js b/src/file-${index}.js`,
    "index 1111111..2222222 100644",
    `--- a/src/file-${index}.js`,
    `+++ b/src/file-${index}.js`,
    "@@ -1 +1 @@",
    `-export const value = ${index};`,
    `+export const value = ${index + 1};`,
  ].join("\n")).join("\n") + "\n";
  const patchPath = path.join(tempDir, "large.patch");
  const specPath = path.join(tempDir, "large.json");
  const out = path.join(tempDir, "large.html");
  fs.writeFileSync(patchPath, patch);
  fs.writeFileSync(specPath, JSON.stringify({
    schemaVersion: 1,
    mode: "workspace",
    title: "Large fixture",
    prs: [{ title: "Three hundred files", diffFile: "large.patch" }],
  }));

  const start = performance.now();
  const result = build(specPath, out);
  const elapsed = performance.now() - start;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsed < 5000, `generation took ${elapsed.toFixed(0)}ms; budget is 5000ms`);
  assert.ok(fs.statSync(out).size > 200_000, "large fixture should exercise a substantial HTML payload");
});
