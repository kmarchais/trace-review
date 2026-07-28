import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "test", "fixtures");
const builder = path.join(root, "dist", "runtime", "scripts", "build-review.mjs");

function build(specPath, outPath, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [builder, "--spec", specPath, "--out", outPath, ...extraArgs],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
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
  assert.match(html, /id="rangeToolbar"/);
  assert.match(html, /data-range-comment/);
  assert.match(html, /data-range-suggest/);
  assert.match(html, /data-range-image/);
  assert.match(html, /function selectableGutters\(anchor\)/);
  assert.match(html, /function openCarbonExport\(selection\)/);
  assert.match(html, /if \(prefill && !saved\)\s*store\(\)/);
  assert.match(html, /codeCell\?\.classList\.contains\("line-add"\)/);
  assert.match(html, /function buildExportRows\(selection\)/);
  assert.match(html, /if \(hasBefore && hasAfter\)/);
  assert.match(html, /function buildCarbonSvg\(file, rows, layout\)/);
  assert.match(html, /function syntaxSegments\(html\)/);
  assert.match(html, /function compactExportRows\(rows\)/);
  assert.match(html, /data-carbon-layout="compact"/);
  assert.match(html, /Image layout/);
  assert.match(html, /function powerPointClipboardTable\(\s*file,\s*rows,\s*layout\s*\)/);
  assert.match(html, /function officeSyntax\(html\)/);
  assert.match(html, /replace\(\/ \/g, "&nbsp;"\)/);
  assert.match(html, /mso-spacerun:yes/);
  assert.match(html, /powerPointClipboardTable\(carbonFile, carbonRows, carbonLayout\)/);
  assert.match(html, /layout === "compact"\s*\?\s*compactExportRows\(rows\)\s*:\s*\[\]/);
  assert.match(html, /const lineHeight = Math\.max\(7, fontSize \+ 1\.5\)/);
  assert.match(html, /bgcolor="#0d1117"/);
  assert.match(html, /<nobr>/);
  assert.match(html, /id="carbonSelectable"/);
  assert.match(html, /id="carbonCanvas"/);
  assert.match(html, /Copy for PowerPoint/);
  assert.match(html, /Download HTML/);
  assert.match(html, /Download SVG/);
  assert.match(html, /Download PNG/);
  assert.match(html, /id="review-data" type="application\/json"/);
  assert.match(html, /src\/widget\.hpp/);
  assert.match(html, /CMakeLists\.txt/);
  assert.match(html, /Binary file not shown/);
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
});

test("each diff file can open its bounded whole-file content", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-full-file-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const out = path.join(tempDir, "review.html");
  fs.writeFileSync(
    path.join(tempDir, "change.patch"),
    "diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n",
  );
  fs.writeFileSync(
    path.join(tempDir, "files.json"),
    JSON.stringify({
      schemaVersion: 1,
      maxFileBytes: 1048576,
      maxTotalBytes: 10485760,
      files: [{ path: "app.js", revision: "head", content: "const value = 2;\n" }],
    }),
  );
  fs.writeFileSync(
    path.join(tempDir, "spec.json"),
    JSON.stringify({
      schemaVersion: 1,
      mode: "workspace",
      prs: [
        {
          title: "Whole file",
          diffFile: "change.patch",
          fileContentsFile: "files.json",
        },
      ],
    }),
  );

  const result = build(path.join(tempDir, "spec.json"), out);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");
  assert.match(html, /class="view-file-btn"/);
  assert.match(html, /id="fileModal"/);
  assert.match(html, /const value = 2;\\n/);
  assert.match(html, /File after these changes/);
});

