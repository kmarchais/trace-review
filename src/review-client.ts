import {
  githubReviewPreview,
  prepareGithubReview,
  rangeStartMatchesAnchor,
  type GithubPublicationContext,
  type GithubReviewPlan,
  type ReviewDraftComment,
} from "../scripts/lib/github-review.mjs";
import { renderFindingMarkdown, renderInlineMarkdown } from "./inline-markdown.js";

type UiElement = HTMLElement & { dataset: Record<string, string> };

declare global {
  interface HTMLElement {
    checked: boolean;
    value: string;
    files: FileList | null;
    selectionStart: number | null;
    selectionEnd: number | null;
    setSelectionRange(start: number, end: number): void;
    select(): void;
    placeholder: string;
    colSpan: number;
    indeterminate: boolean;
    href: string;
    download: string;
  }

  interface Element {
    closest(selectors: string): UiElement;
  }

  interface ParentNode {
    querySelector(selectors: string): UiElement;
    querySelectorAll(selectors: string): NodeListOf<UiElement>;
  }

  interface Document {
    getElementById(elementId: string): UiElement;
    createElement(tagName: string): UiElement;
  }

  interface Window {
    hljs?: {
      highlight(
        code: string,
        options: { language: string; ignoreIllegals: boolean },
      ): { value: string };
    };
  }
}

interface ClientRow {
  t: "a" | "d" | "c";
  h: string;
  c: string;
  o?: number;
  n?: number;
  f: string;
  cf: string;
  _hl?: string;
}

interface ClientHunk {
  header: string;
  rows: ClientRow[];
}

interface ClientFile {
  path: string;
  oldPath: string;
  renamed: boolean;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  add: number;
  del: number;
  lang: string;
  hunks: ClientHunk[];
  reviewTarget: string;
  fingerprint: string;
  note?: string;
  fullFile: {
    revision: "head" | "base";
    content?: string;
    unavailable?: "binary" | "too-large" | "missing";
    svgPreview?: string;
  };
}

interface SplitPair {
  l: ClientRow | null;
  r: ClientRow | null;
  ctx?: boolean;
}

interface DiffRangeSelection {
  file: string;
  oldSide: boolean;
  gutters: UiElement[];
  tableRows: UiElement[];
  start: UiElement;
  end: UiElement;
  rows: Array<{
    line: string;
    code: string;
    kind: "add" | "del" | "ctx";
  }>;
}

interface ExportSide {
  line: string;
  code: string;
  kind: "add" | "del" | "ctx";
  html?: string;
}

interface ExportPairRow {
  old?: ExportSide;
  next?: ExportSide;
}

interface Attachment {
  name: string;
  type: string;
  data: string;
}

interface StoredLineComment {
  pr: string;
  file: string;
  key: string;
  startKey?: string;
  lineno?: string;
  startLineno?: string;
  code?: string;
  text: string;
  fingerprint?: string;
  contentFingerprint?: string;
  startFingerprint?: string;
  rangeStale?: boolean;
  diffFingerprint?: string;
}

interface LineEvidence {
  fingerprints: Set<string>;
  anchors: Set<string>;
  anchorFingerprints: Map<string, string>;
  content: Map<string, Set<string>>;
}

interface StoredFileComment {
  pr: string;
  file: string;
  text: string;
}

interface ReviewState {
  general: Record<string, string>;
  lines: Record<string, StoredLineComment>;
  aiState: Record<string, "accepted" | "dismissed">;
  files: Record<string, StoredFileComment>;
  viewed: Record<string, boolean>;
  grouping: Record<string, "grouped" | "raw">;
  attachments: Record<string, Attachment[]>;
}

interface AutomatedFinding {
  aid: string;
  file: string;
  key: string;
  line: string;
  severity: string;
  body: string;
  confidence: number;
  rationale: string;
}

interface AutomatedReview {
  verdict: string;
  global: string;
  comments: AutomatedFinding[];
}

interface TreeFile {
  path: string;
  change: string;
  topic: string;
  name: string;
  add: number;
  del: number;
  viewed: boolean;
}

interface TreeNode {
  dirs: Record<string, TreeNode>;
  files: TreeFile[];
}

interface MarkdownFile {
  note: string;
  lines: StoredLineComment[];
}

type ClientData = Record<string, ClientFile>;
type ReviewData = Record<string, AutomatedReview>;
type GithubData = Record<string, GithubPublicationContext>;

function parseEmbeddedJson<T>(elementId: string): T {
  return JSON.parse(document.getElementById(elementId).textContent || "{}") as T;
}

function eventElement(event: Event): UiElement | null {
  return event.target instanceof HTMLElement ? (event.target as UiElement) : null;
}

