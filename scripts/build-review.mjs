#!/usr/bin/env node
// build-review.mjs — turn a small JSON review spec + unified diffs into a
// self-contained, interactive HTML review document.
//
// Usage:
//   node build-review.mjs --spec review-spec.json --out review.html [--open]
//
// The diff is emitted as structured data and rendered client-side, so the doc
// can switch between unified and split (side-by-side) views. Heavy content
// (diffs) is read from files referenced by the spec, so the calling agent
// never has to emit diff text into the conversation.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import {
  formatReviewSpecDiagnostics,
  validateReviewSpec,
} from "./lib/review-spec.mjs";
import { analyzePatch } from "./lib/preflight.mjs";
import {
  detectChangeGroups,
  extractDefinedSymbols,
  parsePatchChanges,
  validateGrouping,
} from "./lib/change-groups.mjs";
import { validateLmGroupingResult } from "./lib/lm-groups.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, "..");
const TEMPLATE = path.join(SKILL_DIR, "templates", "review.template.html");

// ---------- args ----------
function parseArgs(argv) {
  const out = { open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spec") out.spec = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--open") out.open = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

// ---------- html helpers ----------
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "review";

// ---------- minimal markdown (summaries only) ----------
function md(src) {
  if (!src) return "";
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let i = 0;
  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      i++;
      let code = "";
      while (i < lines.length && !/^```/.test(lines[i])) code += lines[i++] + "\n";
      i++;
      html += `<pre class="md-code"><code>${esc(code)}</code></pre>`;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length + 2;
      html += `<h${lvl}>${inline(h[2])}</h${lvl}>`;
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      html += "<ul>";
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        html += `<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`;
        i++;
      }
      html += "</ul>";
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      html += "<ol>";
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        html += `<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`;
        i++;
      }
      html += "</ol>";
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    let para = line;
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,4}\s|```|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) {
      para += " " + lines[i++];
    }
    html += `<p>${inline(para)}</p>`;
  }
  return html;
}

// ---------- word-level diff (for paired -/+ lines) ----------
function tokenize(s) {
  return s.match(/\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g) || [];
}
function lcsMask(a, b) {
  const n = a.length,
    m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let x = n - 1; x >= 0; x--)
    for (let y = m - 1; y >= 0; y--)
      dp[x][y] = a[x] === b[y] ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
  const aKeep = new Array(n).fill(false),
    bKeep = new Array(m).fill(false);
  let x = 0,
    y = 0;
  while (x < n && y < m) {
    if (a[x] === b[y]) {
      aKeep[x] = bKeep[y] = true;
      x++;
      y++;
    } else if (dp[x + 1][y] >= dp[x][y + 1]) x++;
    else y++;
  }
  return { aKeep, bKeep };
}
function wordDiff(oldText, newText) {
  const a = tokenize(oldText),
    b = tokenize(newText);
  const { aKeep, bKeep } = lcsMask(a, b);
  const render = (toks, keep) =>
    toks
      .map((t, idx) => (keep[idx] || /^\s+$/.test(t) ? esc(t) : `<span class="wd">${esc(t)}</span>`))
      .join("");
  return { oldHtml: render(a, aKeep), newHtml: render(b, bKeep) };
}

// ---------- unified diff parser ----------
function parseDiff(text) {
  const files = [];
  if (!text || !text.trim()) return files;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cur = null;
  let oldNo = 0,
    newNo = 0;
  const pushFile = (p) => {
    cur = { path: p, oldPath: p, hunks: [], add: 0, del: 0, binary: false, meta: [] };
    files.push(cur);
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l))) {
      pushFile(m[2]);
      cur.oldPath = m[1];
      continue;
    }
    if (/^(index |old mode|new mode|similarity|rename from|rename to|dissimilarity) /.test(l)) {
      if (cur) cur.meta.push(l);
      continue;
    }
    if (/^new file mode/.test(l)) {
      if (cur) cur.isNew = true;
      continue;
    }
    if (/^deleted file mode/.test(l)) {
      if (cur) cur.isDeleted = true;
      continue;
    }
    if (/^Binary files? /.test(l)) {
      if (!cur) pushFile(l.replace(/^Binary files? a\/(.+?) and .*/, "$1"));
      cur.binary = true;
      continue;
    }
    if ((m = /^--- (?:a\/)?(.+)$/.exec(l))) {
      if (!cur) pushFile(m[1] === "/dev/null" ? "?" : m[1]);
      if (m[1] !== "/dev/null") cur.oldPath = m[1];
      continue;
    }
    if ((m = /^\+\+\+ (?:b\/)?(.+)$/.exec(l))) {
      if (m[1] !== "/dev/null") cur.path = m[1];
      else cur.isDeleted = true;
      continue;
    }
    if ((m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l))) {
      oldNo = parseInt(m[1], 10);
      newNo = parseInt(m[2], 10);
      const hunk = { header: m[3].trim(), rows: [] };
      cur.hunks.push(hunk);
      cur._hunk = hunk;
      continue;
    }
    if (!cur || !cur._hunk) continue;
    const kind = l[0];
    const content = l.slice(1);
    if (kind === "+") {
      cur._hunk.rows.push({ type: "add", newNo, text: content });
      newNo++;
      cur.add++;
    } else if (kind === "-") {
      cur._hunk.rows.push({ type: "del", oldNo, text: content });
      oldNo++;
      cur.del++;
    } else if (kind === " ") {
      cur._hunk.rows.push({ type: "ctx", oldNo, newNo, text: content });
      oldNo++;
      newNo++;
    }
  }
  return files;
}