test("module TypeScript and common extension aliases select syntax languages", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-languages-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const out = path.join(tempDir, "review.html");
  fs.writeFileSync(
    path.join(tempDir, "change.patch"),
    [
      "diff --git a/tool.mts b/tool.mts",
      "--- a/tool.mts",
      "+++ b/tool.mts",
      "@@ -1 +1 @@",
      "-export const value: number = 1;",
      "+export const value: number = 2;",
      "diff --git a/schema.graphql b/schema.graphql",
      "--- a/schema.graphql",
      "+++ b/schema.graphql",
      "@@ -1 +1 @@",
      "-type Query { old: Int }",
      "+type Query { value: Int }",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(tempDir, "spec.json"),
    JSON.stringify({
      schemaVersion: 1,
      mode: "workspace",
      prs: [{ title: "Syntax aliases", diffFile: "change.patch" }],
    }),
  );

  const result = build(path.join(tempDir, "spec.json"), out);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");
  const dataSource = /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
    html,
  )?.[1];
  assert.ok(dataSource);
  const data = JSON.parse(dataSource);
  assert.equal(data["pr-1__0"].lang, "typescript");
  assert.equal(data["pr-1__1"].lang, "graphql");
});

test("SVG whole-file content offers sanitized image and exact code views", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-svg-file-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const out = path.join(tempDir, "review.html");
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">' +
    "<metadata><script>alert(2)</script>hidden metadata</metadata>" +
    '<rect width="10" height="10" style="fill:#2f81f7;stroke:#ffffff"/>' +
    '<a href="https://evil.example"><circle cx="5" cy="5" r="2"/></a>' +
    "</svg>";
  fs.writeFileSync(
    path.join(tempDir, "change.patch"),
    "diff --git a/image.svg b/image.svg\nnew file mode 100644\n--- /dev/null\n+++ b/image.svg\n@@ -0,0 +1 @@\n+" +
      svg +
      "\n",
  );
  fs.writeFileSync(
    path.join(tempDir, "files.json"),
    JSON.stringify({
      schemaVersion: 1,
      maxFileBytes: 1048576,
      maxTotalBytes: 10485760,
      files: [{ path: "image.svg", revision: "head", content: svg }],
    }),
  );
  fs.writeFileSync(
    path.join(tempDir, "spec.json"),
    JSON.stringify({
      schemaVersion: 1,
      mode: "workspace",
      prs: [
        {
          title: "SVG preview",
          diffFile: "change.patch",
          fileContentsFile: "files.json",
        },
      ],
    }),
  );

  const result = build(path.join(tempDir, "spec.json"), out);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");
  const dataSource = /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
    html,
  )?.[1];
  assert.ok(dataSource);
  const data = JSON.parse(dataSource);
  const fullFile = data["pr-1__0"].fullFile;
  assert.equal(fullFile.content, svg);
  assert.match(fullFile.svgPreview, /style="fill:#2f81f7;stroke:#ffffff"/);
  assert.doesNotMatch(fullFile.svgPreview, /onload|script|metadata|evil\.example/);
  assert.match(html, /data-file-view="image"/);
  assert.match(html, /data-file-view="code"/);
  assert.match(html, /Click to toggle actual size/);
});

test("generated review exposes one-click clipboard export in the header", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-copy-export-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const out = path.join(tempDir, "review.html");
  const result = build(path.join(fixtures, "workspace-spec.json"), out);

  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");
  assert.match(html, /id="copyCommentsBtn"[^>]*>Copy comments<\/button>/);
  assert.match(
    html,
    /getElementById\("copyCommentsBtn"\)\.addEventListener\("click",\s*async\s*\(\)\s*=>\s*\{[\s\S]*?buildMarkdown\(\)/,
  );
});

test("GitHub-enabled reviews expose a native-versus-fallback publication preview", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-github-export-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const specPath = path.join(tempDir, "review-spec.json");
  const out = path.join(tempDir, "review.html");
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "workspace",
      reviewId: "github-review",
      prs: [
        {
          id: "pr-42",
          title: "Publishable review",
          url: "https://github.com/acme/widgets/pull/42",
          github: {
            repository: "acme/widgets",
            pullRequest: 42,
            headSha: "abc123",
          },
          diff: "diff --git a/src/widget.ts b/src/widget.ts\n--- a/src/widget.ts\n+++ b/src/widget.ts\n@@ -1 +1 @@\n-old\n+new\n",
        },
      ],
    }),
  );

  const result = build(specPath, out);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");
  assert.match(html, /id="github-review-data" type="application\/json"/);
  assert.match(html, /"repository":"acme\/widgets"/);
  assert.match(html, /id="githubReviewTab"/);
  assert.match(html, /id="githubReviewPreview"/);
  assert.match(html, /Native threads/);
  assert.match(html, /Summary fallbacks/);
  assert.match(html, /id="downloadGithubPlanBtn"/);
  assert.match(html, /Start line for a multi-line comment/);
  assert.match(html, /classList\.contains\("line-hunk"\)/);
  assert.match(html, /startFingerprint/);
});