(function () {
  const REVIEW_ID = "{{REVIEW_ID}}";
  const REVIEWER = "{{REVIEWER}}";
  const STORE_KEY = "htmlreview:" + REVIEW_ID;
  const MODE_KEY = "htmlreview:diffmode";
  const TITLE = document.querySelector(".app-header h1").textContent;
  const SUBTITLE = document.querySelector(".app-header .subtitle").textContent;
  const DATA = parseEmbeddedJson<ClientData>("review-data");
  const REVIEW = parseEmbeddedJson<ReviewData>("ai-review-data");
  const GITHUB = parseEmbeddedJson<GithubData>("github-review-data");
  const HAS_REVIEW = Object.keys(REVIEW).length > 0;
  const findingCursor: Record<string, number> = {};

  // ---- state ----
  let state: ReviewState = {
    general: {},
    lines: {},
    aiState: {},
    files: {},
    viewed: {},
    grouping: {},
    attachments: {},
  };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state = JSON.parse(raw) as ReviewState;
  } catch (e) {}
  state.general = state.general || {};
  state.lines = state.lines || {};
  state.aiState = state.aiState || {};
  state.files = state.files || {};
  state.viewed = state.viewed || {};
  state.grouping = state.grouping || {};
  state.attachments = state.attachments || {};

  // ---- syntax highlighting (highlight.js, loaded above; degrades offline) ----
  // Highlight a whole block and split into per-line HTML, keeping <span>s
  // balanced across newlines — so multi-line strings/comments and the enclosing
  // language context colour correctly (per-hunk, not per-line).
  function hlLines(code: string, lang: string): string[] {
    let html = null;
    if (window.hljs && lang) {
      try {
        html = window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch (e) {}
    }
    if (html == null) return code.split("\n").map(escAttr);
    const lines: string[] = [];
    let cur = "";
    const stack: string[] = [];
    const re = /<span\b[^>]*>|<\/span>|\n|[^<\n]+|</g;
    let m;
    while ((m = re.exec(html))) {
      const t = m[0];
      if (t === "\n") {
        lines.push(cur + "</span>".repeat(stack.length));
        cur = stack.join("");
      } else if (t.slice(0, 5) === "<span") {
        stack.push(t);
        cur += t;
      } else if (t === "</span>") {
        stack.pop();
        cur += t;
      } else {
        cur += t;
      }
    }
    lines.push(cur + "</span>".repeat(stack.length));
    return lines;
  }
  function highlightMarkdownCode(root: ParentNode): void {
    root.querySelectorAll("pre.md-code > code").forEach((code) => {
      const language = /(?:^|\s)language-([a-z0-9_+-]+)/i.exec(code.className)?.[1];
      if (!language) return;
      code.innerHTML = hlLines(code.textContent || "", language).join("\n");
      code.classList.add("hljs");
    });
  }
  // annotate each row in a hunk with its highlighted HTML (r._hl)
  function annotateHl(h: ClientHunk, lang: string): void {
    const newHl = hlLines(
      h.rows
        .filter((r) => r.t !== "d")
        .map((r) => r.c)
        .join("\n"),
      lang,
    );
    const oldHl = hlLines(
      h.rows
        .filter((r) => r.t !== "a")
        .map((r) => r.c)
        .join("\n"),
      lang,
    );
    let ni = 0,
      oi = 0;
    for (const r of h.rows) {
      if (r.t === "d") r._hl = oldHl[oi++];
      else if (r.t === "a") r._hl = newHl[ni++];
      else {
        r._hl = newHl[ni++];
        oi++;
      }
    }
  }
  const save = (): void => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {}
  };
  const uid = (pr?: string, file?: string, key?: string): string =>
    (pr ?? "") + "\0" + (file ?? "") + "\0" + (key ?? "");
  const escAttr = (s: unknown): string =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const cssEsc = (s: unknown): string => {
    try {
      return CSS.escape(String(s));
    } catch (e) {
      return String(s).replace(/"/g, '\\"');
    }
  };
  const attachmentId = (kind: string, pr?: string, file?: string, key?: string): string =>
    [kind, pr || "", file || "", key || ""].join("\0");
  const attachmentItems = (id: string): Attachment[] => state.attachments[id] || [];
  const hasAttachments = (id: string): boolean => attachmentItems(id).length > 0;
  const hasCommentContent = (text: unknown, id: string): boolean =>
    !!String(text || "").trim() || hasAttachments(id);
  function renderAttachmentTray(box: UiElement, id: string, onChange?: () => void): void {
    let tray = box.querySelector(".attachment-tray");
    if (!tray) {
      tray = document.createElement("div");
      tray.className = "attachment-tray";
      box.querySelector("textarea").after(tray);
    }
    tray.innerHTML = attachmentItems(id)
      .map(
        (item, index) =>
          `<figure class="comment-attachment"><img src="${escAttr(item.data)}" alt="Pasted image ${index + 1}"><button type="button" data-remove-attachment="${index}" title="Remove image">×</button></figure>`,
      )
      .join("");
    tray.hidden = !hasAttachments(id);
    tray.querySelectorAll("[data-remove-attachment]").forEach((button) =>
      button.addEventListener("click", () => {
        const items = attachmentItems(id).slice();
        items.splice(Number(button.dataset.removeAttachment), 1);
        if (items.length) state.attachments[id] = items;
        else delete state.attachments[id];
        save();
        renderAttachmentTray(box, id, onChange);
        if (onChange) onChange();
      }),
    );
  }
  function bindImagePaste(ta: UiElement, box: UiElement, id: string, onChange?: () => void): void {
    ta.title = "Paste text or an image from the clipboard";
    if (!box.querySelector(".paste-hint")) {
      const hint = document.createElement("div");
      hint.className = "paste-hint";
      hint.textContent = "Tip: paste a screenshot directly into this comment.";
      ta.after(hint);
    }
    renderAttachmentTray(box, id, onChange);
    ta.addEventListener("paste", (event) => {
      const files = [...(event.clipboardData?.items || [])]
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (!files.length) return;
      event.preventDefault();
      const available = Math.max(0, 4 - attachmentItems(id).length);
      if (!available) {
        window.alert("A comment can contain up to 4 pasted images.");
        return;
      }
      files.slice(0, available).forEach((file) => {
        if (file.size > 1.5 * 1024 * 1024) {
          window.alert("Pasted images must be 1.5 MB or smaller.");
          return;
        }
        const storedBytes = attachmentItems(id).reduce(
          (sum, item) => sum + String(item.data || "").length,
          0,
        );
        if (storedBytes + file.size * 1.4 > 3 * 1024 * 1024) {
          window.alert("Pasted images in one comment must stay under 3 MB total.");
          return;
        }
        const reader = new FileReader();
        reader.addEventListener("load", () => {
          const items = attachmentItems(id).slice();
          items.push({
            name: file.name || "pasted-image",
            type: file.type || "image/png",
            data: String(reader.result),
          });
          state.attachments[id] = items;
          if (onChange) onChange();
          save();
          renderAttachmentTray(box, id, onChange);
          updateCounts();
        });
        reader.readAsDataURL(file);
      });
    });
  }

  // ---- diff table builders (client-side, per mode) ----
  function gutter(
    file: string,
    key: string,
    lineno: number | undefined,
    c: string,
    lineFingerprint?: string,
    contentFingerprint?: string,
    diffFingerprint?: string,
  ): string {
    return `<td class="gutter" data-file="${escAttr(file)}" data-key="${escAttr(key)}" data-lineno="${lineno}" data-code="${escAttr(c)}" data-fingerprint="${escAttr(lineFingerprint || "")}" data-content-fingerprint="${escAttr(contentFingerprint || "")}" data-diff-fingerprint="${escAttr(diffFingerprint || "")}" title="Comment">+</td>`;
  }
  function unifiedTable(fd: ClientFile): string {
    let b = "";
    if (!fd.hunks.length) {
      b = `<tr class="line line-info"><td class="ln"></td><td class="ln"></td><td class="gutter empty"></td><td class="code"><em>${escAttr(fd.note || "")}</em></td></tr>`;
    } else
      for (const h of fd.hunks) {
        annotateHl(h, fd.lang);
        b += `<tr class="line line-hunk"><td class="ln"></td><td class="ln"></td><td class="gutter empty"></td><td class="code">@@ ${escAttr(h.header)}</td></tr>`;
        for (const r of h.rows) {
          const cls = r.t === "a" ? "line-add" : r.t === "d" ? "line-del" : "line-ctx";
          const marker = r.t === "a" ? "+" : r.t === "d" ? "-" : " ";
          const key = r.t === "d" ? "o" + r.o : String(r.n);
          const lineno = r.t === "d" ? r.o : r.n;
          b +=
            `<tr class="line ${cls}">` +
            `<td class="ln ln-old">${r.t !== "a" && r.o != null ? r.o : ""}</td>` +
            `<td class="ln ln-new">${r.t !== "d" && r.n != null ? r.n : ""}</td>` +
            gutter(fd.path, key, lineno, r.c, r.f, r.cf, fd.fingerprint) +
            `<td class="code"><span class="marker">${marker}</span>${r._hl}</td>` +
            `</tr>`;
        }
      }
    return `<table class="diff unified"><colgroup><col class="c-ln"><col class="c-ln"><col class="c-gut"><col></colgroup><tbody>${b}</tbody></table>`;
  }
  function splitPairs(h: ClientHunk): SplitPair[] {
    const out: SplitPair[] = [];
    let dels: ClientRow[] = [],
      adds: ClientRow[] = [];
    const flush = () => {
      const m = Math.max(dels.length, adds.length);
      for (let i = 0; i < m; i++) out.push({ l: dels[i] || null, r: adds[i] || null });
      dels = [];
      adds = [];
    };
    for (const r of h.rows) {
      if (r.t === "d") dels.push(r);
      else if (r.t === "a") adds.push(r);
      else {
        flush();
        out.push({ l: r, r: r, ctx: true });
      }
    }
    flush();
    return out;
  }
  function splitTable(fd: ClientFile): string {
    let b = "";
    if (!fd.hunks.length) {
      b = `<tr class="line line-info"><td class="ln"></td><td class="code" colspan="5"><em>${escAttr(fd.note || "")}</em></td></tr>`;
    } else
      for (const h of fd.hunks) {
        annotateHl(h, fd.lang);
        b += `<tr class="line line-hunk"><td class="ln"></td><td class="code" colspan="5">@@ ${escAttr(h.header)}</td></tr>`;
        for (const p of splitPairs(h)) {
          b += `<tr class="line">`;
          // left (old side)
          if (p.ctx && p.l && p.r) {
            b += `<td class="ln ln-old">${p.l.o != null ? p.l.o : ""}</td><td class="gutter empty"></td><td class="code line-ctx">${p.l._hl}</td>`;
          } else if (p.l) {
            b +=
              `<td class="ln ln-old">${p.l.o != null ? p.l.o : ""}</td>` +
              gutter(fd.path, "o" + p.l.o, p.l.o, p.l.c, p.l.f, p.l.cf, fd.fingerprint) +
              `<td class="code line-del">${p.l._hl}</td>`;
          } else {
            b += `<td class="ln"></td><td class="gutter empty"></td><td class="code empty"></td>`;
          }
          // right (new side)
          if (p.ctx && p.l && p.r) {
            b +=
              `<td class="ln ln-new">${p.r.n != null ? p.r.n : ""}</td>` +
              gutter(fd.path, String(p.r.n), p.r.n, p.r.c, p.r.f, p.r.cf, fd.fingerprint) +
              `<td class="code line-ctx">${p.r._hl}</td>`;
          } else if (p.r) {
            b +=
              `<td class="ln ln-new">${p.r.n != null ? p.r.n : ""}</td>` +
              gutter(fd.path, String(p.r.n), p.r.n, p.r.c, p.r.f, p.r.cf, fd.fingerprint) +
              `<td class="code line-add">${p.r._hl}</td>`;
          } else {
            b += `<td class="ln"></td><td class="gutter empty"></td><td class="code empty"></td>`;
          }
          b += `</tr>`;
        }
      }
    return `<table class="diff split"><colgroup><col class="c-ln"><col class="c-gut"><col><col class="c-ln"><col class="c-gut"><col></colgroup><tbody>${b}</tbody></table>`;
  }

  // ---- comment rows ----
  function createCommentRow(g: UiElement, prefill?: string, selectedStartKey?: string): UiElement {
    const tr = g.closest("tr");
    const mount = g.closest(".diff-mount");
    const pr = g.closest("section.pr").dataset.pr ?? "";
    const file = g.dataset.file ?? "",
      key = g.dataset.key ?? "";
    const id = uid(pr, file, key);
    const saved = state.lines[id];
    const attachId = attachmentId("line", pr, file, key);
    const existing = mount.querySelector('.comment-row[data-cid="' + cssEsc(id) + '"]');
    if (existing) {
      return existing.querySelector("textarea");
    }
    const crow = document.createElement("tr");
    crow.className = "comment-row";
    crow.dataset.cid = id;
    const td = document.createElement("td");
    td.colSpan = tr.children.length;
    const box = document.createElement("div");
    box.className = "comment-box";
    const meta = document.createElement("div");
    meta.className = "cb-meta";
    const location = document.createElement("span");
    const endLine = parseInt(g.dataset.lineno || "", 10);
    const oldSide = key.startsWith("o");
    const candidates = new Map<string, string>();
    const candidateFingerprints = new Map<string, string>();
    let candidateRow: Element | null = tr;
    while (candidateRow && !candidateRow.classList.contains("line-hunk")) {
      candidateRow
        .querySelectorAll('.gutter[data-file="' + cssEsc(file) + '"][data-key]')
        .forEach((candidate) => {
          const candidateKey = candidate.dataset.key || "";
          const candidateLine = parseInt(candidate.dataset.lineno || "", 10);
          if (
            candidateKey &&
            candidateKey.startsWith("o") === oldSide &&
            Number.isInteger(candidateLine) &&
            candidateLine <= endLine
          ) {
            candidates.set(candidateKey, String(candidateLine));
            candidateFingerprints.set(candidateKey, candidate.dataset.fingerprint || "");
          }
        });
      candidateRow = candidateRow.previousElementSibling;
    }
    const startSelect = document.createElement("select");
    startSelect.title = "Start line for a multi-line comment";
    [...candidates.entries()]
      .sort((left, right) => Number(left[1]) - Number(right[1]))
      .forEach(([candidateKey, candidateLine]) => {
        const option = document.createElement("option");
        option.value = candidateKey;
        option.textContent = candidateLine;
        startSelect.appendChild(option);
      });
    startSelect.value =
      selectedStartKey && candidates.has(selectedStartKey)
        ? selectedStartKey
        : saved?.startKey && candidates.has(saved.startKey)
          ? saved.startKey
          : key;
    const updateLocation = () => {
      const startLine = candidates.get(startSelect.value) || String(endLine);
      location.textContent =
        file +
        " · " +
        (startLine === String(endLine) ? "line " + endLine : "lines " + startLine + "–" + endLine);
    };
    updateLocation();
    const who = document.createElement("span");
    who.className = "who-you";
    who.textContent = "You";
    meta.append(who, location);
    const ta = document.createElement("textarea");
    ta.value = prefill || "";
    ta.placeholder = "Comment on this line…";
    const actions = document.createElement("div");
    actions.className = "comment-actions";
    const del = document.createElement("button");
    del.textContent = "Delete";
    const rangeLabel = document.createElement("label");
    rangeLabel.textContent = "Start line ";
    rangeLabel.appendChild(startSelect);
    actions.append(rangeLabel, del);
    box.append(meta, ta, actions);
    td.appendChild(box);
    crow.appendChild(td);
    tr.after(crow);
    const store = () => {
      state.lines[id] = {
        pr,
        file,
        key,
        startKey: startSelect.value,
        lineno: g.dataset.lineno,
        startLineno: candidates.get(startSelect.value) || g.dataset.lineno,
        code: g.dataset.code,
        text: ta.value,
        fingerprint: g.dataset.fingerprint || "",
        contentFingerprint: g.dataset.contentFingerprint || "",
        startFingerprint: candidateFingerprints.get(startSelect.value) || "",
        diffFingerprint: g.dataset.diffFingerprint || "",
      };
      save();
      updateCounts();
      renderOrphans();
    };
    bindImagePaste(ta, box, attachId, store);
    ta.addEventListener("input", store);
    startSelect.addEventListener("change", () => {
      updateLocation();
      store();
    });
    ta.addEventListener("blur", () => {
      if (!hasCommentContent(ta.value, attachId)) {
        delete state.lines[id];
        save();
        updateCounts();
        crow.remove();
      }
    });
    del.addEventListener("click", () => {
      delete state.lines[id];
      delete state.attachments[attachId];
      save();
      updateCounts();
      renderOrphans();
      crow.remove();
    });
    if (prefill && !saved) store();
    return ta;
  }
  function applyComments(mount: UiElement): void {
    const pr = mount.closest("section.pr").dataset.pr;
    for (const id in state.lines) {
      const c = state.lines[id];
      if (!c || c.pr !== pr) continue;
      const fingerprintSelector = c.fingerprint
        ? '.gutter[data-fingerprint="' +
          cssEsc(c.fingerprint) +
          '"][data-file="' +
          cssEsc(c.file) +
          '"]'
        : "";
      const contentSelector =
        c.contentFingerprint && uniqueContentFingerprint(c.pr, c.file, c.contentFingerprint)
          ? '.gutter[data-content-fingerprint="' +
            cssEsc(c.contentFingerprint) +
            '"][data-file="' +
            cssEsc(c.file) +
            '"]'
          : "";
      const g =
        (fingerprintSelector && mount.querySelector(fingerprintSelector)) ||
        (contentSelector && mount.querySelector(contentSelector)) ||
        (!c.fingerprint &&
          mount.querySelector(
            '.gutter[data-key="' + cssEsc(c.key) + '"][data-file="' + cssEsc(c.file) + '"]',
          ));
      if (g) {
        const rangePrefix = c.pr + "\0" + c.file + "\0";
        if (
          c.startKey &&
          c.startKey !== c.key &&
          (c.rangeStale ||
            !rangeStartMatchesAnchor(
              c.startFingerprint,
              lineEvidence().anchorFingerprints.get(rangePrefix + c.startKey),
            ))
        ) {
          continue;
        }
        const currentId = uid(pr, c.file, g.dataset.key);
        const oldKey = c.key;
        if (id !== currentId) {
          if (c.startKey && c.startKey !== oldKey) {
            c.rangeStale = true;
            save();
            continue;
          }
          const oldAttachmentId = attachmentId("line", c.pr, c.file, c.key);
          const newAttachmentId = attachmentId("line", pr, c.file, g.dataset.key);
          if (state.attachments[oldAttachmentId]) {
            state.attachments[newAttachmentId] = state.attachments[oldAttachmentId];
            delete state.attachments[oldAttachmentId];
          }
          delete state.lines[id];
          c.key = g.dataset.key;
          c.lineno = g.dataset.lineno;
          if (!c.startKey || c.startKey === oldKey) {
            c.startKey = g.dataset.key;
            c.startLineno = g.dataset.lineno;
          }
          c.code = g.dataset.code;
          c.diffFingerprint = g.dataset.diffFingerprint || "";
          state.lines[currentId] = c;
          save();
        }
        c.fingerprint = g.dataset.fingerprint || "";
        c.contentFingerprint = g.dataset.contentFingerprint || "";
        c.diffFingerprint = g.dataset.diffFingerprint || "";
        save();
        createCommentRow(g, c.text);
      }
    }
  }

  let lineEvidenceCache: LineEvidence | null = null;
  function lineEvidence(): LineEvidence {
    if (lineEvidenceCache) return lineEvidenceCache;
    const fingerprints = new Set<string>(),
      anchors = new Set<string>(),
      anchorFingerprints = new Map<string, string>(),
      content = new Map<string, Set<string>>();
    Object.values(DATA).forEach((file) => {
      (file.hunks || []).forEach((hunk) =>
        (hunk.rows || []).forEach((row) => {
          const prefix = file.reviewTarget + "\0" + file.path + "\0";
          const key = row.t === "d" ? "o" + row.o : String(row.n);
          if (row.f) fingerprints.add(prefix + row.f);
          anchors.add(prefix + key);
          anchorFingerprints.set(prefix + key, row.f);
          if (row.cf) {
            const contentKey = prefix + row.cf;
            const matches = content.get(contentKey) ?? new Set<string>();
            matches.add(row.f + "\0" + key);
            content.set(contentKey, matches);
          }
        }),
      );
    });
    lineEvidenceCache = { fingerprints, anchors, anchorFingerprints, content };
    return lineEvidenceCache;
  }
  function currentLineFingerprints(): Set<string> {
    return lineEvidence().fingerprints;
  }
  function currentLineAnchors(): Set<string> {
    return lineEvidence().anchors;
  }
  function uniqueContentFingerprint(pr: string, file: string, contentFingerprint: string): boolean {
    return lineEvidence().content.get(pr + "\0" + file + "\0" + contentFingerprint)?.size === 1;
  }
  function orphanedComments(): Array<[string, StoredLineComment]> {
    const current = currentLineFingerprints(),
      anchors = currentLineAnchors();
    return Object.entries(state.lines).filter(([, comment]) => {
      if (!comment) return false;
      const prefix = comment.pr + "\0" + comment.file + "\0";
      if (
        comment.startKey &&
        comment.startKey !== comment.key &&
        (comment.rangeStale ||
          !rangeStartMatchesAnchor(
            comment.startFingerprint,
            lineEvidence().anchorFingerprints.get(prefix + comment.startKey),
          ))
      ) {
        return true;
      }
      if (!comment.fingerprint) return !anchors.has(prefix + comment.key);
      if (current.has(prefix + comment.fingerprint)) return false;
      return !(
        comment.contentFingerprint &&
        uniqueContentFingerprint(comment.pr, comment.file, comment.contentFingerprint)
      );
    });
  }
  function renderOrphans(): void {
    const byPr: Record<string, Array<[string, StoredLineComment]>> = {};
    orphanedComments().forEach(([id, comment]) => {
      (byPr[comment.pr] = byPr[comment.pr] || []).push([id, comment]);
    });
    document.querySelectorAll("[data-orphan-list]").forEach((list) => {
      const items = byPr[list.dataset.orphanList] || [];
      const panel = list.closest(".orphan-panel");
      panel.hidden = !items.length;
      panel.querySelector(".orphan-count").textContent = String(items.length);
      list.innerHTML = items
        .map(
          ([id, c]) =>
            `<div class="orphan-item" data-orphan-id="${encodeURIComponent(id)}"><span class="orphan-loc">${escAttr(c.file)}:${escAttr(c.lineno || c.key)} · previous diff ${escAttr((c.diffFingerprint || "unknown").slice(0, 8))}</span><span class="orphan-text">${escAttr(c.text || "Pasted image")}</span><div class="comment-actions"><button type="button" data-delete-orphan>Delete</button></div></div>`,
        )
        .join("");
    });
  }
  document.addEventListener("click", (event) => {
    const button = eventElement(event)?.closest("[data-delete-orphan]");
    if (!button) return;
    const item = button.closest("[data-orphan-id]");
    const id = item ? decodeURIComponent(item.dataset.orphanId) : "";
    if (id) {
      const comment = state.lines[id];
      delete state.lines[id];
      if (comment)
        delete state.attachments[
          attachmentId("line", comment.pr || "", comment.file || "", comment.key || "")
        ];
      save();
      updateCounts();
      renderOrphans();
    }
  });

  // ---- LM review (inline rows + findings list) ----
  function insertAiRow(g: UiElement, c: AutomatedFinding, pr: string): void {
    const tr = g.closest("tr");
    const mount = g.closest(".diff-mount");
    const aiId = pr + " " + c.aid;
    if (mount.querySelector('.ai-comment[data-aid="' + cssEsc(aiId) + '"]')) return;
    const row = document.createElement("tr");
    row.className = "comment-row ai-comment sv-" + (c.severity || "comment");
    row.dataset.aid = aiId;
    const td = document.createElement("td");
    td.colSpan = tr.children.length;
    td.innerHTML = `<div class="ai-box">
      <div class="ai-box-head"><span class="who">✦ ${escAttr(REVIEWER)}</span><span class="sev sev-${escAttr(c.severity)}">${escAttr(c.severity)}</span><span class="ai-confidence">${Math.round(c.confidence * 100)}% confidence</span></div>
      <div class="ai-box-body">${renderFindingMarkdown(c.body)}</div>
      <div class="ai-rationale"><strong>Why:</strong> ${renderInlineMarkdown(c.rationale)}</div>
      <div class="ai-box-actions"><button data-a="accept">✓ Accept</button><button data-a="dismiss">✕ Dismiss</button><button data-a="reply">Reply</button><span class="ai-state"></span></div>
    </div>`;
    highlightMarkdownCode(td);
    row.appendChild(td);
    tr.after(row);
    const acc = td.querySelector('[data-a="accept"]'),
      dis = td.querySelector('[data-a="dismiss"]'),
      rep = td.querySelector('[data-a="reply"]'),
      st = td.querySelector(".ai-state");
    const refresh = () => {
      const s = state.aiState[aiId] || "";
      row.classList.toggle("dismissed", s === "dismissed");
      acc.classList.toggle("on-accept", s === "accepted");
      dis.classList.toggle("on-dismiss", s === "dismissed");
      st.textContent = s ? s : "";
    };
    const set = (s: "accepted" | "dismissed"): void => {
      if (state.aiState[aiId] === s) delete state.aiState[aiId];
      else state.aiState[aiId] = s;
      save();
      refresh();
      renderFindingList();
      updateProgress();
    };
    acc.addEventListener("click", () => set("accepted"));
    dis.addEventListener("click", () => set("dismissed"));
    rep.addEventListener("click", () => {
      const ta = createCommentRow(g, "");
      if (ta) ta.focus();
    });
    refresh();
  }
  function applyReview(mount: UiElement): void {
    if (!HAS_REVIEW) return;
    const pr = mount.closest("section.pr").dataset.pr;
    const rev = REVIEW[pr];
    if (!rev) return;
    for (const c of rev.comments) {
      const g = mount.querySelector(
        '.gutter[data-key="' + cssEsc(c.key) + '"][data-file="' + cssEsc(c.file) + '"]',
      );
      if (g) insertAiRow(g, c, pr);
    }
  }
  function renderFindingList(): void {
    if (!HAS_REVIEW) return;
    document.querySelectorAll("[data-finding-list]").forEach((list) => {
      const pr = list.dataset.findingList;
      const rev = REVIEW[pr];
      if (!rev) return;
      list.innerHTML = rev.comments
        .map((c) => {
          const s = state.aiState[pr + " " + c.aid] || "";
          const statusHtml = s ? `<span class="fi-status ${s}">${s}</span>` : "";
          return `<button class="finding-item sv-${escAttr(c.severity)}${s ? " done" : ""}" data-pr="${escAttr(pr)}" data-file="${escAttr(c.file)}" data-key="${escAttr(c.key)}" data-aid="${escAttr(c.aid)}"><span class="finding-top"><span class="sev sev-${escAttr(c.severity)}">${escAttr(c.severity)}</span><span class="finding-loc">${escAttr(c.file)}:${escAttr(c.line)}</span><span class="ai-confidence">${Math.round(c.confidence * 100)}% confidence</span>${statusHtml}</span><span class="finding-text">${renderInlineMarkdown(c.body)}</span></button>`;
        })
        .join("");
    });
  }

  // ---- render all mounts in a mode ----
  let renderGeneration = 0;
  function renderMount(mnt: UiElement, mode: "unified" | "split"): void {
    const fd = DATA[mnt.dataset.fid];
    if (!fd) return;
    mnt.innerHTML = mode === "split" ? splitTable(fd) : unifiedTable(fd);
    mnt.classList.remove("pending");
    mnt.dataset.rendered = mode;
    applyComments(mnt);
    applyReview(mnt);
  }
  function renderAll(mode: "unified" | "split"): void {
    const generation = ++renderGeneration;
    const mounts = [...document.querySelectorAll(".diff-mount")];
    mounts.forEach((mnt) => {
      mnt.innerHTML = "";
      delete mnt.dataset.rendered;
      mnt.classList.add("pending");
    });
    const pending = mounts;
    pending.slice(0, 4).forEach((mnt) => renderMount(mnt, mode));
    let cursor = 4;
    const pump = (deadline: IdleDeadline | null): void => {
      if (generation !== renderGeneration) return;
      let count = 0;
      while (cursor < pending.length && count < 8 && (!deadline || deadline.timeRemaining() > 2)) {
        renderMount(pending[cursor++], mode);
        count++;
      }
      if (cursor < pending.length) {
        requestIdleCallback(pump, { timeout: 120 });
      } else {
        renderOrphans();
      }
    };
    if (cursor < pending.length) {
      requestIdleCallback(pump, { timeout: 120 });
    } else renderOrphans();
  }

  // ---- counts ----
  function updateCounts(): void {
    let total = 0;
    const perFile: Record<string, number> = {},
      perPr: Record<string, number> = {};
    for (const k in state.lines) {
      const c = state.lines[k];
      if (!c || !hasCommentContent(c.text, attachmentId("line", c.pr, c.file, c.key))) continue;
      total++;
      perFile[c.pr + "\0" + c.file] = (perFile[c.pr + "\0" + c.file] || 0) + 1;
      perPr[c.pr] = (perPr[c.pr] || 0) + 1;
    }
    for (const k in state.files) {
      const c = state.files[k];
      if (!c || !hasCommentContent(c.text, attachmentId("file", c.pr, c.file, ""))) continue;
      total++;
      perFile[c.pr + "\0" + c.file] = (perFile[c.pr + "\0" + c.file] || 0) + 1;
      perPr[c.pr] = (perPr[c.pr] || 0) + 1;
    }
    const generalPrs = new Set([
      ...Object.keys(state.general),
      ...Object.keys(state.attachments)
        .filter((key) => key.startsWith("general\0"))
        .map((key) => key.split("\0")[1]),
    ]);
    for (const pr of generalPrs) {
      if (hasCommentContent(state.general[pr], attachmentId("general", pr, "", ""))) {
        total++;
        perPr[pr] = (perPr[pr] || 0) + 1;
      }
    }
    document.getElementById("commentCount").textContent =
      total + (total === 1 ? " comment" : " comments");
    document.querySelectorAll("[data-file-count]").forEach((b) => {
      const sec = b.closest("section.pr");
      const pr = sec ? sec.dataset.pr : "";
      const n = perFile[pr + "\0" + b.dataset.fileCount] || 0;
      if (n) {
        b.hidden = false;
        b.textContent = String(n);
      } else b.hidden = true;
    });
    document.querySelectorAll("[data-tab-count]").forEach((b) => {
      const n = perPr[b.dataset.tabCount] || 0;
      if (n) {
        b.hidden = false;
        b.textContent = String(n);
      } else b.hidden = true;
    });
    updateProgress();
    renderCommentList();
  }

  // ---- right-side progress dock (files viewed + findings reviewed) ----
  function ring(done: number, total: number, label: string): string {
    const pct = total ? done / total : 0;
    const r = 18,
      c = 2 * Math.PI * r,
      off = c * (1 - pct),
      complete = total > 0 && done === total;
    // centre shows a compact % (or ✓ when done) so it never overflows on big
    // reviews; the exact count lives in the fraction line below the ring.
    const center = complete ? "✓" : Math.round(pct * 100) + "%";
    return (
      `<div class="pd-item${complete ? " done" : ""}"><div class="pd-ringwrap">` +
      `<svg class="pd-ring" viewBox="0 0 46 46"><circle class="pd-track" cx="23" cy="23" r="${r}"/>` +
      `<circle class="pd-fill" cx="23" cy="23" r="${r}" style="stroke-dasharray:${c.toFixed(1)};stroke-dashoffset:${off.toFixed(1)}"/></svg>` +
      `<div class="pd-count">${center}</div></div><div class="pd-label">${label}</div><div class="pd-frac">${done}/${total}</div></div>`
    );
  }
  // the currently visible PR (tabbed reviews hide the others)
  function activeSection(): UiElement {
    return (
      [...document.querySelectorAll("section.pr")].find((s) => !s.hidden) ||
      document.querySelector("section.pr")
    );
  }
  function visibleEvidenceFiles(scope: ParentNode): UiElement[] {
    return [...scope.querySelectorAll(".file")].filter((file) => {
      const view = file.closest("[data-order-view]");
      return !view || !view.hidden;
    });
  }
  function updateProgress(): void {
    const dock = document.getElementById("progressDock");
    // scope to the active PR so the counts match that PR's header
    const scope = activeSection() || document;
    const evidenceFiles = visibleEvidenceFiles(scope);
    const grouped = !!scope.querySelector('[data-order-view="grouped"]:not([hidden])');
    const filesTotal = evidenceFiles.length;
    const filesViewed = evidenceFiles.filter((file) => file.classList.contains("viewed")).length;
    let html = filesTotal ? ring(filesViewed, filesTotal, grouped ? "Items" : "Files") : "";
    if (HAS_REVIEW) {
      const pr = scope.dataset.pr || "";
      const prs = pr ? [pr] : Object.keys(REVIEW);
      let ftotal = 0,
        fdone = 0;
      for (const p of prs) {
        const rv = REVIEW[p];
        if (!rv) continue;
        for (const c of rv.comments) {
          ftotal++;
          if (state.aiState[p + " " + c.aid]) fdone++;
        }
      }
      if (ftotal) html += ring(fdone, ftotal, "Reviewed");
      const rv = pr ? REVIEW[pr] : null;
      if (rv?.comments?.length) {
        const cursor = Math.max(0, Math.min(findingCursor[pr] ?? 0, rv.comments.length - 1));
        findingCursor[pr] = cursor;
        html +=
          `<div class="pd-find-nav"><div class="pd-find-label">Finding ${cursor + 1}/${rv.comments.length}</div>` +
          `<button type="button" data-finding-step="-1" title="Previous finding">← Prev</button>` +
          `<button type="button" data-finding-step="1" title="Next finding">Next →</button></div>`;
      }
    }
    dock.innerHTML = html;
    dock.hidden = !html;
    document.body.classList.toggle("has-dock", !!html);
  }
  document.addEventListener("click", (e) => {
    const button = eventElement(e)?.closest("[data-finding-step]");
    if (!button) return;
    const sec = activeSection(),
      pr = sec?.dataset.pr,
      rv = pr ? REVIEW[pr] : null;
    if (!rv?.comments?.length) return;
    const step = Number(button.dataset.findingStep);
    const current = findingCursor[pr] ?? 0;
    const next = (current + step + rv.comments.length) % rv.comments.length;
    findingCursor[pr] = next;
    const item = sec.querySelector(
      '.finding-item[data-aid="' + cssEsc(rv.comments[next].aid) + '"]',
    );
    if (item) item.click();
    updateProgress();
  });

  // ---- sidebar comment list (file notes + line comments) ----
  function renderCommentList(): void {
    document.querySelectorAll("[data-comment-list]").forEach((list) => {
      const pr = list.dataset.commentList;
      let html = "",
        count = 0;
      for (const k in state.files) {
        const c = state.files[k];
        if (!c || c.pr !== pr || !hasCommentContent(c.text, attachmentId("file", c.pr, c.file, "")))
          continue;
        count++;
        html += `<button class="cl-item cl-file" data-pr="${escAttr(pr)}" data-file="${escAttr(c.file)}"><span class="cl-loc">📄 ${escAttr(c.file)}</span><span class="cl-text">${escAttr(c.text || "📎 Pasted image")}</span></button>`;
      }
      const items: StoredLineComment[] = [];
      for (const id in state.lines) {
        const c = state.lines[id];
        if (
          !c ||
          c.pr !== pr ||
          !hasCommentContent(c.text, attachmentId("line", c.pr, c.file, c.key))
        )
          continue;
        items.push(c);
      }
      items.sort((a, b) =>
        a.file < b.file
          ? -1
          : a.file > b.file
            ? 1
            : (parseInt(a.lineno ?? "") || 0) - (parseInt(b.lineno ?? "") || 0),
      );
      for (const c of items) {
        count++;
        html += `<button class="cl-item" data-pr="${escAttr(pr)}" data-file="${escAttr(c.file)}" data-key="${escAttr(c.key)}"><span class="cl-loc">${escAttr(c.file)}:${escAttr(c.lineno)}</span><span class="cl-text">${escAttr(c.text || "📎 Pasted image")}</span></button>`;
      }
      list.innerHTML = count
        ? html
        : '<div class="cl-empty">No comments yet. Hover a diff line and click + — or 💬 on a file header.</div>';
      const cnt = list.closest(".cl-wrap")?.querySelector("[data-cl-count]");
      if (cnt) cnt.textContent = String(count);
    });
  }
  // jump to a line / file / finding from a list item
  document.addEventListener("click", (e) => {
    const it = eventElement(e)?.closest(".cl-item, .finding-item");
    if (!it) return;
    const sec = document.querySelector('section.pr[data-pr="' + cssEsc(it.dataset.pr) + '"]');
    if (!sec) return;
    if (it.classList.contains("finding-item")) {
      const comments = REVIEW[it.dataset.pr]?.comments || [];
      const index = comments.findIndex((comment) => comment.aid === it.dataset.aid);
      if (index >= 0) {
        findingCursor[it.dataset.pr] = index;
        updateProgress();
      }
    }
    if (it.classList.contains("cl-file")) {
      const fileEl = visibleEvidenceFiles(sec).find((f) => f.dataset.file === it.dataset.file);
      if (fileEl) {
        fileEl.classList.remove("collapsed");
        fileEl.scrollIntoView({ block: "start", behavior: "smooth" });
        fileNoteBox(
          fileEl,
          (state.files[it.dataset.pr + " " + it.dataset.file] || {}).text || "",
          true,
        );
      }
      return;
    }
    const g = visibleEvidenceFiles(sec)
      .map((file) =>
        file.querySelector(
          '.gutter[data-key="' +
            cssEsc(it.dataset.key) +
            '"][data-file="' +
            cssEsc(it.dataset.file) +
            '"]',
        ),
      )
      .find(Boolean);
    if (!g) return;
    const file = g.closest(".file");
    if (file) file.classList.remove("collapsed");
    const group = g.closest(".group");
    if (group) group.classList.remove("collapsed");
    const outOfScope = g.closest("[data-out-of-scope]");
    if (outOfScope) outOfScope.hidden = false;
    g.scrollIntoView({ block: "center", behavior: "smooth" });
    if (it.classList.contains("cl-item")) {
      const ta = createCommentRow(g, "");
      if (ta) ta.focus();
    }
  });

  // ---- events: comment gutter (delegated, survives re-render) ----
  document.getElementById("main").addEventListener("click", (e) => {
    const g = eventElement(e)?.closest(".gutter");
    if (!g || g.classList.contains("empty") || !g.dataset.key) return;
    if (g.dataset.rangeClick === "ignore") {
      delete g.dataset.rangeClick;
      return;
    }
    const ta = createCommentRow(g, "");
    if (ta) ta.focus();
  });

  // ---- drag-select a contiguous diff range ----
  const rangeToolbar = document.getElementById("rangeToolbar");
  let rangeDrag:
    | {
        anchor: UiElement;
        current: UiElement;
        moved: boolean;
        x: number;
        y: number;
      }
    | undefined;
  let activeRange: DiffRangeSelection | undefined;

  function selectableGutters(anchor: UiElement): UiElement[] {
    const table = anchor.closest("table.diff");
    const anchorRow = anchor.closest("tr");
    if (!table || !anchorRow) return [];
    const rows = [...table.querySelectorAll("tr")];
    const anchorIndex = rows.indexOf(anchorRow);
    let first = anchorIndex;
    let last = anchorIndex + 1;
    while (first > 0 && !rows[first - 1].classList.contains("line-hunk")) first--;
    while (last < rows.length && !rows[last].classList.contains("line-hunk")) last++;
    const oldSide = (anchor.dataset.key || "").startsWith("o");
    return rows
      .slice(first, last)
      .flatMap((row) => [...row.querySelectorAll(".gutter[data-key]")])
      .filter(
        (gutter) =>
          gutter.dataset.file === anchor.dataset.file &&
          (gutter.dataset.key || "").startsWith("o") === oldSide,
      );
  }

  function rangeFor(anchor: UiElement, current: UiElement): DiffRangeSelection | undefined {
    const candidates = selectableGutters(anchor);
    const anchorIndex = candidates.indexOf(anchor);
    const currentIndex = candidates.indexOf(current);
    if (anchorIndex < 0 || currentIndex < 0) return undefined;
    const [from, to] =
      anchorIndex <= currentIndex ? [anchorIndex, currentIndex] : [currentIndex, anchorIndex];
    const gutters = candidates.slice(from, to + 1);
    const rows = gutters.map((gutter) => {
      const tableRow = gutter.closest("tr");
      const codeCell = gutter.nextElementSibling;
      return {
        line: gutter.dataset.lineno || gutter.dataset.key || "",
        code: gutter.dataset.code || "",
        kind:
          tableRow.classList.contains("line-add") || codeCell?.classList.contains("line-add")
            ? ("add" as const)
            : tableRow.classList.contains("line-del") || codeCell?.classList.contains("line-del")
              ? ("del" as const)
              : ("ctx" as const),
      };
    });
    return {
      file: anchor.dataset.file || "",
      oldSide: (anchor.dataset.key || "").startsWith("o"),
      gutters,
      tableRows: [...new Set(gutters.map((gutter) => gutter.closest("tr")))],
      start: gutters[0],
      end: gutters[gutters.length - 1],
      rows,
    };
  }

  function clearRangeVisuals(): void {
    document.querySelectorAll(".range-selected-cell").forEach((cell) => {
      cell.classList.remove("range-selected-cell");
    });
  }

  function paintRange(selection: DiffRangeSelection): void {
    clearRangeVisuals();
    for (const gutter of selection.gutters) {
      gutter.classList.add("range-selected-cell");
      gutter.previousElementSibling?.classList.add("range-selected-cell");
      gutter.nextElementSibling?.classList.add("range-selected-cell");
    }
  }

  function hideRangeToolbar(clear = true): void {
    rangeToolbar.hidden = true;
    if (clear) {
      activeRange = undefined;
      clearRangeVisuals();
    }
  }

  function showRangeToolbar(selection: DiffRangeSelection, x: number, y: number): void {
    activeRange = selection;
    paintRange(selection);
    const first = selection.rows[0]?.line || "";
    const last = selection.rows.at(-1)?.line || first;
    rangeToolbar.querySelector("[data-range-location]").textContent =
      selection.file + " · " + (first === last ? "line " + first : "lines " + first + "–" + last);
    rangeToolbar.querySelector("[data-range-suggest]").hidden = selection.oldSide;
    rangeToolbar.hidden = false;
    const width = rangeToolbar.offsetWidth;
    const height = rangeToolbar.offsetHeight;
    rangeToolbar.style.left = Math.max(12, Math.min(window.innerWidth - width - 12, x + 10)) + "px";
    rangeToolbar.style.top =
      Math.max(12, Math.min(window.innerHeight - height - 12, y + 10)) + "px";
  }

  document.getElementById("main").addEventListener("mousedown", (event) => {
    const mouse = event as MouseEvent;
    const gutter = eventElement(event)?.closest(".gutter[data-key]");
    if (!gutter || gutter.classList.contains("empty") || mouse.button !== 0) return;
    hideRangeToolbar();
    rangeDrag = {
      anchor: gutter,
      current: gutter,
      moved: false,
      x: mouse.clientX,
      y: mouse.clientY,
    };
  });

  document.addEventListener("mousemove", (event) => {
    if (!rangeDrag) return;
    const mouse = event as MouseEvent;
    const target = document
      .elementFromPoint(mouse.clientX, mouse.clientY)
      ?.closest(".gutter[data-key]") as UiElement | null;
    if (!target || !selectableGutters(rangeDrag.anchor).includes(target)) return;
    rangeDrag.current = target;
    rangeDrag.moved ||= target !== rangeDrag.anchor;
    rangeDrag.x = mouse.clientX;
    rangeDrag.y = mouse.clientY;
    const selection = rangeFor(rangeDrag.anchor, target);
    if (selection) paintRange(selection);
    event.preventDefault();
  });

  document.addEventListener("mouseup", () => {
    if (!rangeDrag) return;
    const drag = rangeDrag;
    rangeDrag = undefined;
    if (!drag.moved) {
      clearRangeVisuals();
      return;
    }
    const selection = rangeFor(drag.anchor, drag.current);
    if (!selection) {
      clearRangeVisuals();
      return;
    }
    drag.current.dataset.rangeClick = "ignore";
    showRangeToolbar(selection, drag.x, drag.y);
  });

  rangeToolbar.querySelector("[data-range-comment]").addEventListener("click", () => {
    if (!activeRange) return;
    const ta = createCommentRow(activeRange.end, "", activeRange.start.dataset.key);
    hideRangeToolbar();
    ta?.focus();
  });

  rangeToolbar.querySelector("[data-range-suggest]").addEventListener("click", () => {
    if (!activeRange || activeRange.oldSide) return;
    const replacement = activeRange.rows.map((row) => row.code).join("\n");
    const ta = createCommentRow(
      activeRange.end,
      "```suggestion\n" + replacement + "\n```",
      activeRange.start.dataset.key,
    );
    hideRangeToolbar();
    ta?.focus();
    ta?.setSelectionRange(14, 14 + replacement.length);
  });

  rangeToolbar.querySelector("[data-range-image]").addEventListener("click", () => {
    if (!activeRange) return;
    openCarbonExport(activeRange);
    hideRangeToolbar();
  });

  const carbonModal = document.getElementById("carbonModal");
  const carbonSelectable = document.getElementById("carbonSelectable");
  const carbonCanvas = document.getElementById("carbonCanvas") as unknown as HTMLCanvasElement;
  type CarbonTheme = "aurora" | "sunset" | "forest" | "slate";
  const carbonThemes: Record<
    CarbonTheme,
    { css: string; office: string; stops: [string, string, string] }
  > = {
    aurora: {
      css: "linear-gradient(125deg,#7c3aed,#2563eb 52%,#0891b2)",
      office: "#3155c6",
      stops: ["#7c3aed", "#2563eb", "#0891b2"],
    },
    sunset: {
      css: "linear-gradient(125deg,#db2777,#ea580c 52%,#f59e0b)",
      office: "#dc5a25",
      stops: ["#db2777", "#ea580c", "#f59e0b"],
    },
    forest: {
      css: "linear-gradient(125deg,#166534,#059669 52%,#0f766e)",
      office: "#14745c",
      stops: ["#166534", "#059669", "#0f766e"],
    },
    slate: {
      css: "linear-gradient(125deg,#334155,#475569 52%,#1e293b)",
      office: "#3e4b5d",
      stops: ["#334155", "#475569", "#1e293b"],
    },
  };
  let carbonFilenameBase = "diff-selection";
  let carbonLayout: "split" | "compact" = "split";
  let carbonTheme: CarbonTheme = "aurora";
  let carbonFile = "";
  let carbonRows: ExportPairRow[] = [];
  let carbonHtml = "";
  let carbonClipboardHtml = "";
  let carbonSvg = "";
  let carbonPlain = "";

  function roundRect(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.arcTo(x + width, y, x + width, y + height, radius);
    context.arcTo(x + width, y + height, x, y + height, radius);
    context.arcTo(x, y + height, x, y, radius);
    context.arcTo(x, y, x + width, y, radius);
    context.closePath();
  }

  function changedTableRow(row: UiElement): boolean {
    return row.classList.contains("line-add") || row.classList.contains("line-del");
  }

  function selectedExportRows(selection: DiffRangeSelection): UiElement[] {
    const table = selection.start.closest("table.diff");
    if (table.classList.contains("split")) return selection.tableRows;
    const rows = [...table.querySelectorAll("tr.line")].filter(
      (row) => !row.classList.contains("line-hunk") && !row.classList.contains("line-info"),
    );
    const included = new Set(selection.tableRows);
    for (const selected of selection.tableRows) {
      if (!changedTableRow(selected)) continue;
      const index = rows.indexOf(selected);
      let first = index;
      let last = index;
      while (first > 0 && changedTableRow(rows[first - 1])) first--;
      while (last + 1 < rows.length && changedTableRow(rows[last + 1])) last++;
      const cluster = rows.slice(first, last + 1);
      const hasBefore = cluster.some((row) => row.classList.contains("line-del"));
      const hasAfter = cluster.some((row) => row.classList.contains("line-add"));
      if (hasBefore && hasAfter) cluster.forEach((row) => included.add(row));
    }
    return rows.filter((row) => included.has(row));
  }

  function buildExportRows(selection: DiffRangeSelection): ExportPairRow[] {
    const table = selection.start.closest("table.diff");
    let rows: ExportPairRow[];
    if (table.classList.contains("split")) {
      rows = selectedExportRows(selection).map((row) => {
        const cells = [...row.children] as UiElement[];
        const oldCode = cells[2];
        const newCode = cells[5];
        return {
          ...(oldCode && !oldCode.classList.contains("empty")
            ? {
                old: {
                  line: cells[0]?.textContent || "",
                  code: oldCode.textContent || "",
                  kind: oldCode.classList.contains("line-del")
                    ? ("del" as const)
                    : ("ctx" as const),
                },
              }
            : {}),
          ...(newCode && !newCode.classList.contains("empty")
            ? {
                next: {
                  line: cells[3]?.textContent || "",
                  code: newCode.textContent || "",
                  kind: newCode.classList.contains("line-add")
                    ? ("add" as const)
                    : ("ctx" as const),
                },
              }
            : {}),
        };
      });
    } else {
      rows = [];
      let deleted: ExportSide[] = [];
      let added: ExportSide[] = [];
      const flush = () => {
        const count = Math.max(deleted.length, added.length);
        for (let index = 0; index < count; index++) {
          rows.push({ old: deleted[index], next: added[index] });
        }
        deleted = [];
        added = [];
      };
      for (const row of selectedExportRows(selection)) {
        const cells = [...row.children] as UiElement[];
        const gutter = cells[2];
        const code = gutter?.dataset.code || "";
        if (row.classList.contains("line-del")) {
          deleted.push({ line: cells[0]?.textContent || "", code, kind: "del" });
        } else if (row.classList.contains("line-add")) {
          added.push({ line: cells[1]?.textContent || "", code, kind: "add" });
        } else {
          flush();
          rows.push({
            old: { line: cells[0]?.textContent || "", code, kind: "ctx" },
            next: { line: cells[1]?.textContent || "", code, kind: "ctx" },
          });
        }
      }
      flush();
    }

    const lang = Object.values(DATA).find((file) => file.path === selection.file)?.lang || "";
    const oldHighlights = hlLines(rows.map((row) => row.old?.code || "").join("\n"), lang);
    const newHighlights = hlLines(rows.map((row) => row.next?.code || "").join("\n"), lang);
    rows.forEach((row, index) => {
      if (row.old) row.old.html = oldHighlights[index];
      if (row.next) row.next.html = newHighlights[index];
    });
    return rows;
  }

  function syntaxColor(classes: string): string {
    if (/(?:^|\s)hljs-(comment|quote|meta)(?:\s|$)/.test(classes)) return "#8b949e";
    if (/(?:^|\s)hljs-(keyword|selector-tag|subst)(?:\s|$)/.test(classes)) return "#ff7b72";
    if (/(?:^|\s)hljs-(string|regexp|doctag)(?:\s|$)/.test(classes)) return "#a5d6ff";
    if (/(?:^|\s)hljs-(number|literal|symbol|bullet)(?:\s|$)/.test(classes)) return "#79c0ff";
    if (/(?:^|\s)hljs-(title|section|function)(?:\s|$)/.test(classes)) return "#d2a8ff";
    if (/(?:^|\s)hljs-(type|built_in|class)(?:\s|$)/.test(classes)) return "#ffa657";
    if (/(?:^|\s)hljs-(attr|attribute|property|variable)(?:\s|$)/.test(classes)) return "#79c0ff";
    return "#e6edf3";
  }

  function syntaxSegments(html: string): Array<{ text: string; color: string }> {
    const wrapper = document.createElement("span");
    wrapper.innerHTML = html;
    const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
    const segments: Array<{ text: string; color: string }> = [];
    let node = walker.nextNode();
    while (node) {
      let parent = node.parentElement;
      let classes = "";
      while (parent && parent !== wrapper) {
        classes += " " + parent.className;
        parent = parent.parentElement;
      }
      segments.push({ text: node.textContent || "", color: syntaxColor(classes) });
      node = walker.nextNode();
    }
    return segments.length ? segments : [{ text: wrapper.textContent || "", color: "#e6edf3" }];
  }

  function inlineSyntax(html: string): string {
    return html.replace(
      /<span class="([^"]+)">/g,
      (_match, classes: string) => `<span style="color:${syntaxColor(classes)}">`,
    );
  }

  function officeSyntax(html: string): string {
    return inlineSyntax(html)
      .split(/(<[^>]+>)/g)
      .map((part) =>
        part.startsWith("<") ? part : part.replace(/\t/g, "    ").replace(/ /g, "&nbsp;"),
      )
      .join("");
  }

  function previewSide(side?: ExportSide): string {
    if (!side) return `<td></td>`;
    const marker = side.kind === "add" ? "+" : side.kind === "del" ? "−" : " ";
    return (
      `<td class="${side.kind}"><span class="carbon-line">${escAttr(side.line)}</span>` +
      `<span class="carbon-marker">${marker}</span>` +
      `<span class="carbon-code">${side.html || escAttr(side.code)}</span></td>`
    );
  }

  function compactExportRows(rows: ExportPairRow[]): ExportSide[] {
    return rows.flatMap((row) => {
      if (row.old?.kind === "ctx" && row.next?.kind === "ctx" && row.old.code === row.next.code) {
        return [row.next];
      }
      return [row.old, row.next].filter((side): side is ExportSide => !!side);
    });
  }

  function selectableExportWidth(rows: ExportPairRow[], layout: "split" | "compact"): number {
    const longest = Math.max(
      28,
      ...rows.flatMap((row) => [row.old?.code.length || 0, row.next?.code.length || 0]),
    );
    return layout === "compact"
      ? Math.max(640, 150 + longest * 8.2)
      : Math.max(720, 240 + longest * 16.4);
  }

  function carbonPreview(file: string, rows: ExportPairRow[], layout: "split" | "compact"): string {
    const table =
      layout === "compact"
        ? `<table class="carbon-table compact"><thead><tr><th>Unified diff</th></tr></thead><tbody>` +
          compactExportRows(rows)
            .map((side) => `<tr>${previewSide(side)}</tr>`)
            .join("") +
          `</tbody></table>`
        : `<table class="carbon-table"><thead><tr><th>Before</th><th>After</th></tr></thead><tbody>` +
          rows.map((row) => `<tr>${previewSide(row.old)}${previewSide(row.next)}</tr>`).join("") +
          `</tbody></table>`;
    return (
      `<div class="carbon-sheet" style="width:${selectableExportWidth(rows, layout)}px;background:${carbonThemes[carbonTheme].css}"><div class="carbon-window">` +
      `<div class="carbon-window-head"><span class="carbon-dots">` +
      `<span class="carbon-dot" style="background:#ff5f56"></span>` +
      `<span class="carbon-dot" style="background:#ffbd2e"></span>` +
      `<span class="carbon-dot" style="background:#27c93f"></span></span>` +
      `<span class="carbon-window-title">${escAttr(file)}</span><span></span></div>` +
      table +
      `</div></div>`
    );
  }

  function richSide(side: ExportSide | undefined, border: boolean): string {
    const borderStyle = border ? "border-left:1px solid #30363d;" : "";
    if (!side) return `<td style="${borderStyle}height:24px;padding:0 12px"></td>`;
    const marker = side.kind === "add" ? "+" : side.kind === "del" ? "−" : " ";
    const background =
      side.kind === "add"
        ? "rgba(46,160,67,.18)"
        : side.kind === "del"
          ? "rgba(248,81,73,.16)"
          : "transparent";
    const markerColor =
      side.kind === "add" ? "#3fb950" : side.kind === "del" ? "#f85149" : "#8b949e";
    return (
      `<td style="${borderStyle}height:24px;padding:0 12px;white-space:pre;vertical-align:top;background:${background}">` +
      `<span style="display:inline-block;width:44px;margin-right:8px;color:#6e7681;text-align:right">${escAttr(side.line)}</span>` +
      `<span style="display:inline-block;width:18px;color:${markerColor}">${marker}</span>` +
      `<span style="color:#e6edf3">${inlineSyntax(side.html || escAttr(side.code))}</span></td>`
    );
  }

  function carbonRichDocument(file: string, rows: ExportPairRow[]): string {
    const body =
      `<div style="box-sizing:border-box;width:${selectableExportWidth(rows, "split")}px;padding:24px;border-radius:16px;background:linear-gradient(125deg,#7c3aed,#2563eb 52%,#0891b2)">` +
      `<div style="overflow:hidden;border-radius:14px;color:#e6edf3;background:#0d1117">` +
      `<div style="padding:16px 20px;color:#c9d1d9;font:600 13px ui-monospace,monospace;text-align:center">${escAttr(file)}</div>` +
      `<table style="width:100%;border-collapse:collapse;table-layout:fixed;font:13px/24px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">` +
      `<thead><tr><th style="padding:4px 12px;color:#8b949e;background:#161b22;text-align:left">Before</th>` +
      `<th style="padding:4px 12px;color:#8b949e;background:#161b22;text-align:left;border-left:1px solid #30363d">After</th></tr></thead><tbody>` +
      rows
        .map((row) => `<tr>${richSide(row.old, false)}${richSide(row.next, true)}</tr>`)
        .join("") +
      `</tbody></table></div></div>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escAttr(file)} diff</title></head><body>${body}</body></html>`;
  }

  function powerPointSide(
    side: ExportSide,
    border: boolean,
    fontSize: number,
    width: number,
  ): string {
    const borderStyle = border ? "border-left:1px solid #30363d;" : "";
    const background =
      side.kind === "add" ? "#17351f" : side.kind === "del" ? "#351b20" : "#0d1117";
    const widthPoints = width === 960 ? 720 : 360;
    const lineHeight = Math.max(7, fontSize + 1.5);
    const marker = side.kind === "add" ? "+" : side.kind === "del" ? "−" : " ";
    const markerColor =
      side.kind === "add" ? "#3fb950" : side.kind === "del" ? "#f85149" : "#8b949e";
    return (
      `<td width="${width}" bgcolor="${background}" style="${borderStyle}width:${widthPoints}pt;height:${lineHeight}pt;padding:0 5pt;background:${background};` +
      `font-family:Consolas,'Courier New',monospace;font-size:${fontSize}pt;line-height:${lineHeight}pt;mso-line-height-rule:exactly;color:#e6edf3;white-space:nowrap">` +
      `<nobr><span style="display:inline-block;width:28pt;color:#8b949e;text-align:right">${escAttr(side.line)}</span>` +
      `<span style="display:inline-block;width:12pt;color:${markerColor}">${marker}</span>` +
      `<span style="color:#e6edf3;mso-no-proof:yes;mso-spacerun:yes">${officeSyntax(side.html || escAttr(side.code))}</span></nobr></td>`
    );
  }

  function powerPointEmptySide(border: boolean, fontSize: number, width: number): string {
    const borderStyle = border ? "border-left:1px solid #30363d;" : "";
    const widthPoints = width === 960 ? 720 : 360;
    const lineHeight = Math.max(7, fontSize + 1.5);
    return `<td width="${width}" bgcolor="#0d1117" style="${borderStyle}width:${widthPoints}pt;height:${lineHeight}pt;padding:0 5pt;background:#0d1117;font-size:${fontSize}pt;line-height:${lineHeight}pt;mso-line-height-rule:exactly">&nbsp;</td>`;
  }

  function powerPointClipboardTable(
    file: string,
    rows: ExportPairRow[],
    layout: "split" | "compact",
  ): string {
    const exportRows = layout === "compact" ? compactExportRows(rows) : [];
    const longest = Math.max(
      28,
      ...(layout === "compact"
        ? exportRows.map((row) => row.code.length)
        : rows.flatMap((row) => [row.old?.code.length || 0, row.next?.code.length || 0])),
    );
    const availableWidth = layout === "compact" ? 1000 : 500;
    const fontSize = Math.max(5, Math.min(8.5, Math.floor((availableWidth / longest) * 4) / 4));
    const columnCount = layout === "compact" ? 1 : 2;
    const accent = carbonThemes[carbonTheme].office;
    const frameCell = `<td width="20" bgcolor="${accent}" style="width:15pt;padding:0;background:${accent}">&nbsp;</td>`;
    const before = rows.flatMap((row) => (row.old ? [row.old] : []));
    const after = rows.flatMap((row) => (row.next ? [row.next] : []));
    const heading =
      layout === "compact"
        ? `<tr>${frameCell}<td width="960" bgcolor="#161b22" style="width:720pt;height:14pt;padding:0 6pt;background:#161b22;color:#8b949e;` +
          `font-family:Arial,sans-serif;font-size:7pt;font-weight:bold;text-transform:uppercase">UNIFIED DIFF</td>${frameCell}</tr>`
        : `<tr>${frameCell}<td width="480" bgcolor="#161b22" style="width:360pt;height:14pt;padding:0 6pt;background:#161b22;color:#8b949e;` +
          `font-family:Arial,sans-serif;font-size:7pt;font-weight:bold;text-transform:uppercase">BEFORE</td>` +
          `<td width="480" bgcolor="#161b22" style="width:360pt;height:14pt;padding:0 6pt;border-left:1px solid #30363d;` +
          `background:#161b22;color:#8b949e;font-family:Arial,sans-serif;font-size:7pt;font-weight:bold;text-transform:uppercase">AFTER</td>${frameCell}</tr>`;
    const body =
      layout === "compact"
        ? exportRows
            .map(
              (row) =>
                `<tr>${frameCell}${powerPointSide(row, false, fontSize, 960)}${frameCell}</tr>`,
            )
            .join("")
        : Array.from({ length: Math.max(before.length, after.length) }, (_, index) => {
            const oldCell = before[index]
              ? powerPointSide(before[index], false, fontSize, 480)
              : powerPointEmptySide(false, fontSize, 480);
            const nextCell = after[index]
              ? powerPointSide(after[index], true, fontSize, 480)
              : powerPointEmptySide(true, fontSize, 480);
            return `<tr>${frameCell}${oldCell}${nextCell}${frameCell}</tr>`;
          }).join("");
    return (
      `<table width="1000" border="0" cellspacing="0" cellpadding="0" bgcolor="${accent}" ` +
      `style="width:750pt;border-collapse:collapse;table-layout:fixed;background:${accent}">` +
      `<tr><td colspan="${columnCount + 2}" bgcolor="${accent}" style="height:14pt;padding:0;background:${accent}">&nbsp;</td></tr>` +
      `<tr>${frameCell}<td colspan="${columnCount}" align="center" bgcolor="#0d1117" style="height:24pt;padding:0 8pt;background:#0d1117;` +
      `font-family:Consolas,'Courier New',monospace;font-size:9pt;font-weight:bold;color:#c9d1d9">` +
      `<span style="float:left;font-family:Arial,sans-serif;font-size:10pt;white-space:nowrap">` +
      `<span style="color:#ff5f56">●</span>&nbsp;<span style="color:#ffbd2e">●</span>&nbsp;<span style="color:#27c93f">●</span></span>` +
      `${escAttr(file)}</td>${frameCell}</tr>` +
      heading +
      body +
      `<tr><td colspan="${columnCount + 2}" bgcolor="${accent}" style="height:14pt;padding:0;background:${accent}">&nbsp;</td></tr>` +
      `</table>`
    );
  }

  function carbonPlainText(rows: ExportPairRow[]): string {
    return [
      "Before\tAfter",
      ...rows.map((row) => {
        const old = row.old
          ? `${row.old.line} ${row.old.kind === "del" ? "-" : " "} ${row.old.code}`
          : "";
        const next = row.next
          ? `${row.next.line} ${row.next.kind === "add" ? "+" : " "} ${row.next.code}`
          : "";
        return old + "\t" + next;
      }),
    ].join("\n");
  }

  function svgCode(side: ExportSide | undefined, x: number, y: number): string {
    if (!side) return "";
    const marker = side.kind === "add" ? "+" : side.kind === "del" ? "−" : " ";
    const markerColor =
      side.kind === "add" ? "#3fb950" : side.kind === "del" ? "#f85149" : "#8b949e";
    const spans = syntaxSegments(side.html || escAttr(side.code))
      .map((segment) => `<tspan fill="${segment.color}">${escAttr(segment.text)}</tspan>`)
      .join("");
    return (
      `<text x="${x}" y="${y}" fill="#6e7681" text-anchor="end">${escAttr(side.line)}</text>` +
      `<text x="${x + 17}" y="${y}" fill="${markerColor}">${marker}</text>` +
      `<text x="${x + 39}" y="${y}" xml:space="preserve">${spans}</text>`
    );
  }

  function buildCarbonSvg(
    file: string,
    rows: ExportPairRow[],
    layout: "split" | "compact",
  ): string {
    const [start, middle, end] = carbonThemes[carbonTheme].stops;
    if (layout === "compact") {
      const compactRows = compactExportRows(rows);
      const longest = Math.max(28, ...compactRows.map((row) => row.code.length));
      const contentWidth = Math.min(1200, 104 + longest * 8.2);
      const width = 56 + contentWidth;
      const height = 130 + compactRows.length * 25;
      const rowMarkup = compactRows
        .map((row, index) => {
          const y = 112 + index * 25;
          const background =
            row.kind === "add"
              ? "rgba(46,160,67,.18)"
              : row.kind === "del"
                ? "rgba(248,81,73,.16)"
                : "transparent";
          return (
            `<rect x="29" y="${y - 18}" width="${contentWidth - 1}" height="25" fill="${background}"/>` +
            `<g clip-path="url(#compactClip)">${svgCode(row, 68, y)}</g>`
          );
        })
        .join("");
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
        `<defs><linearGradient id="background" x1="0" y1="0" x2="1" y2="1">` +
        `<stop stop-color="${start}"/><stop offset=".52" stop-color="${middle}"/><stop offset="1" stop-color="${end}"/></linearGradient>` +
        `<clipPath id="compactClip"><rect x="29" y="88" width="${contentWidth - 4}" height="${height - 112}"/></clipPath></defs>` +
        `<rect width="${width}" height="${height}" rx="16" fill="url(#background)"/>` +
        `<rect x="28" y="24" width="${width - 56}" height="${height - 48}" rx="14" fill="#0d1117"/>` +
        `<circle cx="50" cy="48" r="6" fill="#ff5f56"/><circle cx="70" cy="48" r="6" fill="#ffbd2e"/><circle cx="90" cy="48" r="6" fill="#27c93f"/>` +
        `<g font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="14">` +
        `<text x="${width / 2}" y="53" fill="#c9d1d9" text-anchor="middle" font-weight="600">${escAttr(file)}</text>` +
        `<text x="42" y="82" fill="#8b949e" font-size="11" font-weight="600">UNIFIED DIFF</text>` +
        rowMarkup +
        `</g></svg>`
      );
    }
    const longest = Math.max(
      28,
      ...rows.flatMap((row) => [row.old?.code.length || 0, row.next?.code.length || 0]),
    );
    const columnWidth = Math.min(960, 104 + longest * 8.2);
    const width = 56 + columnWidth * 2;
    const height = 130 + rows.length * 25;
    const rowMarkup = rows
      .map((row, index) => {
        const y = 112 + index * 25;
        const oldBg = row.old?.kind === "del" ? "rgba(248,81,73,.16)" : "transparent";
        const newBg = row.next?.kind === "add" ? "rgba(46,160,67,.18)" : "transparent";
        return (
          `<rect x="29" y="${y - 18}" width="${columnWidth - 1}" height="25" fill="${oldBg}"/>` +
          `<rect x="${29 + columnWidth}" y="${y - 18}" width="${columnWidth - 1}" height="25" fill="${newBg}"/>` +
          `<g clip-path="url(#oldClip)">${svgCode(row.old, 68, y)}</g>` +
          `<g clip-path="url(#newClip)">${svgCode(row.next, 68 + columnWidth, y)}</g>`
        );
      })
      .join("");
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<defs><linearGradient id="background" x1="0" y1="0" x2="1" y2="1">` +
      `<stop stop-color="${start}"/><stop offset=".52" stop-color="${middle}"/><stop offset="1" stop-color="${end}"/></linearGradient>` +
      `<clipPath id="oldClip"><rect x="29" y="88" width="${columnWidth - 4}" height="${height - 112}"/></clipPath>` +
      `<clipPath id="newClip"><rect x="${29 + columnWidth}" y="88" width="${columnWidth - 4}" height="${height - 112}"/></clipPath></defs>` +
      `<rect width="${width}" height="${height}" rx="16" fill="url(#background)"/>` +
      `<rect x="28" y="24" width="${width - 56}" height="${height - 48}" rx="14" fill="#0d1117"/>` +
      `<circle cx="50" cy="48" r="6" fill="#ff5f56"/><circle cx="70" cy="48" r="6" fill="#ffbd2e"/><circle cx="90" cy="48" r="6" fill="#27c93f"/>` +
      `<g font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="14">` +
      `<text x="${width / 2}" y="53" fill="#c9d1d9" text-anchor="middle" font-weight="600">${escAttr(file)}</text>` +
      `<text x="42" y="82" fill="#8b949e" font-size="11" font-weight="600">BEFORE</text>` +
      `<text x="${42 + columnWidth}" y="82" fill="#8b949e" font-size="11" font-weight="600">AFTER</text>` +
      `<line x1="${28 + columnWidth}" y1="68" x2="${28 + columnWidth}" y2="${height - 24}" stroke="#30363d"/>` +
      rowMarkup +
      `</g></svg>`
    );
  }

  function drawCanvasCode(
    context: CanvasRenderingContext2D,
    side: ExportSide | undefined,
    x: number,
    y: number,
  ): void {
    if (!side) return;
    const marker = side.kind === "add" ? "+" : side.kind === "del" ? "−" : " ";
    context.font = "14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    context.fillStyle = "#6e7681";
    context.textAlign = "right";
    context.fillText(side.line, x, y);
    context.textAlign = "left";
    context.fillStyle =
      side.kind === "add" ? "#3fb950" : side.kind === "del" ? "#f85149" : "#8b949e";
    context.fillText(marker, x + 17, y);
    let codeX = x + 39;
    for (const segment of syntaxSegments(side.html || escAttr(side.code))) {
      context.fillStyle = segment.color;
      context.fillText(segment.text, codeX, y);
      codeX += context.measureText(segment.text).width;
    }
  }

  function drawCarbonCanvas(
    file: string,
    rows: ExportPairRow[],
    layout: "split" | "compact",
  ): void {
    const scale = 2;
    const compactRows = compactExportRows(rows);
    const longest = Math.max(
      28,
      ...rows.flatMap((row) => [row.old?.code.length || 0, row.next?.code.length || 0]),
    );
    const columnWidth = Math.min(960, 104 + longest * 8.2);
    const width = 56 + columnWidth * (layout === "compact" ? 1 : 2);
    const height = 130 + (layout === "compact" ? compactRows.length : rows.length) * 25;
    carbonCanvas.width = width * scale;
    carbonCanvas.height = height * scale;
    const context = carbonCanvas.getContext("2d");
    if (!context) return;
    context.scale(scale, scale);

    const background = context.createLinearGradient(0, 0, width, height);
    const [start, middle, end] = carbonThemes[carbonTheme].stops;
    background.addColorStop(0, start);
    background.addColorStop(0.52, middle);
    background.addColorStop(1, end);
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    roundRect(context, 28, 24, width - 56, height - 48, 14);
    context.fillStyle = "#0d1117";
    context.fill();
    ["#ff5f56", "#ffbd2e", "#27c93f"].forEach((color, index) => {
      context.beginPath();
      context.arc(50 + index * 20, 48, 6, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
    });
    context.font = "600 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    context.fillStyle = "#c9d1d9";
    context.textAlign = "center";
    context.fillText(file, width / 2, 53);
    context.textAlign = "left";
    context.font = "600 11px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    context.fillStyle = "#8b949e";
    if (layout === "compact") {
      context.fillText("UNIFIED DIFF", 42, 82);
      compactRows.forEach((row, index) => {
        const y = 112 + index * 25;
        if (row.kind !== "ctx") {
          context.fillStyle = row.kind === "add" ? "rgba(46,160,67,.18)" : "rgba(248,81,73,.16)";
          context.fillRect(29, y - 18, columnWidth - 1, 25);
        }
        context.save();
        context.beginPath();
        context.rect(29, y - 19, columnWidth - 4, 25);
        context.clip();
        drawCanvasCode(context, row, 68, y);
        context.restore();
      });
      return;
    }

    context.fillText("BEFORE", 42, 82);
    context.fillText("AFTER", 42 + columnWidth, 82);
    context.strokeStyle = "#30363d";
    context.beginPath();
    context.moveTo(28 + columnWidth, 68);
    context.lineTo(28 + columnWidth, height - 24);
    context.stroke();

    rows.forEach((row, index) => {
      const y = 112 + index * 25;
      if (row.old?.kind === "del") {
        context.fillStyle = "rgba(248,81,73,.16)";
        context.fillRect(29, y - 18, columnWidth - 1, 25);
      }
      if (row.next?.kind === "add") {
        context.fillStyle = "rgba(46,160,67,.18)";
        context.fillRect(29 + columnWidth, y - 18, columnWidth - 1, 25);
      }
      context.save();
      context.beginPath();
      context.rect(29, y - 19, columnWidth - 4, 25);
      context.clip();
      drawCanvasCode(context, row.old, 68, y);
      context.restore();
      context.save();
      context.beginPath();
      context.rect(29 + columnWidth, y - 19, columnWidth - 4, 25);
      context.clip();
      drawCanvasCode(context, row.next, 68 + columnWidth, y);
      context.restore();
    });
  }

  function renderCarbonVisuals(): void {
    carbonSelectable.innerHTML = carbonPreview(carbonFile, carbonRows, carbonLayout);
    carbonClipboardHtml = powerPointClipboardTable(carbonFile, carbonRows, carbonLayout);
    carbonSvg = buildCarbonSvg(carbonFile, carbonRows, carbonLayout);
    drawCarbonCanvas(carbonFile, carbonRows, carbonLayout);
    carbonModal.querySelectorAll("[data-carbon-layout]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.carbonLayout === carbonLayout));
    });
    carbonModal.querySelectorAll("[data-carbon-theme]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.carbonTheme === carbonTheme));
    });
  }

  function openCarbonExport(selection: DiffRangeSelection): void {
    carbonFile = selection.file;
    carbonRows = buildExportRows(selection);
    carbonHtml = carbonRichDocument(carbonFile, carbonRows);
    carbonPlain = carbonPlainText(carbonRows);
    renderCarbonVisuals();
    const first = selection.rows[0]?.line || "";
    const last = selection.rows.at(-1)?.line || first;
    document.getElementById("carbonModalMeta").textContent =
      selection.file +
      " · " +
      (first === last ? "line " + first : "lines " + first + "–" + last) +
      " · selectable before and after";
    carbonFilenameBase =
      (selection.file
        .split("/")
        .pop()
        ?.replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/\.[^.]+$/, "") || "diff-selection") +
      "-lines-" +
      first +
      (first === last ? "" : "-" + last);
    carbonModal.hidden = false;
  }

  carbonModal.querySelectorAll("[data-carbon-layout]").forEach((button) => {
    button.addEventListener("click", () => {
      carbonLayout = button.dataset.carbonLayout === "compact" ? "compact" : "split";
      renderCarbonVisuals();
    });
  });
  carbonModal.querySelectorAll("[data-carbon-theme]").forEach((button) => {
    button.addEventListener("click", () => {
      const theme = button.dataset.carbonTheme as CarbonTheme;
      if (theme in carbonThemes) carbonTheme = theme;
      renderCarbonVisuals();
    });
  });
  document.getElementById("closeCarbonModal").addEventListener("click", () => {
    carbonModal.hidden = true;
  });
  carbonModal.addEventListener("click", (event) => {
    if (event.target === carbonModal) carbonModal.hidden = true;
  });
  const showCarbonCopied = (label = "Copied ✓") => {
    const copied = document.getElementById("carbonCopied");
    copied.textContent = label;
    copied.hidden = false;
    setTimeout(() => (copied.hidden = true), 1800);
  };
  const currentCarbonFilename = () =>
    carbonFilenameBase + (carbonLayout === "compact" ? "-compact" : "");
  const downloadCarbon = (
    content: BlobPart,
    type: string,
    extension: string,
    layoutAware = true,
  ) => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([content], { type }));
    link.download = (layoutAware ? currentCarbonFilename() : carbonFilenameBase) + extension;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  document.getElementById("downloadCarbonBtn").addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = carbonCanvas.toDataURL("image/png");
    link.download = currentCarbonFilename() + ".png";
    link.click();
  });
  document.getElementById("downloadCarbonHtmlBtn").addEventListener("click", () => {
    downloadCarbon(carbonHtml, "text/html;charset=utf-8", ".html", false);
  });
  document.getElementById("downloadCarbonSvgBtn").addEventListener("click", () => {
    downloadCarbon(carbonSvg, "image/svg+xml;charset=utf-8", ".svg");
  });
  document.getElementById("copyCarbonHtmlBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([carbonClipboardHtml], { type: "text/html" }),
          "text/plain": new Blob([carbonPlain], { type: "text/plain" }),
        }),
      ]);
      showCarbonCopied("PowerPoint table copied ✓");
    } catch {
      const clipboardTable = document.createElement("div");
      clipboardTable.innerHTML = carbonClipboardHtml;
      clipboardTable.style.position = "fixed";
      clipboardTable.style.left = "-10000px";
      document.body.appendChild(clipboardTable);
      const range = document.createRange();
      range.selectNodeContents(clipboardTable);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (document.execCommand("copy")) showCarbonCopied("PowerPoint table copied ✓");
      selection?.removeAllRanges();
      clipboardTable.remove();
    }
  });
  document.getElementById("copyCarbonBtn").addEventListener("click", () => {
    carbonCanvas.toBlob(async (blob) => {
      if (!blob || !navigator.clipboard || typeof ClipboardItem === "undefined") return;
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        showCarbonCopied();
      } catch {}
    }, "image/png");
  });

  document.addEventListener("mousedown", (event) => {
    if (
      rangeToolbar.hidden ||
      eventElement(event)?.closest("#rangeToolbar") ||
      eventElement(event)?.closest(".gutter[data-key]")
    ) {
      return;
    }
    hideRangeToolbar();
  });

  // ---- general comments ----
  document.querySelectorAll(".general-input").forEach((ta) => {
    const pr = ta.dataset.general;
    ta.value = state.general[pr] || "";
    const id = attachmentId("general", pr, "", "");
    const store = () => {
      state.general[pr] = ta.value;
      save();
      updateCounts();
    };
    bindImagePaste(ta, ta.closest(".overall-bar"), id, store);
    ta.addEventListener("input", store);
  });

  // ---- file collapse (ignore clicks on the action controls) ----
  document.querySelectorAll(".file-header").forEach((h) => {
    h.addEventListener("click", (e) => {
      if (eventElement(e)?.closest(".file-actions")) return;
      h.closest(".file").classList.toggle("collapsed");
    });
  });

  // ---- whole-file viewer ----
  const fileModal = document.getElementById("fileModal");
  const fileModalTitle = document.getElementById("fileModalTitle");
  const fileModalMeta = document.getElementById("fileModalMeta");
  const fileModalCode = document.getElementById("fileModalCode");
  const fileModalImage = document.getElementById("fileModalImage");
  const fileModalTabs = document.getElementById("fileModalTabs");
  function selectFileView(mode: "image" | "code"): void {
    fileModalTabs.querySelectorAll("[data-file-view]").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.fileView === mode));
    });
    fileModalImage.hidden = mode !== "image";
    fileModalCode.hidden = mode !== "code";
  }
  function closeFileModal(): void {
    fileModal.hidden = true;
    fileModalCode.innerHTML = "";
    fileModalImage.innerHTML = "";
  }
  fileModalTabs
    .querySelectorAll("[data-file-view]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        selectFileView(button.dataset.fileView === "image" ? "image" : "code"),
      ),
    );
  document.querySelectorAll(".view-file-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const fileEl = button.closest(".file");
      const fid = fileEl.querySelector(".diff-mount").dataset.fid;
      const file = DATA[fid];
      fileModalTitle.textContent = file.path;
      fileModalMeta.textContent =
        file.fullFile.revision === "base" ? "File before deletion" : "File after these changes";
      if (typeof file.fullFile.content === "string") {
        const lines = hlLines(file.fullFile.content.replace(/\n$/, ""), file.lang);
        fileModalCode.innerHTML =
          '<table class="full-file"><tbody>' +
          lines
            .map(
              (line, index) =>
                `<tr><td class="ln">${index + 1}</td><td class="code"><code>${line || " "}</code></td></tr>`,
            )
            .join("") +
          "</tbody></table>";
        if (file.fullFile.svgPreview) {
          fileModalTabs.hidden = false;
          fileModalImage.innerHTML = file.fullFile.svgPreview;
          fileModalImage.classList.remove("zoomed");
          const preview = fileModalImage.querySelector("svg");
          if (preview) {
            preview.title = "Click to toggle actual size";
            preview.addEventListener("click", () => fileModalImage.classList.toggle("zoomed"));
          }
          selectFileView("image");
        } else {
          fileModalTabs.hidden = true;
          selectFileView("code");
        }
      } else {
        const message =
          file.fullFile.unavailable === "binary"
            ? "Binary files cannot be displayed."
            : file.fullFile.unavailable === "too-large"
              ? "This file is too large to embed in the review."
              : "The complete file was not available when this review was built.";
        fileModalCode.innerHTML = `<p class="full-file-unavailable">${escAttr(message)}</p>`;
        fileModalTabs.hidden = true;
        selectFileView("code");
      }
      fileModal.hidden = false;
    });
  });
  document.getElementById("closeFileModal").addEventListener("click", closeFileModal);
  fileModal.addEventListener("click", (event) => {
    if (event.target === fileModal) closeFileModal();
  });

  // ---- per-file comment + "Viewed" (GitHub-style) ----
  function fileNoteBox(fileEl: UiElement, prefill: string, focus: boolean): UiElement {
    const slot = fileEl.querySelector(".file-note-slot");
    const pr = fileEl.closest("section.pr").dataset.pr,
      file = fileEl.dataset.file,
      id = pr + " " + file;
    const attachId = attachmentId("file", pr, file, "");
    const btn = fileEl.querySelector(".file-note-btn");
    let box = slot.querySelector(".file-note");
    if (box) {
      const t = box.querySelector("textarea");
      if (focus) t.focus();
      return t;
    }
    box = document.createElement("div");
    box.className = "file-note";
    box.innerHTML =
      '<div class="cb-meta"><span class="who-you">You</span><span>File comment · ' +
      escAttr(file) +
      '</span></div><textarea placeholder="Comment on this whole file…"></textarea><div class="comment-actions"><button type="button">Delete</button></div>';
    slot.appendChild(box);
    const ta = box.querySelector("textarea");
    ta.value = prefill || "";
    const store = () => {
      state.files[id] = { pr, file, text: ta.value };
      save();
      updateCounts();
      if (btn) btn.classList.toggle("has-note", hasCommentContent(ta.value, attachId));
    };
    bindImagePaste(ta, box, attachId, store);
    ta.addEventListener("input", store);
    ta.addEventListener("blur", () => {
      if (!hasCommentContent(ta.value, attachId)) {
        delete state.files[id];
        save();
        updateCounts();
        box.remove();
        if (btn) btn.classList.remove("has-note");
      }
    });
    box.querySelector(".comment-actions button").addEventListener("click", () => {
      delete state.files[id];
      delete state.attachments[attachId];
      save();
      updateCounts();
      box.remove();
      if (btn) btn.classList.remove("has-note");
    });
    if (focus) ta.focus();
    return ta;
  }
  function viewedId(fileEl: UiElement): string {
    const pr = fileEl.closest("section.pr").dataset.pr;
    return pr + " " + (fileEl.dataset.viewKey || fileEl.dataset.file);
  }
  function applyViewed(fileEl: UiElement, viewed: boolean): void {
    fileEl.classList.toggle("viewed", viewed);
    fileEl.classList.toggle("collapsed", viewed);
    const cb = fileEl.querySelector(".viewed-cb");
    if (cb) cb.checked = viewed;
  }
  function storeViewed(fileEl: UiElement, viewed: boolean): void {
    const id = viewedId(fileEl);
    if (viewed) state.viewed[id] = true;
    else delete state.viewed[id];
  }
  function groupedOccurrences(sec: UiElement, file: string): UiElement[] {
    return [...sec.querySelectorAll('[data-order-view="grouped"] .file')].filter(
      (candidate) => candidate.dataset.file === file,
    );
  }
  function rawOccurrences(sec: UiElement, file: string): UiElement[] {
    return [...sec.querySelectorAll('[data-order-view="raw"] .file')].filter(
      (candidate) => candidate.dataset.file === file,
    );
  }
  function syncRawViewed(sec: UiElement, file: string, persist: boolean): void {
    const grouped = groupedOccurrences(sec, file),
      viewed =
        grouped.length > 0 && grouped.every((candidate) => candidate.classList.contains("viewed"));
    rawOccurrences(sec, file).forEach((candidate) => {
      applyViewed(candidate, viewed);
      if (persist) storeViewed(candidate, viewed);
    });
  }
  function setViewed(fileEl: UiElement, viewed: boolean, persist: boolean): void {
    const sec = fileEl.closest("section.pr"),
      file = fileEl.dataset.file;
    const isRaw = !!fileEl.closest('[data-order-view="raw"]');
    const related = isRaw ? groupedOccurrences(sec, file) : [fileEl];
    related.forEach((candidate) => {
      applyViewed(candidate, viewed);
      if (persist) storeViewed(candidate, viewed);
    });
    if (!isRaw) {
      applyViewed(fileEl, viewed);
      if (persist) storeViewed(fileEl, viewed);
    }
    syncRawViewed(sec, file, persist);
    if (persist) {
      save();
      updateCounts();
    }
    new Set(related.map((candidate) => candidate.closest(".group")).filter(Boolean)).forEach(
      syncGroupCb,
    );
    refreshTree();
  }
  // scroll a file's (now-collapsed) header just under the sticky bars, so the
  // next file is immediately in view — marking "Viewed" keeps reading order.
  function scrollFileToTop(fileEl: UiElement): void {
    const cs = getComputedStyle(document.documentElement);
    const px = (n: string): number => parseInt(cs.getPropertyValue(n)) || 0;
    const mx = fileEl.closest(".diff-block.maximized");
    if (mx) {
      const off = px("--h-diffhead");
      const top =
        fileEl.getBoundingClientRect().top -
        mx.getBoundingClientRect().top +
        mx.scrollTop -
        off -
        6;
      mx.scrollTo({ top, behavior: "smooth" });
    } else {
      const off = px("--h-app") + px("--h-tabs") + px("--h-diffhead");
      const top = fileEl.getBoundingClientRect().top + window.scrollY - off - 6;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
  }
  // reflect member files' viewed state on the group's "Reviewed" checkbox
  function syncGroupCb(group: UiElement): void {
    const cb = group.querySelector(".gv-cb");
    if (!cb) return;
    const files = [...group.querySelectorAll(".file")];
    const n = files.filter((f) => f.classList.contains("viewed")).length;
    cb.checked = files.length > 0 && n === files.length;
    cb.indeterminate = n > 0 && n < files.length;
  }
  let migratedViewedState = false;
  document.querySelectorAll("section.pr").forEach((sec) => {
    const pr = sec.dataset.pr;
    const files = new Set(
      [...sec.querySelectorAll('[data-order-view="grouped"] .file')].map(
        (file) => file.dataset.file,
      ),
    );
    files.forEach((file) => {
      const legacyId = pr + " " + file;
      if (!state.viewed[legacyId]) return;
      const scoped = groupedOccurrences(sec, file).filter((candidate) => candidate.dataset.viewKey);
      if (!scoped.length) return;
      scoped.forEach((candidate) => storeViewed(candidate, true));
      rawOccurrences(sec, file).forEach((candidate) => storeViewed(candidate, true));
      delete state.viewed[legacyId];
      migratedViewedState = true;
    });
  });
  if (migratedViewedState) save();
  document.querySelectorAll(".file").forEach((fileEl) => {
    const pr = fileEl.closest("section.pr").dataset.pr,
      id = viewedId(fileEl);
    const fileNoteId = pr + " " + fileEl.dataset.file;
    const fileAttachId = attachmentId("file", pr, fileEl.dataset.file, "");
    const btn = fileEl.querySelector(".file-note-btn");
    if (btn)
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        fileNoteBox(fileEl, "", true);
      });
    const cb = fileEl.querySelector(".viewed-cb");
    if (cb)
      cb.addEventListener("change", () => {
        setViewed(fileEl, cb.checked, true);
        if (cb.checked) scrollFileToTop(fileEl);
      });
    if (state.files[fileNoteId] && hasCommentContent(state.files[fileNoteId].text, fileAttachId)) {
      fileNoteBox(fileEl, state.files[fileNoteId].text, false);
      if (btn) btn.classList.add("has-note");
    }
    if (state.viewed[id]) setViewed(fileEl, true, false);
  });
  document.querySelectorAll("section.pr").forEach((sec) => {
    new Set([...sec.querySelectorAll(".file")].map((file) => file.dataset.file)).forEach((file) =>
      syncRawViewed(sec, file, false),
    );
  });

  // ---- change groups: collapse + one "Reviewed" that clears the whole group ----
  document.querySelectorAll(".group-head").forEach((h) => {
    h.addEventListener("click", (e) => {
      if (eventElement(e)?.closest(".group-viewed, .group-merge")) return;
      const group = h.closest(".group");
      if (group) group.classList.toggle("collapsed");
    });
  });
  document.querySelectorAll(".group").forEach((group) => {
    const cb = group.querySelector(".gv-cb");
    if (!cb) return;
    cb.addEventListener("change", () => {
      const want = cb.checked; // capture before setViewed→syncGroupCb mutates cb mid-loop
      const files = [...group.querySelectorAll(".file")];
      const title = group.querySelector(".group-title")?.textContent.trim() || "this group";
      const paths = files.map((f) => "• " + f.dataset.file).join("\n");
      const prompt =
        "Mark all " + files.length + " files in “" + title + "” as viewed?\n\n" + paths;
      if (want && !window.confirm(prompt)) {
        syncGroupCb(group);
        return;
      }
      files.forEach((f) => setViewed(f, want, true));
      syncGroupCb(group);
    });
    syncGroupCb(group);
  });

  // ---- file tree drawer (navigate a big diff by path) ----
  function collectTreeFiles(sec: UiElement): TreeFile[] {
    return visibleEvidenceFiles(sec).map((el) => {
      const p = el.dataset.file || "";
      const num = (sel: string): number => {
        const t = el.querySelector(".file-header " + sel);
        return t ? parseInt(t.textContent.replace(/[^0-9]/g, "")) || 0 : 0;
      };
      return {
        path: p,
        change: el.dataset.change || "",
        topic: el.querySelector(".change-range")?.textContent || "",
        name: p.split("/").pop() ?? p,
        add: num(".stat-add"),
        del: num(".stat-del"),
        viewed: el.classList.contains("viewed"),
      };
    });
  }
  function treeModel(files: TreeFile[]): TreeNode {
    const root: TreeNode = { dirs: {}, files: [] };
    for (const f of files) {
      const parts = f.path.split("/");
      let n = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const d = parts[i];
        n.dirs[d] = n.dirs[d] || { dirs: {}, files: [] };
        n = n.dirs[d];
      }
      n.files.push(f);
    }
    return root;
  }
  function renderTreeDir(node: TreeNode): string {
    let html = "";
    Object.keys(node.dirs)
      .sort((a, b) => a.localeCompare(b))
      .forEach((name0) => {
        let name = name0,
          child = node.dirs[name0];
        // compact single-child directory chains (src/main/java → one row)
        while (child.files.length === 0 && Object.keys(child.dirs).length === 1) {
          const only = Object.keys(child.dirs)[0];
          name = name + "/" + only;
          child = child.dirs[only];
        }
        html += `<li class="ft-dir"><div class="ft-row ft-dirrow"><span class="ft-tw">▾</span><span class="ft-name">${escAttr(name)}</span></div><ul class="ft-children">${renderTreeDir(child)}</ul></li>`;
      });
    node.files
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((f) => {
        html += `<li class="ft-file${f.viewed ? " viewed" : ""}" data-file="${escAttr(f.path)}"${f.change ? ` data-change="${escAttr(f.change)}"` : ""}><div class="ft-row"><span class="ft-name" title="${escAttr(f.path)}">${escAttr(f.name)}${f.topic ? `<small class="ft-topic">${escAttr(f.topic)}</small>` : ""}</span><span class="ft-stats"><span class="stat-add">+${f.add}</span> <span class="stat-del">-${f.del}</span></span></div></li>`;
      });
    return html;
  }
  function refreshTree(): void {
    const w = document.getElementById("fileTree");
    if (!w || w.hidden) return;
    const sec = activeSection();
    if (!sec) return;
    const files = collectTreeFiles(sec);
    const viewed = files.filter((f) => f.viewed).length;
    w.querySelector(".ft-count").textContent =
      files.length + " file" + (files.length === 1 ? "" : "s");
    w.querySelector(".ft-viewed").textContent = viewed + "/" + files.length + " viewed";
    w.querySelector(".ft-body").innerHTML =
      `<ul class="ft-root">${renderTreeDir(treeModel(files))}</ul>`;
  }
  function toggleTree(): void {
    const w = document.getElementById("fileTree");
    const open = w.hidden;
    w.hidden = !open;
    document.querySelectorAll(".dbh-tree").forEach((b) => b.classList.toggle("on", Boolean(open)));
    if (open) refreshTree();
  }
  document.querySelectorAll(".dbh-tree").forEach((b) => b.addEventListener("click", toggleTree));
  document.querySelector("#fileTree .ft-close").addEventListener("click", toggleTree);
  document.querySelector("#fileTree .ft-body").addEventListener("click", (e) => {
    const dir = eventElement(e)?.closest(".ft-dirrow");
    if (dir) {
      dir.parentElement?.classList.toggle("collapsed");
      return;
    }
    const fr = eventElement(e)?.closest(".ft-file");
    if (!fr) return;
    const sec = activeSection();
    if (!sec) return;
    const el = visibleEvidenceFiles(sec).find((f) =>
      fr.dataset.change
        ? f.dataset.change === fr.dataset.change
        : f.dataset.file === fr.dataset.file,
    );
    if (el) {
      const g = el.closest(".group");
      if (g) g.classList.remove("collapsed");
      el.classList.remove("collapsed");
      scrollFileToTop(el);
    }
  });
  document.querySelectorAll("#fileTree [data-ft]").forEach((b) =>
    b.addEventListener("click", () => {
      const collapse = b.dataset.ft === "collapse";
      document
        .querySelectorAll("#fileTree .ft-dir")
        .forEach((d) => d.classList.toggle("collapsed", collapse));
    }),
  );

  // ---- tabs ----
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const id = tab.dataset.tab;
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll("section.pr").forEach((s) => {
        s.hidden = s.dataset.pr !== id;
      });
      syncReviewJourney();
      window.scrollTo(0, 0);
      updateProgress();
      refreshTree();
    });
  });

  // ---- diff mode (persisted view pref) ----
  let mode: "unified" | "split" = "unified";
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === "split" || m === "unified") mode = m;
  } catch (e) {}
  function setMode(m: "unified" | "split"): void {
    mode = m;
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch (e) {}
    document
      .querySelectorAll(".diff-mode-seg button")
      .forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    renderAll(m);
  }
  document.querySelectorAll(".diff-mode-seg button").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.mode === "split" || b.dataset.mode === "unified") setMode(b.dataset.mode);
    }),
  );

  // ---- theme: system default, session override cycle (not persisted) ----
  const themeBtn = document.getElementById("themeBtn");
  const THEMES = [
    { v: null, icon: "◐", label: "system" },
    { v: "light", icon: "☀", label: "light" },
    { v: "dark", icon: "☾", label: "dark" },
  ];
  let ti = 0;
  themeBtn.addEventListener("click", () => {
    ti = (ti + 1) % THEMES.length;
    const t = THEMES[ti];
    if (t.v) document.documentElement.setAttribute("data-theme", t.v);
    else document.documentElement.removeAttribute("data-theme");
    themeBtn.textContent = t.icon;
    themeBtn.title = "Theme: " + t.label;
  });

  // ---- export ----
  function attachmentMarkdown(id: string, indent = ""): string {
    return attachmentItems(id)
      .map((item, index) => indent + "![Pasted image " + (index + 1) + "](" + item.data + ")")
      .join("\n");
  }
  function buildMarkdown(prFilter?: string): string {
    let out = "# " + TITLE + "\n_" + SUBTITLE + "_\n";
    let any = false;
    document.querySelectorAll("section.pr").forEach((sec) => {
      const pr = sec.dataset.pr;
      if (prFilter && pr !== prFilter) return;
      const title =
        sec.querySelector(".summary-head h2")?.textContent ||
        sec.querySelector("h2")?.textContent ||
        pr;
      let block = "";
      // decisions on the LM review
      const rev = REVIEW[pr];
      if (rev && rev.comments.length) {
        block += "\n**On the " + REVIEWER + " review:**\n";
        for (const c of rev.comments) {
          const s = state.aiState[pr + " " + c.aid] || "open";
          block +=
            "- [" +
            s +
            "] " +
            c.file +
            " L" +
            c.line +
            " (" +
            c.severity +
            ", " +
            Math.round(c.confidence * 100) +
            "% confidence) — " +
            c.body.replace(/\n+/g, " ").trim() +
            " Rationale: " +
            c.rationale.replace(/\n+/g, " ").trim() +
            "\n";
        }
      }
      const gen = (state.general[pr] || "").trim();
      const generalAttachments = attachmentMarkdown(attachmentId("general", pr, "", ""));
      if (gen || generalAttachments) {
        block += "\n**My overall:**" + (gen ? " " + gen : "") + "\n";
        if (generalAttachments) block += generalAttachments + "\n";
      }
      const byFile: Record<string, MarkdownFile> = {};
      const F = (f: string): MarkdownFile => (byFile[f] = byFile[f] || { note: "", lines: [] });
      for (const k in state.files) {
        const c = state.files[k];
        if (!c || c.pr !== pr || !hasCommentContent(c.text, attachmentId("file", c.pr, c.file, "")))
          continue;
        F(c.file).note = c.text;
      }
      for (const k in state.lines) {
        const c = state.lines[k];
        if (
          !c ||
          c.pr !== pr ||
          !hasCommentContent(c.text, attachmentId("line", c.pr, c.file, c.key))
        )
          continue;
        F(c.file).lines.push(c);
      }
      for (const file in byFile) {
        block += "\n### " + file + "\n";
        const fm = byFile[file];
        const fileAttachments = attachmentMarkdown(attachmentId("file", pr, file, ""), "  ");
        if (fm.note || fileAttachments) {
          block +=
            "- **File:**" +
            (fm.note ? " " + fm.note.replace(/\n+/g, " ").trim() : " Pasted image") +
            "\n";
          if (fileAttachments) block += fileAttachments + "\n";
        }
        fm.lines.sort((a, b) => (parseInt(a.lineno ?? "") || 0) - (parseInt(b.lineno ?? "") || 0));
        for (const c of fm.lines) {
          const lineAttachments = attachmentMarkdown(attachmentId("line", pr, c.file, c.key), "  ");
          block +=
            "- **L" +
            (c.startLineno && c.startLineno !== c.lineno
              ? c.startLineno + "–" + c.lineno
              : c.lineno) +
            "** — " +
            (c.text ? c.text.replace(/\n+/g, " ").trim() : "Pasted image") +
            "\n";
          if (c.code && c.code.trim()) block += "  > `" + c.code.trim().slice(0, 160) + "`\n";
          if (lineAttachments) block += lineAttachments + "\n";
        }
      }
      const orphans = orphanedComments().filter(([, comment]) => comment.pr === pr);
      if (orphans.length) {
        block += "\n### Orphaned comments\n";
        for (const [, comment] of orphans) {
          block +=
            "- **" +
            comment.file +
            ":" +
            (comment.lineno || comment.key) +
            "** — " +
            (comment.text || "Pasted image").replace(/\n+/g, " ").trim() +
            "\n";
        }
      }
      if (block.trim()) {
        any = true;
        out += "\n## " + title + "\n" + block;
      }
    });
    if (!any) out += "\n_No comments yet._\n";
    return out;
  }
  function buildGithubSummary(pr: string): string {
    const section = document.querySelector('section.pr[data-pr="' + cssEsc(pr) + '"]');
    const title =
      section?.querySelector(".summary-head h2")?.textContent ||
      section?.querySelector("h2")?.textContent ||
      pr;
    let summary = `# Review: ${title}\n`;
    const review = REVIEW[pr];
    if (review?.comments.length) {
      summary += `\n**On the ${REVIEWER} review:**\n`;
      for (const comment of review.comments) {
        const status = state.aiState[pr + " " + comment.aid] || "open";
        summary +=
          `- [${status}] ${comment.file} L${comment.line} — ` +
          comment.body.replace(/\n+/g, " ").trim() +
          "\n";
      }
    }
    const general = (state.general[pr] || "").trim();
    const attachments = attachmentMarkdown(attachmentId("general", pr, "", ""));
    if (general || attachments) {
      summary += `\n**Overall:**${general ? " " + general : ""}\n`;
      if (attachments) summary += attachments + "\n";
    }
    return summary.trim();
  }
  const modal = document.getElementById("exportModal");
  const exportText = document.getElementById("exportText");
  async function copyMarkdown(markdown: string): Promise<boolean> {
    exportText.value = markdown;
    try {
      await navigator.clipboard.writeText(markdown);
      return true;
    } catch (e) {
      try {
        exportText.select();
        return document.execCommand("copy");
      } catch (fallbackError) {
        return false;
      }
    }
  }
  document.getElementById("copyCommentsBtn").addEventListener("click", async () => {
    const button = document.getElementById("copyCommentsBtn");
    if (await copyMarkdown(buildMarkdown())) {
      button.textContent = "Copied ✓";
      setTimeout(() => (button.textContent = "Copy comments"), 1800);
    } else {
      modal.hidden = false;
      exportText.focus();
      exportText.select();
    }
  });
  document.getElementById("exportBtn").addEventListener("click", () => {
    exportText.value = buildMarkdown();
    document.getElementById("githubReviewTab").hidden = !GITHUB[activeSection()?.dataset.pr || ""];
    setExportTab("markdown");
    modal.hidden = false;
  });
  document.getElementById("closeModal").addEventListener("click", () => (modal.hidden = true));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
  document.getElementById("copyBtn").addEventListener("click", async () => {
    if (await copyMarkdown(exportText.value)) {
      const m = document.getElementById("copiedMsg");
      m.hidden = false;
      setTimeout(() => (m.hidden = true), 1800);
    }
  });
  document.getElementById("downloadBtn").addEventListener("click", () => {
    const blob = new Blob([exportText.value], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "review-comments-" + REVIEW_ID + ".md";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  let activeGithubPlan: GithubReviewPlan | null = null;
  function githubDraft(pr: string): GithubReviewPlan | null {
    const context = GITHUB[pr];
    if (!context) return null;
    const orphanIds = new Set(orphanedComments().map(([id]) => id));
    const comments: ReviewDraftComment[] = [];
    for (const id in state.files) {
      const comment = state.files[id];
      if (!comment || comment.pr !== pr) continue;
      const attachments = attachmentMarkdown(attachmentId("file", pr, comment.file, ""));
      const body = [comment.text.trim(), attachments].filter(Boolean).join("\n");
      if (!body) continue;
      comments.push({
        kind: "file",
        path: comment.file,
        body,
      });
    }
    for (const id in state.lines) {
      const comment = state.lines[id];
      if (!comment || comment.pr !== pr) continue;
      const attachments = attachmentMarkdown(attachmentId("line", pr, comment.file, comment.key));
      const body = [comment.text.trim(), attachments].filter(Boolean).join("\n");
      if (!body) continue;
      const oldSide = comment.key.startsWith("o");
      const line = parseInt(comment.lineno || comment.key.replace(/^o/, ""), 10);
      const startLine = parseInt(
        comment.startLineno || comment.startKey?.replace(/^o/, "") || String(line),
        10,
      );
      comments.push({
        kind: "line",
        path: comment.file,
        body,
        side: oldSide ? "LEFT" : "RIGHT",
        line,
        startSide: oldSide ? "LEFT" : "RIGHT",
        startLine,
        anchorStatus: orphanIds.has(id) ? "orphaned" : "current",
        ...(attachments
          ? { fallbackReason: "image attachments remain in the review summary" }
          : {}),
      });
    }
    return prepareGithubReview(context, {
      summary: buildGithubSummary(pr),
      comments,
    });
  }
  function activeReviewTarget(): string {
    return activeSection()?.dataset.pr || "";
  }
  function setExportTab(tab: "markdown" | "github"): void {
    const github = tab === "github";
    document.getElementById("markdownReviewTab").setAttribute("aria-selected", String(!github));
    document.getElementById("githubReviewTab").setAttribute("aria-selected", String(github));
    document.getElementById("markdownReviewPanel").hidden = github;
    document.getElementById("githubReviewPanel").hidden = !github;
    document.getElementById("markdownReviewActions").hidden = github;
    document.getElementById("githubReviewActions").hidden = !github;
    if (github) {
      activeGithubPlan = githubDraft(activeReviewTarget());
      document.getElementById("githubReviewPreview").textContent = activeGithubPlan
        ? githubReviewPreview(activeGithubPlan)
        : "GitHub publication is unavailable because this review has no pull-request context.";
    }
  }
  document.getElementById("markdownReviewTab").addEventListener("click", () => {
    setExportTab("markdown");
  });
  document.getElementById("githubReviewTab").addEventListener("click", () => {
    setExportTab("github");
  });
  document.getElementById("downloadGithubPlanBtn").addEventListener("click", () => {
    activeGithubPlan = githubDraft(activeReviewTarget());
    if (!activeGithubPlan) return;
    const blob = new Blob([JSON.stringify(activeGithubPlan, null, 2) + "\n"], {
      type: "application/json",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download =
      "github-review-" +
      activeGithubPlan.target.repository.replace("/", "-") +
      "-" +
      activeGithubPlan.target.pullRequest +
      ".json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  // ---- staged journey + adaptive evidence workspace ----
  function setOrderView(sec: UiElement, raw: boolean): void {
    const button = sec.querySelector(".raw-order-toggle");
    if (button) {
      button.setAttribute("aria-pressed", String(raw));
      button.textContent = raw ? "Grouped order" : "Git order";
    }
    sec.querySelectorAll("[data-order-view]").forEach((view) => {
      view.hidden = view.dataset.orderView !== (raw ? "raw" : "grouped");
    });
    const readingOrder = sec.querySelector(".reading-order");
    if (readingOrder) readingOrder.hidden = raw;
    refreshTree();
    updateProgress();
  }
  function syncReviewJourney(): void {
    const stage = activeSection()?.dataset.activeStage || "inspect";
    document.querySelectorAll(".review-journey button").forEach((button) => {
      if (button.dataset.reviewStage === stage) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
  }
  document.querySelectorAll(".review-journey button").forEach((button) => {
    button.addEventListener("click", () => {
      const sec = activeSection(),
        stage = button.dataset.reviewStage;
      if (!sec) return;
      sec.dataset.activeStage = stage;
      syncReviewJourney();
      if (stage === "validate") setOrderView(sec, false);
      const target =
        stage === "understand"
          ? sec.querySelector(".pr-context, .review-top")
          : stage === "validate"
            ? sec.querySelector(".group-workspace, .files")
            : sec.querySelector(".diff-block");
      if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  });
  syncReviewJourney();
  document.querySelectorAll(".context-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const cols = button.closest(".pr-cols");
      const pressed = cols.classList.toggle("context-collapsed");
      button.setAttribute("aria-pressed", String(pressed));
      button.textContent = pressed ? "Show sidebar" : "Sidebar";
    });
  });
  document.querySelectorAll(".focus-mode-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const cols = button.closest(".pr-cols");
      const pressed = cols.classList.toggle("focus-mode");
      button.setAttribute("aria-pressed", String(pressed));
      button.textContent = pressed ? "Exit focus" : "Focus";
    });
  });
  document.querySelectorAll(".raw-order-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const sec = button.closest("section.pr");
      const raw = button.getAttribute("aria-pressed") !== "true";
      setOrderView(sec, raw);
    });
  });

  // ---- resizable columns (drag the divider; double-click resets the adaptive default) ----
  try {
    const w = localStorage.getItem("htmlreview:leftw");
    if (w) document.documentElement.style.setProperty("--left-w", w);
  } catch (e) {}
  let rzTarget: UiElement | null = null;
  document.addEventListener("mousedown", (e) => {
    const rz = eventElement(e)?.closest(".col-resizer");
    if (!rz) return;
    rzTarget = rz.closest(".pr-cols");
    rz.classList.add("active");
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!rzTarget) return;
    const rect = rzTarget.getBoundingClientRect();
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    pct = Math.max(20, Math.min(80, pct));
    document.documentElement.style.setProperty("--left-w", pct.toFixed(1) + "%");
  });
  document.addEventListener("mouseup", () => {
    if (!rzTarget) return;
    document.querySelectorAll(".col-resizer.active").forEach((r) => r.classList.remove("active"));
    document.body.style.userSelect = "";
    try {
      localStorage.setItem(
        "htmlreview:leftw",
        document.documentElement.style.getPropertyValue("--left-w") || "50%",
      );
    } catch (e) {}
    rzTarget = null;
  });
  document.addEventListener("dblclick", (e) => {
    if (!eventElement(e)?.closest(".col-resizer")) return;
    document.documentElement.style.setProperty("--left-w", "34%");
    try {
      localStorage.setItem("htmlreview:leftw", "34%");
    } catch (e) {}
  });

  // ---- diagram / image lightbox (click to fullscreen) ----
  const lb = document.getElementById("lightbox"),
    lbInner = lb.querySelector(".lb-inner");
  document.addEventListener("click", (e) => {
    const target = eventElement(e);
    if (!lb.hidden && target && lb.contains(target)) {
      lb.hidden = true;
      lbInner.innerHTML = "";
      return;
    }
    const pasted = target?.closest(".comment-attachment img");
    const db = target?.closest(".diagram-body");
    const g = pasted || (db && db.querySelector("svg,img"));
    if (!g) return;
    lbInner.innerHTML = "";
    lbInner.appendChild(g.cloneNode(true));
    lb.hidden = false;
  });

  // ---- fullscreen the diff ----
  // The .maximized CSS overlay is the source of truth (instant, works anywhere);
  // native Fullscreen is a best-effort upgrade to also hide browser chrome.
  function enterMax(db: UiElement): void {
    db.classList.add("maximized");
    db.requestFullscreen().catch(() => {});
  }
  function exitMax(db: UiElement): void {
    db.classList.remove("maximized");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  document.querySelectorAll(".dbh-fs").forEach((btn) => {
    btn.addEventListener("click", () => {
      const db = btn.closest(".diff-block");
      if (db.classList.contains("maximized")) exitMax(db);
      else enterMax(db);
    });
  });
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement)
      document
        .querySelectorAll(".diff-block.maximized")
        .forEach((d) => d.classList.remove("maximized"));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!fileModal.hidden) {
      closeFileModal();
      return;
    }
    if (!lb.hidden) {
      lb.hidden = true;
      lbInner.innerHTML = "";
      return;
    }
    const tree = document.getElementById("fileTree");
    if (tree && !tree.hidden) {
      toggleTree();
      return;
    }
    document.querySelectorAll(".diff-block.maximized").forEach((d) => exitMax(d));
  });

  // ---- sticky offsets: measure header/diff-head so file headers stick cleanly ----
  function setStickyVars(): void {
    const rs = document.documentElement.style;
    const app = document.querySelector(".app-header");
    rs.setProperty("--h-app", (app ? app.offsetHeight : 57) + "px");
    rs.setProperty("--h-tabs", "0px");
    const dh = document.querySelector(".diff-block-head");
    rs.setProperty("--h-diffhead", (dh ? dh.offsetHeight : 42) + "px");
  }
  setStickyVars();
  window.addEventListener("resize", setStickyVars);
  window.addEventListener("load", setStickyVars);

  // ---- overall-review sidebar editor: expanded by default, persisted ----
  let overallCollapsed = false;
  try {
    overallCollapsed = localStorage.getItem("htmlreview:overallcollapsed") === "1";
  } catch (e) {}
  document.body.classList.toggle("oq-collapsed", overallCollapsed);
  document
    .querySelectorAll(".overall-bar.collapsed")
    .forEach((bar) => bar.classList.remove("collapsed"));
  document.querySelectorAll(".ob-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = document.body.classList.toggle("oq-collapsed");
      try {
        localStorage.setItem("htmlreview:overallcollapsed", c ? "1" : "0");
      } catch (e) {}
    });
  });

  // ---- init ----
  setMode(mode);
  renderFindingList();
  updateCounts();
  renderOrphans();
})();