// pair consecutive del/add runs in a hunk for word-level highlighting
function annotateWordDiffs(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type !== "del") continue;
    let d = i;
    while (d < rows.length && rows[d].type === "del") d++;
    let a = d;
    while (a < rows.length && rows[a].type === "add") a++;
    const dels = rows.slice(i, d),
      adds = rows.slice(d, a);
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) {
      const { oldHtml, newHtml } = wordDiff(dels[k].text, adds[k].text);
      dels[k].html = oldHtml;
      adds[k].html = newHtml;
    }
    i = a - 1;
  }
}

// map a file path to a highlight.js language id (client uses hljs)
function langOf(p) {
  const f = String(p).toLowerCase();
  const base = f.split("/").pop();
  if (base === "cmakelists.txt" || f.endsWith(".cmake")) return "cmake";
  if (base === "makefile" || f.endsWith(".mk")) return "makefile";
  if (base === "dockerfile") return "dockerfile";
  const ext = f.includes(".") ? f.split(".").pop() : "";
  const map = {
    cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", h: "cpp", c: "c", cu: "cpp", cuh: "cpp",
    py: "python", pyi: "python", pyx: "python",
    toml: "ini", ini: "ini", cfg: "ini",
    md: "markdown", markdown: "markdown",
    yml: "yaml", yaml: "yaml", json: "json",
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    rs: "rust", go: "go", sh: "bash", bash: "bash", zsh: "bash",
    java: "java", cs: "csharp", css: "css", scss: "scss", less: "less",
    html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
    sql: "sql", rb: "ruby", php: "php", kt: "kotlin", swift: "swift",
    lua: "lua", pl: "perl", r: "r", scala: "scala", dart: "dart",
  };
  return map[ext] || "";
}

// ---------- structured file data (rendered client-side) ----------
function fileData(file) {
  const renamed = file.oldPath && file.oldPath !== file.path && !file.isNew && !file.isDeleted;
  const d = {
    path: file.path,
    oldPath: file.oldPath,
    renamed,
    isNew: !!file.isNew,
    isDeleted: !!file.isDeleted,
    binary: !!file.binary,
    add: file.add,
    del: file.del,
    lang: langOf(file.path),
    hunks: [],
  };
  if (file.binary) {
    d.note = "Binary file not shown";
    return d;
  }
  if (file.hunks.length === 0) {
    d.note = file.isNew ? "New empty file" : file.isDeleted ? "File deleted" : renamed ? "Renamed (no content change)" : "No textual changes";
    return d;
  }
  for (const h of file.hunks) {
    annotateWordDiffs(h.rows);
    const rows = h.rows.map((r) => {
      const o = { t: r.type === "add" ? "a" : r.type === "del" ? "d" : "c", h: r.html != null ? r.html : esc(r.text), c: r.text };
      if (r.oldNo != null && r.type !== "add") o.o = r.oldNo;
      if (r.newNo != null && r.type !== "del") o.n = r.newNo;
      return o;
    });
    d.hunks.push({ header: h.header, rows });
  }
  return d;
}

// ---------- summary blocks (free-form top section) ----------
let anyMermaid = false;

function inlineSvg(b) {
  if (b.svg) return b.svg;
  if (b.svgFile) {
    const p = path.isAbsolute(b.svgFile) ? b.svgFile : path.resolve(specDir, b.svgFile);
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      console.warn(`WARN: could not read svgFile "${b.svgFile}" (${p})`);
      return `<div class="warn">SVG not found: ${esc(b.svgFile)}</div>`;
    }
  }
  if (b.mermaid) {
    anyMermaid = true;
    return `<pre class="mermaid">${esc(b.mermaid)}</pre>`;
  }
  return "";
}