test("generator rejects an invalid specification without writing output", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-invalid-build-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const specPath = path.join(tempDir, "invalid.json");
  const out = path.join(tempDir, "review.html");
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "workspace",
      prs: [{ title: "Invalid", diff: "x", review: { comments: [] } }],
    }),
  );
  const result = build(specPath, out);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /review-not-allowed/);
  assert.equal(fs.existsSync(out), false);
});

test("LM-analysis fixture renders its global assessment and line finding", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-lm-build-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const out = path.join(tempDir, "review.html");
  const result = build(path.join(fixtures, "lm-analysis-spec.json"), out);

  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");
  assert.match(html, /<body data-review-mode="lm-analysis">/);
  assert.match(html, /The implementation and build changes agree\./);
  assert.match(html, /Should the returned name be part of the public compatibility contract/);
  assert.match(html, /Math\.round\(c\.confidence\s*\*\s*100\).*% confidence/);
  assert.match(html, /The return value is exposed by a public header/);
  assert.match(html, /class="findings-panel"/);
  assert.match(html, /function highlightMarkdownCode\(root\)/);
  assert.match(html, /highlightMarkdownCode\(td\)/);
  assert.match(html, /classList\.add\("hljs"\)/);
});

test("LM findings are visible on the default Review changes stage", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-visible-findings-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const out = path.join(tempDir, "review.html");
  const result = build(path.join(fixtures, "lm-analysis-spec.json"), out);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");

  assert.match(html, /data-active-stage="inspect"/);
  assert.doesNotMatch(
    html,
    /\.pr\[data-active-stage="inspect"\] \.review-top \{ display:none; \}/,
    "the default stage must not hide the LM review panel",
  );
  assert.match(
    html,
    /<details class="findings-panel" open>/,
    "the findings list should be expanded when the document opens",
  );
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
    assert.match(
      html,
      new RegExp(`--${token}:${value.replace("#", "\\#")}`),
      `palette token ${token}`,
    );
  }
  for (const [selector, declaration] of Object.entries(baseline.layout)) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const [property, ...valueParts] = declaration.split(":");
    const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declarationPattern = `${escapePattern(property)}\\s*:\\s*${escapePattern(valueParts.join(":"))}`;
    assert.match(
      html,
      new RegExp(`\\.${escaped}\\s*\\{[^}]*${declarationPattern}`),
      `layout contract ${selector}`,
    );
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
    /\.group \{[^}]*border:1px solid var\(--border\);[^}]*border-left:3px solid var\(--group-accent\)/s,
  );
  assert.match(html, /if\s*\(want\s*&&\s*!window\.confirm\(/);
  assert.match(html, /Mark all .* files in .* as viewed/);
  assert.match(html, /files\.map\(\(f\)\s*=>\s*"• "\s*\+\s*f\.dataset\.file\)/);
});

test("Phase 4 renders a staged, adaptive review experience", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-phase-4-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const out = path.join(tempDir, "review.html");
  const result = build(path.join(fixtures, "workspace-spec.json"), out);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");

  for (const token of [
    "surface-canvas",
    "surface-raised",
    "text-strong",
    "semantic-info",
    "space-3",
    "radius-lg",
    "shadow-sm",
  ]) {
    assert.match(html, new RegExp(`--${token}:`), `design token ${token}`);
  }
  assert.match(html, /class="review-journey"/);
  assert.match(html, /data-review-stage="validate"/);
  assert.match(html, /data-review-stage="inspect"/);
  assert.doesNotMatch(html, /data-review-stage="understand"/);
  assert.match(html, /data-active-stage="inspect"/);
  assert.match(html, /data-review-stage="inspect" aria-current="step"/);
  assert.match(html, />Review changes<\/button>/);
  assert.match(html, />Review groups<\/button>/);
  assert.ok(html.indexOf(">Review changes</button>") < html.indexOf(">Review groups</button>"));
  assert.match(html, /aria-current="step"/);
  assert.match(html, /class="context-toggle"/);
  assert.match(html, /class="focus-mode-toggle"/);
  assert.match(html, /class="raw-order-toggle"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /:focus-visible/);
  assert.match(
    html,
    /<header class="app-header">[\s\S]*class="review-journey"[\s\S]*class="header-actions"/,
  );
  assert.match(html, /<aside class="pr-context">[\s\S]*class="overall-bar"/);
  assert.equal((html.match(/class="review-journey"/g) || []).length, 1);
  assert.ok(html.indexOf('class="overall-bar"') < html.indexOf('class="review-col"'));
  assert.match(html, /function visibleEvidenceFiles/);
  assert.match(html, /fileNoteId\s*=\s*pr\s*\+\s*" "\s*\+\s*fileEl\.dataset\.file/);
  assert.match(
    html,
    /visibleEvidenceFiles\(sec\)[\s\S]*?\(file\d*\)\s*=>\s*file\d*\.querySelector/,
  );
  assert.match(html, /--surface-canvas:#0d1117/);
});

test("success emphasis fills retain WCAG AA contrast with their text", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-contrast-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const out = path.join(tempDir, "review.html");
  const result = build(path.join(fixtures, "workspace-spec.json"), out);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");
  const fills = [...html.matchAll(/--success-emphasis:(#[0-9a-f]{6})/gi)].map((match) => match[1]);
  assert.ok(fills.length >= 3, "light, preferred-dark, and explicit-dark tokens should be present");

  const luminance = (hex) => {
    const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
    const linear = channels.map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const white = luminance("#ffffff");
  for (const fill of fills) {
    const contrast = (white + 0.05) / (luminance(fill) + 0.05);
    assert.ok(contrast >= 4.5, `${fill} has only ${contrast.toFixed(2)}:1 contrast against white`);
  }
  assert.match(html, /\.btn-primary \{ background:var\(--success-emphasis\)/);
  assert.match(html, /\.badge\.done \{ background:var\(--success-emphasis\)/);
  assert.match(html, /\.verdict-approve \{ background:var\(--success-emphasis\)/);
});

test("large-diff generation stays within the Phase 0 performance budget", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-large-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const patch =
    Array.from({ length: 300 }, (_, index) =>
      [
        `diff --git a/src/file-${index}.js b/src/file-${index}.js`,
        "index 1111111..2222222 100644",
        `--- a/src/file-${index}.js`,
        `+++ b/src/file-${index}.js`,
        "@@ -1 +1 @@",
        `-export const value = ${index};`,
        `+export const value = ${index + 1};`,
      ].join("\n"),
    ).join("\n") + "\n";
  const patchPath = path.join(tempDir, "large.patch");
  const specPath = path.join(tempDir, "large.json");
  const out = path.join(tempDir, "large.html");
  fs.writeFileSync(patchPath, patch);
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "workspace",
      title: "Large fixture",
      prs: [{ title: "Three hundred files", diffFile: "large.patch" }],
    }),
  );

  const start = performance.now();
  const result = build(specPath, out);
  const elapsed = performance.now() - start;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsed < 5000, `generation took ${elapsed.toFixed(0)}ms; budget is 5000ms`);
  assert.ok(
    fs.statSync(out).size > 200_000,
    "large fixture should exercise a substantial HTML payload",
  );
});

test("Phase 5 fingerprints comments and exposes orphan recovery", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-fingerprint-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const out = path.join(tempDir, "review.html");
  const result = build(path.join(fixtures, "workspace-spec.json"), out);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");

  assert.match(html, /"fingerprint":"[a-f0-9]{20}"/);
  assert.match(html, /"f":"[a-f0-9]{20}"/);
  assert.match(html, /"cf":"[a-f0-9]{20}"/);
  assert.match(html, /data-diff-fingerprint=/);
  assert.match(html, /data-content-fingerprint=/);
  assert.match(html, /function orphanedComments\(\)/);
  assert.match(html, /currentLineAnchors/);
  assert.match(html, /uniqueContentFingerprint/);
  assert.match(html, /class="orphan-panel"/);
  assert.match(html, /### Orphaned comments/);
});

test("Phase 5 sanitizes untrusted links and inline SVG", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-untrusted-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const specPath = path.join(tempDir, "untrusted.json");
  const out = path.join(tempDir, "review.html");
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "workspace",
      title: "Untrusted content",
      prs: [
        {
          title: "<img src=x onerror=alert(1)>",
          url: "javascript:alert(1)",
          summary: "[unsafe](javascript:alert(2)) [safe](https://example.com/review)",
          diagrams: [
            {
              title: "Hostile SVG",
              svg: '<svg viewBox="0 0 10 10" onload="alert(3)"><script>alert(4)</script><a href="https://evil.example"><rect width="10" height="10" style="fill:u\\72l(https://evil.example/x)"/></a><use href="#safe"/></svg>',
            },
          ],
          diff: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n",
        },
      ],
    }),
  );
  const result = build(specPath, out);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");

  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /onload="alert\(3\)"/i);
  assert.doesNotMatch(html, /<script>alert\(4\)<\/script>/i);
  assert.doesNotMatch(html, /href="https:\/\/evil\.example"/i);
  assert.doesNotMatch(html, /<rect[^>]*style=/i);
  assert.doesNotMatch(html, /u\\72l/i);
  assert.match(html, /href="https:\/\/example\.com\/review"/);
  assert.match(html, /<use href="#safe"\/>/);
});