// Render the free-form summary grid. Uses pr.blocks if given; otherwise
// synthesises sensible blocks from pr.summary + pr.diagrams (back-compat).
function renderBlocks(pr) {
  let blocks = Array.isArray(pr.blocks) ? pr.blocks.slice() : null;
  if (!blocks) {
    blocks = [];
    if (pr.summary) blocks.push({ type: "prose", md: pr.summary });
    const ds = Array.isArray(pr.diagrams) ? pr.diagrams : [];
    ds.forEach((d) => blocks.push({ type: "diagram", title: d.title, svg: d.svg, svgFile: d.svgFile, mermaid: d.mermaid, width: ds.length > 1 ? "half" : "full" }));
  }
  const wc = (w) => (w === "half" ? "b-half" : w === "third" ? "b-third" : w === "two-thirds" ? "b-two-thirds" : "b-full");
  const cell = (c) => esc(c == null ? "" : String(c));
  const parts = blocks.map((b) => {
    let inner = "";
    switch (b.type) {
      case "prose":
        inner = `<div class="summary-body">${md(b.md || "")}</div>`;
        break;
      case "heading": {
        const lvl = Math.min(Math.max(b.level || 3, 2), 5);
        inner = `<h${lvl}>${esc(b.text || "")}</h${lvl}>`;
        break;
      }
      case "callout":
        inner = `<div class="callout callout-${esc(b.variant || "info")}">${b.title ? `<div class="callout-title">${esc(b.title)}</div>` : ""}<div class="summary-body">${md(b.md || "")}</div></div>`;
        break;
      case "stats":
        inner = `<div class="stat-row">${(b.items || []).map((it) => `<div class="stat-tile"><div class="stat-val${it.accent ? " accent-" + esc(it.accent) : ""}">${esc(it.value)}</div><div class="stat-lbl">${esc(it.label)}</div></div>`).join("")}</div>`;
        break;
      case "table": {
        const hd = b.headers ? `<thead><tr>${b.headers.map((h) => `<th>${cell(h)}</th>`).join("")}</tr></thead>` : "";
        const bd = `<tbody>${(b.rows || []).map((r) => `<tr>${(r || []).map((c) => `<td>${cell(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
        inner = `<table class="sum-table">${hd}${bd}</table>`;
        break;
      }
      case "diagram":
        {
          const surface = b.surface === "dark" ? " diagram-surface-dark" : " diagram-surface-light";
          inner = `<figure class="diagram${surface}">${b.title ? `<figcaption>${esc(b.title)}</figcaption>` : ""}<div class="diagram-body">${inlineSvg(b)}</div></figure>`;
        }
        break;
      default:
        inner = b.md ? `<div class="summary-body">${md(b.md)}</div>` : "";
    }
    return `<div class="block ${wc(b.width)}">${inner}</div>`;
  });
  return `<div class="summary-blocks">${parts.join("")}</div>`;
}

// ---------- Claude's automatic review (optional) ----------
// `pr.review = { verdict?, global?, comments: [{ file, line, severity, body, confidence, rationale }] }`.
// `line` is the new-file line number; prefix with `o` for a removed line (e.g. "o7").
function normalizeReview(pr) {
  const r = pr.review;
  if (!r) return null;
  let n = 0;
  const comments = (Array.isArray(r.comments) ? r.comments : []).map((c) => {
    let key, line;
    if (typeof c.line === "string" && /^o\d+$/.test(c.line)) {
      key = c.line;
      line = c.line.slice(1);
    } else {
      key = String(c.line);
      line = String(c.line);
    }
    return {
      file: c.file,
      key,
      line,
      severity: c.severity || "comment",
      body: c.body || "",
      confidence: c.confidence,
      rationale: c.rationale || "",
      aid: "a" + n++,
    };
  });
  return { verdict: r.verdict || "", global: r.global || "", comments };
}

function resolveChangeGroups(pr, text) {
  let grouping = pr.changeGroups || null;
  if (pr.groupFile) {
    const groupPath = path.isAbsolute(pr.groupFile)
      ? pr.groupFile
      : path.resolve(specDir, pr.groupFile);
    grouping = JSON.parse(fs.readFileSync(groupPath, "utf8"));
  } else if (pr.autoGroups) {
    grouping = detectChangeGroups(text, analyzePatch(text));
  }
  if (!grouping) return null;
  if (grouping.schemaVersion !== 1) {
    throw new Error(
      `Unsupported change-group schema '${grouping.schemaVersion}' for '${pr.title || pr.id}'.`,
    );
  }
  const inventory = parsePatchChanges(text, analyzePatch(text));
  const structuralValidation = validateGrouping(grouping, inventory);
  const semanticValidation =
    grouping.provenance === "lm"
      ? validateLmGroupingResult(grouping, { inventory })
      : { valid: true, diagnostics: [] };
  const validation = {
    valid: structuralValidation.valid && semanticValidation.valid,
    diagnostics: [
      ...structuralValidation.diagnostics,
      ...semanticValidation.diagnostics,
    ],
  };
  if (!validation.valid) {
    const detail = validation.diagnostics
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
      .join("; ");
    throw new Error(`Invalid change groups for '${pr.title || pr.id}': ${detail}`);
  }
  return { ...grouping, validation };
}

// ---------- render a PR section (diff mounts filled client-side) ----------
function renderPr(pr, idx, single, dataBag, reviewBag, reviewer) {
  const prId = pr.id || `pr-${idx + 1}`;
  const { text, warning } = readDiff(pr);
  const files = parseDiff(text);
  const changeGroups = resolveChangeGroups(pr, text);
  const warnHtml = warning ? `<div class="warn">⚠ ${esc(warning)}</div>` : "";
  const totals = files.reduce((t, f) => ({ add: t.add + f.add, del: t.del + f.del }), { add: 0, del: 0 });

  // one block per file (diff filled client-side); optionally arranged into groups
  const fileBlocks = files.map((f, i) => {
    const fid = `${prId}__${i}`;
    dataBag[fid] = fileData(f);
    return { fid, d: dataBag[fid] };
  });
  const renderFileBlock = ({ fid, d, changeId, changeLabel }, collapsed) => {
    const pathLabel = d.renamed ? `${esc(d.oldPath)} → ${esc(d.path)}` : esc(d.path);
    const tag = d.isNew ? '<span class="ftag ftag-new">new</span>' : d.isDeleted ? '<span class="ftag ftag-del">deleted</span>' : d.renamed ? '<span class="ftag">renamed</span>' : "";
    return `
      <div class="file${collapsed ? " collapsed" : ""}" id="file-${fid}" data-file="${esc(d.path)}"${changeId ? ` data-change="${esc(changeId)}"` : ""}>
        <div class="file-header" data-toggle="file-${fid}">
          <span class="chevron">▾</span>
          <span class="file-path">${pathLabel}</span>${tag}${changeLabel ? `<span class="change-range" title="${esc(changeLabel)}">${esc(changeLabel)}</span>` : ""}
          <span class="file-badge" data-file-count="${esc(d.path)}" hidden></span>
          <span class="stats"><span class="stat-add">+${d.add}</span> <span class="stat-del">-${d.del}</span></span>
          <span class="file-actions">
            <button type="button" class="file-note-btn" title="Comment on this file">💬</button>
            <label class="viewed-label"><input type="checkbox" class="viewed-cb"> Viewed</label>
          </span>
        </div>
        <div class="file-body"><div class="file-note-slot"></div><div class="diff-mount" data-fid="${fid}"></div></div>
      </div>`;
  };
  const renderGroup = (g, gblocks) => {
    const kind = g.kind || "other";
    const collapsedFiles = g.collapsed != null ? !!g.collapsed : false;
    const gadd = gblocks.reduce((s, b) => s + b.d.add, 0);
    const gdel = gblocks.reduce((s, b) => s + b.d.del, 0);
    const readFirst = g.readFirst?.length ? g.readFirst : ["No prerequisite group"];
    const dependents = g.dependents?.length ? g.dependents : ["No dependent group detected"];
    const definitions = g.definitions?.length ? g.definitions : [];
    const relationship = `
      <div class="group-relationships">
        <div><span>Read first</span><strong>${readFirst.map(esc).join(" · ")}</strong></div>
        <div><span>Dependent changes</span><strong>${dependents.map(esc).join(" · ")}</strong></div>
      </div>`;
    const definitionPreview = definitions.length
      ? `<details class="definition-preview"><summary>Definition preview</summary>${definitions
          .map((definition) => `<code>${esc(definition.symbol)}</code><pre>${esc(definition.preview)}</pre>`)
          .join("")}</details>`
      : `<div class="definition-preview empty"><span>Definition preview</span><p>No relevant symbol definitions detected in this group.</p></div>`;
    return `
      <div class="group gk-${esc(kind)}${g.startCollapsed ? " collapsed" : ""}" data-group="${esc(g.id || kind)}">
        <div class="group-head" data-gtoggle>
          <span class="chevron">▾</span>
          <span class="group-kind gk-${esc(kind)}">${esc(kind)}</span>
          <span class="group-title">${esc(g.title || g.id || "Changes")}</span>
          <span class="group-count">${gblocks.length} file${gblocks.length === 1 ? "" : "s"}</span>
          ${g.risk ? `<span class="group-risk risk-${esc(g.risk)}">${esc(g.risk)} risk</span>` : ""}
          ${g.confidence != null ? `<span class="group-confidence">${Math.round(Number(g.confidence) * 100)}% confidence</span>` : ""}
          <span class="stats"><span class="stat-add">+${gadd}</span> <span class="stat-del">-${gdel}</span></span>
          <label class="group-viewed" title="Mark every file in this group reviewed"><input type="checkbox" class="gv-cb"> Reviewed</label>
        </div>
        <div class="group-intent-card">
          ${g.intent ? `<p><span>Intent</span>${esc(g.intent)}</p>` : g.note ? md(g.note) : `<p><span>Intent</span>Review these changes as one decision.</p>`}
          ${relationship}
          ${definitionPreview}
          ${g.evidence?.length || g.reviewerChecks?.length ? `<details class="group-evidence"><summary>Inspect evidence and reviewer checks</summary>${g.evidence?.length ? `<h4>Evidence</h4><ul>${g.evidence.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}${g.reviewerChecks?.length ? `<h4>Reviewer checks</h4><ul>${g.reviewerChecks.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}</details>` : ""}
        </div>
        <div class="group-files">${gblocks.map((b) => renderFileBlock(b, collapsedFiles)).join("\n")}</div>
      </div>`;
  };
  const renderRawOrder = () =>
    files
      .map((file, index) => {
        const fid = `${prId}__raw__${index}`;
        const d = fileData(file);
        dataBag[fid] = d;
        return renderFileBlock({ fid, d }, false);
      })
      .join("\n");
  // pure renames (moved, no textual change) are noise to review one-by-one —
  // auto-collect them into a collapsed group once there are a few of them.
  const isPureRename = (b) => b.d.renamed && b.d.add === 0 && b.d.del === 0;
  const RENAME_GROUP = { id: "__renames", title: "Renamed (no content change)", kind: "mechanical", startCollapsed: true };

  let filesHtml;
  if (changeGroups) {
    const parsedByPath = new Map(files.map((file) => [file.path, file]));
    const previewDefinitionFromGroup = (symbol, sourceGroupId) => {
      const sourceGroup = changeGroups.groups.find((candidate) => candidate.id === sourceGroupId);
      for (const change of sourceGroup?.changes || []) {
        const parsed = parsedByPath.get(change.file);
        if (!parsed) continue;
        const d = fileData(parsed);
        const hunks = Number.isInteger(change.hunk) ? [d.hunks[change.hunk]].filter(Boolean) : d.hunks;
        const row = hunks
          .flatMap((hunk) => hunk.rows || [])
          .find(
            (candidate) =>
              candidate.t === "a" &&
              extractDefinedSymbols([candidate.c]).includes(symbol),
          );
        if (row) return row.c;
      }
      return symbol;
    };
    const order = changeGroups.dependencyGraph?.suggestedOrder || changeGroups.groups.map((group) => group.id);
    const orderIndex = new Map(order.map((id, index) => [id, index]));
    const orderedGroups = changeGroups.groups
      .slice()
      .sort((a, b) => (orderIndex.get(a.id) ?? 999) - (orderIndex.get(b.id) ?? 999));
    const titleById = new Map(orderedGroups.map((group) => [group.id, group.title]));
    const incoming = new Map();
    const outgoing = new Map();
    const incomingSymbols = new Map();
    for (const edge of changeGroups.dependencyGraph?.edges || []) {
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      const sourceTitle = titleById.get(edge.from) || edge.from;
      const targetTitle = titleById.get(edge.to) || edge.to;
      if (!incoming.get(edge.to).includes(sourceTitle)) {
        incoming.get(edge.to).push(sourceTitle);
      }
      if (!outgoing.get(edge.from).includes(targetTitle)) {
        outgoing.get(edge.from).push(targetTitle);
      }
      if (edge.reason === "definition-usage" && edge.evidence) {
        if (!incomingSymbols.has(edge.to)) incomingSymbols.set(edge.to, []);
        if (!incomingSymbols.get(edge.to).some((item) => item.symbol === edge.evidence)) {
          incomingSymbols.get(edge.to).push({ symbol: edge.evidence, sourceGroupId: edge.from });
        }
      }
    }
    const nodesById = new Map(
      (changeGroups.dependencyGraph?.nodes || []).map((node) => [node.id, node]),
    );
    const parts = [];
    for (const group of orderedGroups) {
      const blocks = [];
      const changesByFile = new Map();
      for (const change of group.changes || []) {
        if (!changesByFile.has(change.file)) changesByFile.set(change.file, []);
        changesByFile.get(change.file).push(change);
      }
      for (const [fileIndex, [file, fileChanges]] of [...changesByFile].entries()) {
        const parsed = parsedByPath.get(file);
        if (!parsed) continue;
        const d = fileData(parsed);
        const selectedHunks = [
          ...new Set(
            fileChanges
              .map((change) => change.hunk)
              .filter((hunk) => Number.isInteger(hunk)),
          ),
        ];
        if (selectedHunks.length) {
          d.hunks = selectedHunks.map((hunk) => d.hunks[hunk]).filter(Boolean);
          const rows = d.hunks.flatMap((hunk) => hunk.rows);
          d.add = rows.filter((row) => row.t === "a").length;
          d.del = rows.filter((row) => row.t === "d").length;
        }
        const fid = `${prId}__cg${orderIndex.get(group.id) ?? 0}__${fileIndex}`;
        dataBag[fid] = d;
        blocks.push({
          fid,
          d,
          changeId: fileChanges.map((change) => change.id).join(","),
          changeLabel: `${fileChanges.length} change unit${fileChanges.length === 1 ? "" : "s"}`,
        });
      }
      const previewSources = new Map(
        (nodesById.get(group.id)?.definitions || []).map((symbol) => [
          symbol,
          group.id,
        ]),
      );
      for (const item of incomingSymbols.get(group.id) || []) {
        if (!previewSources.has(item.symbol)) {
          previewSources.set(item.symbol, item.sourceGroupId);
        }
      }
      const definitions = [...previewSources].map(([symbol, sourceGroupId]) => ({
        symbol,
        preview: previewDefinitionFromGroup(symbol, sourceGroupId),
      }));
      parts.push(
        renderGroup(
          {
            ...group,
            readFirst: incoming.get(group.id) || [],
            dependents: outgoing.get(group.id) || [],
            definitions,
          },
          blocks,
        ),
      );
    }
    filesHtml = `
      <div class="group-workspace" data-review-stage="validate">
        <div class="reading-order"><strong>Suggested reading order:</strong> ${orderedGroups.map((group, index) => `${index + 1}. ${esc(group.title)}`).join(" → ")}</div>
        <div class="order-views" data-order-view="grouped">${parts.join("\n")}</div>
        <div class="order-views" data-order-view="raw" hidden>${renderRawOrder()}</div>
      </div>`;
  } else if (Array.isArray(pr.groups) && pr.groups.length) {
    const byPath = new Map(fileBlocks.map((b) => [b.d.path, b]));
    const assigned = new Set();
    const parts = [];
    for (const g of pr.groups) {
      const gblocks = (g.files || []).map((p) => byPath.get(p)).filter(Boolean);
      gblocks.forEach((b) => assigned.add(b.d.path));
      if (gblocks.length) parts.push(renderGroup(g, gblocks));
    }
    const rest = fileBlocks.filter((b) => !assigned.has(b.d.path));
    const restRenames = rest.filter(isPureRename);
    const groupRenames = restRenames.length >= 3;
    const restOther = groupRenames ? rest.filter((b) => !isPureRename(b)) : rest;
    if (restOther.length) parts.push(renderGroup({ id: "__other", title: "Other changes", kind: "other" }, restOther));
    if (groupRenames) parts.push(renderGroup(RENAME_GROUP, restRenames));
    filesHtml = `
      <div class="group-workspace" data-review-stage="validate">
        <div class="reading-order"><strong>Group reading order:</strong> ${parts.length} decision group${parts.length === 1 ? "" : "s"}</div>
        <div class="order-views" data-order-view="grouped">${parts.join("\n")}</div>
        <div class="order-views" data-order-view="raw" hidden>${renderRawOrder()}</div>
      </div>`;
  } else {
    const renames = fileBlocks.filter(isPureRename);
    if (renames.length >= 3) {
      const others = fileBlocks.filter((b) => !isPureRename(b));
      filesHtml = others.map((b) => renderFileBlock(b, false)).join("\n") + "\n" + renderGroup(RENAME_GROUP, renames);
    } else {
      filesHtml = fileBlocks.map((b) => renderFileBlock(b, false)).join("\n") || (warning ? "" : '<p class="pr-meta">No diff provided.</p>');
    }
  }

  const blocksHtml = renderBlocks(pr);
  const link = pr.url ? ` · <a class="pr-link" href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(pr.url)}</a>` : "";
  const filesLabel = `${files.length} file${files.length === 1 ? "" : "s"}`;
  const stat = `<span class="stat-add">+${totals.add}</span> <span class="stat-del">-${totals.del}</span>`;

  // "the PR" panel on the left — only when there is PR context to show
  const hasBlocks = Array.isArray(pr.blocks) ? pr.blocks.length > 0 : !!(pr.summary || (Array.isArray(pr.diagrams) && pr.diagrams.length));
  const hasContext = hasBlocks || !!pr.url;
  const contextPanel = hasContext
    ? `
      <aside class="pr-context" data-review-stage="understand">
        <div class="summary-head">
          <h2>${esc(pr.title || prId)}</h2>
          <div class="pr-meta">${stat} · ${filesLabel}${link}</div>
        </div>
        ${blocksHtml}
      </aside>`
    : "";

  // Claude's automatic review (optional) — read-only global card + line findings
  const review = normalizeReview(pr);
  if (review) reviewBag[prId] = review;
  const verdictBadge = review && review.verdict ? `<span class="verdict verdict-${esc(review.verdict)}">${esc(review.verdict.replace(/-/g, " "))}</span>` : "";
  const vclass = review && review.verdict ? "v-" + esc(review.verdict) : "v-comment";
  const aiGlobal =
    review && (review.global || review.verdict)
      ? `<div class="ai-review ${vclass}"><div class="ai-review-head"><span class="ai-tag">✦ ${esc(reviewer)} review</span>${verdictBadge}</div>${review.global ? `<div class="summary-body">${md(review.global)}</div>` : ""}</div>`
      : "";
  const findingsList =
    review && review.comments.length
      ? `<details class="findings-panel"><summary>${esc(reviewer)} findings <span class="cl-count">${review.comments.length}</span><small>Review when relevant</small></summary><div class="finding-list" data-finding-list="${esc(prId)}"></div></details>`
      : "";
  const overallPlaceholder = review
    ? `Your verdict after reading the summary, the ${reviewer} review, and the diff…`
    : "Your overall verdict after reading the summary and the diff…";

  return `
  <section class="pr${single ? " single" : ""}" id="${esc(prId)}" data-pr="${esc(prId)}" data-active-stage="inspect"${single ? "" : " hidden"}>
    <nav class="review-journey" aria-label="Review stages">
      <button type="button" data-review-stage="understand"><span>1</span><strong>Understand</strong><small>Pull request context</small></button>
      <button type="button" data-review-stage="validate"><span>2</span><strong>Validate groups</strong><small>Intent and dependencies</small></button>
      <button type="button" data-review-stage="inspect" aria-current="step"><span>3</span><strong>Inspect evidence</strong><small>Diff and comments</small></button>
    </nav>
    <div class="pr-cols${hasContext ? "" : " no-context"}">
      ${contextPanel}
      ${hasContext ? '<div class="col-resizer" title="Drag to resize · double-click for 34/66"></div>' : ""}
      <div class="review-col">
        <div class="review-top" data-review-stage="understand">
          ${aiGlobal}
          ${findingsList}
          <div class="cl-wrap">
            <div class="cl-head">Your line comments <span class="cl-count" data-cl-count="${esc(prId)}">0</span></div>
            <div class="comment-list" data-comment-list="${esc(prId)}"></div>
          </div>
        </div>
        <div class="diff-block" data-review-stage="inspect">
          <div class="diff-block-head"><span class="dbh-title">Changes</span><span class="dbh-right"><span class="dbh-meta">${filesLabel} · ${stat}</span>${hasContext ? '<button type="button" class="context-toggle" aria-pressed="false" title="Collapse pull request context">Context</button>' : ""}<button type="button" class="focus-mode-toggle" aria-pressed="false" title="Show only the evidence surface">Focus</button>${changeGroups || (Array.isArray(pr.groups) && pr.groups.length) ? '<button type="button" class="raw-order-toggle" aria-pressed="false" title="Switch between grouped reading order and raw Git order">Git order</button>' : ""}<button type="button" class="dbh-tree" title="File tree (list of changed files)">🗂 Files</button><div class="seg diff-mode-seg"><button type="button" data-mode="unified" class="active">Unified</button><button type="button" data-mode="split">Split</button></div><button type="button" class="dbh-fs" title="Fullscreen diff (Esc to exit)">⛶</button></span></div>
          ${warnHtml}
          <div class="files">${filesHtml}</div>
        </div>
      </div>
    </div>
    <div class="overall-bar collapsed">
      <div class="ob-head"><span class="review-label">📝 Your overall review</span><button type="button" class="ob-toggle" title="Collapse / expand">▾</button></div>
      <textarea class="general-input" data-general="${esc(prId)}" placeholder="${esc(overallPlaceholder)}"></textarea>
    </div>
  </section>`;
}

function readDiff(pr) {
  if (pr.diff) return { text: pr.diff, warning: "" };
  if (pr.diffFile) {
    const p = path.isAbsolute(pr.diffFile) ? pr.diffFile : path.resolve(specDir, pr.diffFile);
    try {
      return { text: fs.readFileSync(p, "utf8"), warning: "" };
    } catch {
      console.warn(`WARN: could not read diffFile "${pr.diffFile}" (${p})`);
      return { text: "", warning: `Diff file not found: ${pr.diffFile}` };
    }
  }
  return { text: "", warning: "" };
}

// ---------- main ----------
let specDir = process.cwd();
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.spec) {
    console.log("Usage: node build-review.mjs --spec review-spec.json --out review.html [--open]");
    process.exit(args.help ? 0 : 1);
  }
  const specPath = path.resolve(args.spec);
  specDir = path.dirname(specPath);
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  } catch (error) {
    console.error(`Invalid review specification:\nERROR $ [invalid-json]: ${error.message}`);
    process.exit(2);
  }
  const validation = validateReviewSpec(spec, { baseDir: specDir, checkFiles: true });
  if (!validation.valid) {
    console.error("Invalid review specification:\n" + formatReviewSpecDiagnostics(validation));
    process.exit(2);
  }
  const prs = spec.prs || [];
  const title = spec.title || "Code Review";
  const reviewId = spec.reviewId || slug(title);
  const generated = spec.generated || new Date().toISOString().slice(0, 10);
  const mode = spec.mode;
  const single = prs.length <= 1;

  const tabs = single
    ? ""
    : prs
        .map((pr, i) => {
          const prId = pr.id || `pr-${i + 1}`;
          return `<button class="tab${i === 0 ? " active" : ""}" data-tab="${esc(prId)}">${esc(pr.title || prId)}<span class="tab-count" data-tab-count="${esc(prId)}" hidden></span></button>`;
        })
        .join("");

  const reviewer = spec.reviewer || "LM";
  const dataBag = {};
  const reviewBag = {};
  const sections = prs
    .map((pr, i) => renderPr({ ...pr, id: pr.id || `pr-${i + 1}` }, i, single || i === 0, dataBag, reviewBag, reviewer))
    .join("\n");

  const mermaid = anyMermaid
    ? `<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
const dark = matchMedia('(prefers-color-scheme: dark)').matches && !document.documentElement.getAttribute('data-theme') || document.documentElement.getAttribute('data-theme') === 'dark';
mermaid.initialize({ startOnLoad: true, theme: dark ? 'dark' : 'default', securityLevel: 'loose' });
<\/script>`
    : "";

  const dataJson = JSON.stringify(dataBag).replace(/</g, "\\u003c");
  const reviewJson = JSON.stringify(reviewBag).replace(/</g, "\\u003c");

  let tpl = fs.readFileSync(TEMPLATE, "utf8");
  const repl = {
    "{{TITLE}}": esc(title),
    "{{SUBTITLE}}": esc(`${generated} · ${prs.length} PR${prs.length === 1 ? "" : "s"} · ${mode}`),
    "{{MODE}}": esc(mode),
    "{{REVIEW_ID}}": esc(reviewId),
    "{{TABS}}": tabs,
    "{{SECTIONS}}": sections,
    "{{DATA}}": dataJson,
    "{{AIREVIEW}}": reviewJson,
    "{{REVIEWER}}": esc(reviewer),
    "{{MERMAID}}": mermaid,
  };
  for (const [k, v] of Object.entries(repl)) tpl = tpl.split(k).join(v);

  const outPath = path.resolve(args.out || "review.html");
  fs.writeFileSync(outPath, tpl, "utf8");
  console.log(`Wrote ${outPath} (${prs.length} PR(s), ${(tpl.length / 1024).toFixed(0)} KB)`);

  if (args.open) {
    try {
      const cmd = process.platform === "win32" ? `start "" "${outPath}"` : process.platform === "darwin" ? `open "${outPath}"` : `xdg-open "${outPath}"`;
      execSync(cmd, { shell: true });
    } catch {
      /* ignore */
    }
  }
}

main();