test("Phase 5 bounds word diff work, renders progressively, and writes real-PR metrics", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-robust-large-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const longOld = Array.from({ length: 400 }, (_, index) => `old${index}`).join(" ");
  const longNew = Array.from({ length: 400 }, (_, index) => `new${index}`).join(" ");
  const patch =
    Array.from({ length: 800 }, (_, index) =>
      [
        `diff --git a/src/file-${index}.js b/src/file-${index}.js`,
        "index 1111111..2222222 100644",
        `--- a/src/file-${index}.js`,
        `+++ b/src/file-${index}.js`,
        "@@ -1 +1 @@",
        `-${index === 0 ? longOld : `export const value = ${index};`}`,
        `+${index === 0 ? longNew : `export const value = ${index + 1};`}`,
      ].join("\n"),
    ).join("\n") + "\n";
  const patchPath = path.join(tempDir, "huge.patch");
  const specPath = path.join(tempDir, "huge.json");
  const out = path.join(tempDir, "huge.html");
  const metricsPath = path.join(tempDir, "metrics.json");
  fs.writeFileSync(patchPath, patch);
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "workspace",
      title: "Very large fixture",
      prs: [{ title: "Eight hundred files", diffFile: "huge.patch" }],
    }),
  );

  const result = build(specPath, out, ["--metrics-out", metricsPath]);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");
  const metrics = JSON.parse(fs.readFileSync(metricsPath, "utf8"));

  assert.match(html, /requestIdleCallback/);
  assert.match(html, /classList\.add\("pending"\)/);
  assert.doesNotMatch(
    html,
    /if\(mnt\.dataset\.rendered\)\{\s*renderMount\(mnt,mode\)/,
    "mode changes must not synchronously rerender every completed mount",
  );
  assert.equal(metrics.files, 800);
  assert.equal(metrics.wordDiff.skipped, 1);
  assert.ok(metrics.wordDiff.applied >= 799);
  assert.ok(metrics.generationMs < 5000, `generation took ${metrics.generationMs}ms`);
  assert.ok(metrics.estimatedSpecTokens > 0);
  assert.ok(metrics.estimatedPatchTokensAvoided > metrics.estimatedSpecTokens);
  assert.deepEqual(metrics.manual, {
    lmInputTokens: null,
    lmOutputTokens: null,
    reviewMinutes: null,
    groupingQuality: null,
    findingRelevance: null,
    notes: "",
  });
});

test("LM finding navigation remains available beside review progress", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-finding-nav-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const out = path.join(tempDir, "review.html");
  const result = build(path.join(fixtures, "lm-analysis-spec.json"), out);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, "utf8");

  assert.match(html, /data-finding-step="-1"/);
  assert.match(html, /data-finding-step="1"/);
  assert.match(html, /Next finding/);
  assert.match(html, /data-aid=/);
  assert.match(html, /findingCursor/);
});
