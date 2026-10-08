import {
  githubReviewPreview,
  prepareGithubReview,
  rangeStartMatchesAnchor,
  type GithubPublicationContext,
  type GithubReviewEvent,
  type GithubReviewPlan,
  type ReviewDraftComment,
} from "../scripts/lib/github-review.mjs";
import {
  ReviewServerClient,
  SCROLL_STORAGE_KEY,
  StateSyncer,
  UNSAVED_STORAGE_KEY,
  isStaleReview,
  mergeReviewStates,
  readServeToken,
  type ReviewStateRecord,
  type ServerSession,
} from "./review-sync.js";
import { renderFindingMarkdown, renderInlineMarkdown } from "./inline-markdown.js";
import {
  SHORTCUTS,
  STATE_VERSION,
  debounce,
  hunkGaps,
  type HunkGaps,
  markdownCodeBlock,
  markdownListItem,
  normalizeStoredState,
  shortcutAction,
} from "./review-helpers.js";
import {
  createReviewData,
  ensureFingerprints,
  rowKey,
  type ClientFile,
  type ClientHunk,
  type ClientRow,
  type EmbeddedReviewData,
} from "./review-data.js";
import {
  filterNavigationItems,
  findingsWithinNavigationLines,
  firstNavigationLineMatch,
  type NavigationItem,
  type NavigationQuery,
} from "./review-navigation.js";

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

interface SplitPair {
  l: ClientRow | null;
  r: ClientRow | null;
  ctx?: boolean;
  gap?: number;
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
  /** Inline data URL (browser storage). */
  data?: string;
  /** Uploaded image file name (served mode). */
  file?: string;
}

type AskAction = "ask" | "explain" | "fix";

interface ThreadMessage {
  role: "user" | "assistant" | "error";
  action: AskAction;
  text: string;
  suggestion?: string | null;
  provider?: string;
  durationMs?: number;
  costUsd?: number;
  at: string;
}

interface StoredThread {
  pr: string;
  file: string;
  key: string;
  startKey: string;
  lineno: string;
  startLineno: string;
  side: "old" | "new";
  fingerprint?: string;
  contentFingerprint?: string;
  findingAid?: string;
  rows: Array<{ line: string; kind: "add" | "del" | "ctx"; code: string }>;
  messages: ThreadMessage[];
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
  version: number;
  general: Record<string, string>;
  lines: Record<string, StoredLineComment>;
  aiState: Record<string, string>;
  aiReply: Record<string, boolean>;
  files: Record<string, StoredFileComment>;
  viewed: Record<string, boolean>;
  grouping: Record<string, "grouped" | "raw">;
  attachments: Record<string, Attachment[]>;
  threads: Record<string, StoredThread>;
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
  options?: string[];
  suggestedChange?: string;
}

interface AutomatedReview {
  verdict: string;
  global: string;
  comments: AutomatedFinding[];
}

interface TreeFile extends NavigationItem {
  findingRefs: AutomatedFinding[];
  topSeverity: string;
  change: string;
  topic: string;
  name: string;
  add: number;
  del: number;
}

interface TreeNode {
  dirs: Record<string, TreeNode>;
  files: TreeFile[];
}

interface MarkdownFile {
  note: string;
  lines: StoredLineComment[];
}

type ReviewData = Record<string, AutomatedReview>;
type GithubData = Record<string, GithubPublicationContext>;

function parseEmbeddedJson<T>(elementId: string): T {
  return JSON.parse(document.getElementById(elementId).textContent || "{}") as T;
}

function eventElement(event: Event): UiElement | null {
  return event.target instanceof HTMLElement ? (event.target as UiElement) : null;
}

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

void (async function () {
  const REVIEW_ID = "{{REVIEW_ID}}";
  const REVIEWER = "{{REVIEWER}}";
  const STORE_KEY = "htmlreview:" + REVIEW_ID;
  const MODE_KEY = "htmlreview:diffmode";
  const TITLE = document.querySelector(".app-header h1").textContent;
  const SUBTITLE = document.querySelector(".app-header .subtitle").textContent;
  const DATA = createReviewData(parseEmbeddedJson<Partial<EmbeddedReviewData>>("review-data"));
  const REVIEW = parseEmbeddedJson<ReviewData>("ai-review-data");
  const GITHUB = parseEmbeddedJson<GithubData>("github-review-data");
  const HAS_REVIEW = Object.keys(REVIEW).length > 0;
  const findingCursor: Record<string, number> = {};

  // ---- served mode ----
  // Opened from `trace-review serve`, the page keeps state on disk through the
  // loopback server. Without a token (file://, or a copied URL) it stays on
  // localStorage exactly like a static review.
  const serveToken = readServeToken(window.location, safeSessionStorage(), (url) =>
    history.replaceState(null, "", url),
  );
  let server: ReviewServerClient | null = serveToken
    ? new ReviewServerClient(serveToken, REVIEW_ID)
    : null;
  let session: ServerSession | null = null;
  let diskState: { revision: number; state: ReviewStateRecord } | null = null;
  if (server) {
    try {
      session = await server.session();
      diskState = await server.loadState();
    } catch (error) {
      server = null;
    }
  }

  // ---- state ----
  // Loaded state is validated field by field: a corrupt or foreign entry is
  // dropped instead of breaking the page.
  let localState: unknown = null;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) localState = JSON.parse(raw);
  } catch (e) {}
  // Edits an older build of this page could not save (the review was rebuilt
  // under a new ID meanwhile) are merged into the migrated state.
  let restoredUnsaved: ReviewStateRecord | null = null;
  if (diskState) {
    try {
      const raw = safeSessionStorage()?.getItem(UNSAVED_STORAGE_KEY);
      const unsaved = raw
        ? (JSON.parse(raw) as {
            from?: string;
            at?: number;
            base?: ReviewStateRecord;
            local?: ReviewStateRecord;
          })
        : null;
      if (unsaved && Date.now() - (unsaved.at || 0) > 10 * 60_000) {
        safeSessionStorage()?.removeItem(UNSAVED_STORAGE_KEY);
      } else if (unsaved && unsaved.from !== REVIEW_ID && unsaved.base && unsaved.local) {
        safeSessionStorage()?.removeItem(UNSAVED_STORAGE_KEY);
        restoredUnsaved = mergeReviewStates(diskState.state, unsaved.base, unsaved.local).merged;
      }
    } catch {}
  }
  const state = normalizeStoredState(
    restoredUnsaved ?? (diskState ? diskState.state : localState),
  ) as unknown as ReviewState;
  state.version = STATE_VERSION;
  const STATE_MAPS = [
    "general",
    "lines",
    "aiState",
    "aiReply",
    "files",
    "viewed",
    "grouping",
    "attachments",
    "threads",
  ] as const;
  const stateIsEmpty = (candidate: ReviewState): boolean =>
    STATE_MAPS.every((key) => Object.keys(candidate[key] || {}).length === 0);
  // First served load: bring this review's browser comments to disk.
  let importedLocalState = false;
  if (server && diskState && diskState.revision === 0 && stateIsEmpty(state)) {
    const imported = normalizeStoredState(localState) as unknown as ReviewState;
    if (!stateIsEmpty(imported)) {
      const client = server;
      for (const [id, items] of Object.entries(imported.attachments)) {
        const uploaded = await Promise.all(
          items.map((item) =>
            item.data && !item.file
              ? client.uploadAttachment(item.name, item.type, item.data).catch(() => null)
              : Promise.resolve(item),
          ),
        );
        imported.attachments[id] = uploaded.filter((item): item is Attachment => !!item?.file);
      }
      STATE_MAPS.forEach((key) => Object.assign(state, { [key]: imported[key] }));
      importedLocalState = true;
    }
  }
  if (server) {
    const client = server;
    await Promise.all(
      Object.values(state.attachments)
        .flat()
        .filter((item) => item.file)
        .map((item) => client.loadAttachment(item.file || "").catch(() => "")),
    );
  }
  // The disk copy never carries inline image data.
  function diskSnapshot(): ReviewStateRecord {
    const copy = JSON.parse(JSON.stringify(state)) as ReviewState;
    for (const id of Object.keys(copy.attachments)) {
      copy.attachments[id] = copy.attachments[id]
        .filter((item) => item.file)
        .map((item) => ({ name: item.name, type: item.type, file: item.file }));
      if (!copy.attachments[id].length) delete copy.attachments[id];
    }
    return copy as unknown as ReviewStateRecord;
  }
  const serveBadge = document.getElementById("serveBadge");
  function showServeStatus(message: string, tone: "info" | "error" = "info"): void {
    const status = document.getElementById("serveStatus");
    if (!status) return;
    status.querySelector("[data-serve-status-text]").textContent = message;
    status.classList.toggle("error", tone === "error");
    status.hidden = !message;
  }
  // Reload the page (state is on disk) and come back to the same place.
  async function reloadPreservingScroll(): Promise<void> {
    await syncer?.flush();
    try {
      safeSessionStorage()?.setItem(
        SCROLL_STORAGE_KEY,
        JSON.stringify({ y: window.scrollY, at: Date.now() }),
      );
    } catch {}
    window.location.reload();
  }
  // The server says this page is an older build: reload into the new one.
  let reloadingStale = false;
  function reloadStale(): void {
    if (reloadingStale) return;
    reloadingStale = true;
    showServeStatus("The review was rebuilt; reloading with your comments…");
    void reloadPreservingScroll();
  }
  if (server) server.onStale = reloadStale;
  const syncer =
    server && diskState
      ? new StateSyncer(server, diskState.revision, diskState.state, {
          feedback: () => buildFeedback(),
          snapshot: diskSnapshot,
          replace(merged) {
            const next = normalizeStoredState(merged) as unknown as ReviewState;
            STATE_MAPS.forEach((key) => Object.assign(state, { [key]: next[key] }));
          },
          remoteChanged: () => void reloadPreservingScroll(),
          stale(base, local) {
            if (JSON.stringify(base) !== JSON.stringify(local)) {
              try {
                safeSessionStorage()?.setItem(
                  UNSAVED_STORAGE_KEY,
                  JSON.stringify({ from: REVIEW_ID, at: Date.now(), base, local }),
                );
              } catch {}
            }
            reloadStale();
          },
          status(kind, message) {
            if (serveBadge) {
              serveBadge.textContent =
                kind === "saving" ? "Saving…" : kind === "saved" ? "Saved to disk" : "Not saved";
              serveBadge.classList.toggle("error", kind === "error");
            }
            if (kind === "error") showServeStatus(message || "Not saved", "error");
            else if (kind === "saved") showServeStatus("");
          },
        })
      : null;

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
  // Wrap the changed-token ranges (offsets into the line text) of a word
  // diff around the already highlighted HTML of that line.
  function applyWordDiffMarkup(
    highlightedHtml: string,
    ranges: readonly number[] | undefined,
    textLength: number,
  ): string {
    if (!ranges?.length) return highlightedHtml;
    const changedRanges: Array<{ start: number; end: number }> = [];
    for (let index = 0; index + 1 < ranges.length; index += 2) {
      changedRanges.push({ start: ranges[index], end: ranges[index + 1] });
    }
    const diffOffset = textLength;

    const syntaxTemplate = document.createElement("template") as HTMLTemplateElement;
    syntaxTemplate.innerHTML = highlightedHtml;
    const syntaxWalker = document.createTreeWalker(syntaxTemplate.content, NodeFilter.SHOW_TEXT);
    const syntaxNodes: Array<{ node: Text; start: number; end: number }> = [];
    let syntaxOffset = 0;
    let syntaxNode: Node | null;
    while ((syntaxNode = syntaxWalker.nextNode())) {
      const length = syntaxNode.textContent?.length || 0;
      syntaxNodes.push({
        node: syntaxNode as Text,
        start: syntaxOffset,
        end: syntaxOffset + length,
      });
      syntaxOffset += length;
    }
    if (syntaxOffset !== diffOffset) return highlightedHtml;

    for (const item of syntaxNodes) {
      const text = item.node.data;
      const overlaps = changedRanges.filter(
        (range) => range.start < item.end && range.end > item.start,
      );
      if (!overlaps.length) continue;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const range of overlaps) {
        const start = Math.max(range.start, item.start) - item.start;
        const end = Math.min(range.end, item.end) - item.start;
        if (start > cursor) fragment.append(text.slice(cursor, start));
        const changed = document.createElement("span");
        changed.className = "wd";
        changed.textContent = text.slice(start, end);
        fragment.append(changed);
        cursor = end;
      }
      if (cursor < text.length) fragment.append(text.slice(cursor));
      item.node.replaceWith(fragment);
    }
    return syntaxTemplate.innerHTML;
  }
  // Annotate each row of a hunk with its highlighted HTML (r._hl). Filtered
  // hunks share row objects with their unfiltered hunk, which is highlighted
  // once as a whole so every view gets the same, fully contextual colouring.
  function annotateHl(hunk: ClientHunk, lang: string): void {
    const h = hunk.base || hunk;
    if (h.highlighted) return;
    h.highlighted = true;
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
      if (r.t !== "c") r._hl = applyWordDiffMarkup(r._hl, r.w, r.c.length);
    }
  }
  // Saving can fail (quota exceeded by pasted images, storage disabled). Say so
  // without blocking the reviewer, and clear the warning once a save succeeds.
  let saveFailed = false;
  const save = (): void => {
    if (syncer) {
      syncer.schedule();
      return;
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      if (saveFailed) {
        saveFailed = false;
        document.getElementById("saveWarning").hidden = true;
      }
    } catch (error) {
      if (saveFailed) return;
      saveFailed = true;
      const quota = error instanceof DOMException && /quota/i.test(error.name + error.message);
      document.getElementById("saveWarningText").textContent = quota
        ? "Browser storage is full, so recent comments are not saved. Copy or share the review, or remove pasted images."
        : "This browser blocked storage, so recent comments are not saved. Copy or share the review before closing the page.";
      document.getElementById("saveWarning").hidden = false;
    }
  };
  document.getElementById("dismissServeStatus")?.addEventListener("click", () => {
    document.getElementById("serveStatus").hidden = true;
  });
  document.getElementById("dismissSaveWarning")?.addEventListener("click", () => {
    document.getElementById("saveWarning").hidden = true;
  });
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
  // Comment and thread IDs contain NUL separators, which CSS.escape rewrites to
  // U+FFFD, so attribute selectors cannot match them; compare directly instead.
  const rowsWithData = (
    root: ParentNode,
    selector: string,
    key: string,
    value: string,
  ): UiElement[] =>
    [...root.querySelectorAll(selector)].filter((row) => row.dataset[key] === value);
  const attachmentId = (kind: string, pr?: string, file?: string, key?: string): string =>
    [kind, pr || "", file || "", key || ""].join("\0");
  const attachmentItems = (id: string): Attachment[] => state.attachments[id] || [];
  const attachmentSrc = (item: Attachment): string =>
    item.data || (item.file && server ? server.cachedAttachmentUrl(item.file) : "");
  // Exported Markdown points at the image: inline data, or the file on disk.
  const attachmentLink = (item: Attachment): string =>
    item.file && session?.attachmentsDir
      ? "<" + (session.attachmentsDir + "/" + item.file).replace(/\\/g, "/") + ">"
      : item.data || "";
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
          `<figure class="comment-attachment"><img src="${escAttr(attachmentSrc(item))}" alt="Pasted image ${index + 1}"><button type="button" data-remove-attachment="${index}" title="Remove image">×</button></figure>`,
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
        reader.addEventListener("load", async () => {
          const name = file.name || "pasted-image";
          const type = file.type || "image/png";
          let item: Attachment = { name, type, data: String(reader.result) };
          if (server) {
            try {
              item = await server.uploadAttachment(name, type, String(reader.result));
            } catch (error) {
              window.alert(
                "The image could not be saved: " +
                  (error instanceof Error ? error.message : String(error)),
              );
              return;
            }
          }
          const items = attachmentItems(id).slice();
          items.push(item);
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

  // ---- dialogs: focus moves in, Tab stays inside, Escape closes, focus returns ----
  const openDialogs: UiElement[] = [];
  const dialogReturnFocus = new Map<UiElement, Element | null>();
  const dialogClosers = new Map<UiElement, () => void>();
  const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
  function focusableIn(root: UiElement): UiElement[] {
    return [...root.querySelectorAll(FOCUSABLE)].filter(
      (element) => element.getClientRects().length > 0,
    );
  }
  function openDialog(dialog: UiElement, initial?: UiElement | null): void {
    if (dialog.hidden) {
      dialogReturnFocus.set(dialog, document.activeElement);
      openDialogs.push(dialog);
    }
    dialog.hidden = false;
    const card = dialog.querySelector(".modal-card");
    if (card && !card.hasAttribute("tabindex")) card.setAttribute("tabindex", "-1");
    (initial || focusableIn(dialog)[0] || card)?.focus();
  }
  function closeDialog(dialog: UiElement): void {
    if (dialog.hidden) return;
    dialog.hidden = true;
    const index = openDialogs.indexOf(dialog);
    if (index >= 0) openDialogs.splice(index, 1);
    const back = dialogReturnFocus.get(dialog);
    dialogReturnFocus.delete(dialog);
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  }
  function closeTopDialog(): boolean {
    const top = openDialogs[openDialogs.length - 1];
    if (!top) return false;
    (dialogClosers.get(top) || (() => closeDialog(top)))();
    return true;
  }
  document.addEventListener("keydown", (event) => {
    const top = openDialogs[openDialogs.length - 1];
    if (!top || event.key !== "Tab") return;
    const items = focusableIn(top);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0],
      last = items[items.length - 1],
      active = document.activeElement;
    if (event.shiftKey && (active === first || !top.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !top.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });

  // ---- diff table builders (client-side, per mode) ----
  // Gutters carry only their anchor; code and fingerprints are read from the
  // embedded row (rowFor) instead of being copied into every cell.
  function gutter(file: string, key: string): string {
    return `<td class="gutter" data-file="${escAttr(file)}" data-key="${escAttr(key)}" title="Comment">+</td>`;
  }
  const linenoOf = (g: UiElement): string => (g.dataset.key || "").replace(/^o/, "");
  const rowIndexes = new WeakMap<ClientFile, Map<string, ClientRow>>();
  function rowsByKey(fd: ClientFile): Map<string, ClientRow> {
    let index = rowIndexes.get(fd);
    if (!index) {
      index = new Map();
      for (const hunk of fd.hunks) for (const row of hunk.rows) index.set(rowKey(row), row);
      rowIndexes.set(fd, index);
    }
    return index;
  }
  // The stored (unfiltered) file of a view, with its fingerprints filled.
  function storedFile(fd: ClientFile): ClientFile {
    const file = DATA.file(fd.index) || fd;
    ensureFingerprints(file);
    return file;
  }
  function mountFile(element: Element): ClientFile | undefined {
    return DATA.view(element.closest(".diff-mount")?.dataset.fid);
  }
  function rowFor(g: UiElement): ClientRow | undefined {
    const fd = mountFile(g);
    if (!fd) return undefined;
    storedFile(fd);
    return rowsByKey(fd).get(g.dataset.key || "");
  }
  // Group views keep only some rows of a hunk; say so instead of letting the
  // line numbers jump silently.
  function gapRow(skipped: number, columns: number): string {
    return `<tr class="line-gap"><td colspan="${columns}">⋯ ${skipped} line${skipped === 1 ? "" : "s"} in other groups</td></tr>`;
  }
  // A filtered hunk knows its unfiltered hunk, which tells a group view
  // exactly which rows it does not show.
  function gapsFor(h: ClientHunk): HunkGaps {
    return hunkGaps(h.rows, h.base?.rows);
  }
  function unifiedTable(fd: ClientFile): string {
    let b = "";
    if (!fd.hunks.length) {
      b = `<tr class="line line-info"><td class="ln"></td><td class="ln"></td><td class="gutter empty"></td><td class="code"><em>${escAttr(fd.note || "")}</em></td></tr>`;
    } else
      for (const h of fd.hunks) {
        annotateHl(h, fd.lang);
        b += `<tr class="line line-hunk"><td class="ln"></td><td class="ln"></td><td class="gutter empty"></td><td class="code">@@ ${escAttr(h.header)}</td></tr>`;
        const gaps = gapsFor(h);
        for (const [index, r] of h.rows.entries()) {
          const skipped = gaps.before.get(index);
          if (skipped) b += gapRow(skipped, 4);
          const cls = r.t === "a" ? "line-add" : r.t === "d" ? "line-del" : "line-ctx";
          const marker = r.t === "a" ? "+" : r.t === "d" ? "-" : " ";
          const key = rowKey(r);
          b +=
            `<tr class="line ${cls}">` +
            `<td class="ln ln-old">${r.t !== "a" && r.o != null ? r.o : ""}</td>` +
            `<td class="ln ln-new">${r.t !== "d" && r.n != null ? r.n : ""}</td>` +
            gutter(fd.path, key) +
            `<td class="code"><span class="marker">${marker}</span>${r._hl}</td>` +
            `</tr>`;
        }
        if (gaps.after) b += gapRow(gaps.after, 4);
      }
    return `<table class="diff unified"><colgroup><col class="c-ln"><col class="c-ln"><col class="c-gut"><col></colgroup><tbody>${b}</tbody></table>`;
  }
  function splitPairs(h: ClientHunk, gaps: HunkGaps): SplitPair[] {
    const out: SplitPair[] = [];
    let dels: ClientRow[] = [],
      adds: ClientRow[] = [];
    const flush = () => {
      const m = Math.max(dels.length, adds.length);
      for (let i = 0; i < m; i++) out.push({ l: dels[i] || null, r: adds[i] || null });
      dels = [];
      adds = [];
    };
    for (const [index, r] of h.rows.entries()) {
      const skipped = gaps.before.get(index);
      if (skipped) {
        flush();
        out.push({ l: null, r: null, gap: skipped });
      }
      if (r.t === "d") dels.push(r);
      else if (r.t === "a") adds.push(r);
      else {
        flush();
        out.push({ l: r, r: r, ctx: true });
      }
    }
    flush();
    if (gaps.after) out.push({ l: null, r: null, gap: gaps.after });
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
        for (const p of splitPairs(h, gapsFor(h))) {
          if (p.gap) {
            b += gapRow(p.gap, 6);
            continue;
          }
          b += `<tr class="line">`;
          // left (old side)
          if (p.ctx && p.l && p.r) {
            b += `<td class="ln ln-old">${p.l.o != null ? p.l.o : ""}</td><td class="gutter empty"></td><td class="code line-ctx">${p.l._hl}</td>`;
          } else if (p.l) {
            b +=
              `<td class="ln ln-old">${p.l.o != null ? p.l.o : ""}</td>` +
              gutter(fd.path, "o" + p.l.o) +
              `<td class="code line-del">${p.l._hl}</td>`;
          } else {
            b += `<td class="ln"></td><td class="gutter empty"></td><td class="code empty"></td>`;
          }
          // right (new side)
          if (p.ctx && p.l && p.r) {
            b +=
              `<td class="ln ln-new">${p.r.n != null ? p.r.n : ""}</td>` +
              gutter(fd.path, String(p.r.n)) +
              `<td class="code line-ctx">${p.r._hl}</td>`;
          } else if (p.r) {
            b +=
              `<td class="ln ln-new">${p.r.n != null ? p.r.n : ""}</td>` +
              gutter(fd.path, String(p.r.n)) +
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
    const existing = rowsWithData(mount, ".comment-row[data-cid]", "cid", id)[0];
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
    const endLine = parseInt(linenoOf(g), 10);
    const oldSide = key.startsWith("o");
    const candidates = new Map<string, string>();
    const candidateFingerprints = new Map<string, string>();
    let candidateRow: Element | null = tr;
    while (
      candidateRow &&
      !candidateRow.classList.contains("line-hunk") &&
      !candidateRow.classList.contains("line-gap")
    ) {
      candidateRow
        .querySelectorAll('.gutter[data-file="' + cssEsc(file) + '"][data-key]')
        .forEach((candidate) => {
          const candidateKey = candidate.dataset.key || "";
          const candidateLine = parseInt(linenoOf(candidate), 10);
          if (
            candidateKey &&
            candidateKey.startsWith("o") === oldSide &&
            Number.isInteger(candidateLine) &&
            candidateLine <= endLine
          ) {
            candidates.set(candidateKey, String(candidateLine));
            candidateFingerprints.set(candidateKey, rowFor(candidate)?.f || "");
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
    // A reply belongs under the finding card it answers, so skip past any LM
    // finding rows anchored on this line.
    let anchorRow: Element = tr;
    while (anchorRow.nextElementSibling?.classList.contains("ai-comment")) {
      anchorRow = anchorRow.nextElementSibling;
    }
    anchorRow.after(crow);
    const row = rowFor(g);
    const fd = mountFile(g);
    const store = () => {
      state.lines[id] = {
        pr,
        file,
        key,
        startKey: startSelect.value,
        lineno: linenoOf(g),
        startLineno: candidates.get(startSelect.value) || linenoOf(g),
        code: row?.c,
        text: ta.value,
        fingerprint: row?.f || "",
        contentFingerprint: row?.cf || "",
        startFingerprint: candidateFingerprints.get(startSelect.value) || "",
        diffFingerprint: (fd && storedFile(fd).fingerprint) || "",
      };
      save();
      updateCounts();
      renderOrphans();
      lineCommentChanged(id);
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
        lineCommentChanged(id);
      }
    });
    del.addEventListener("click", () => {
      delete state.lines[id];
      delete state.attachments[attachId];
      save();
      updateCounts();
      renderOrphans();
      crow.remove();
      lineCommentChanged(id);
    });
    if (prefill && !saved) store();
    return ta;
  }
  // Re-anchor saved comments on this mount's rows: by line fingerprint, then
  // by a content fingerprint that is unique in the file, then (comments saved
  // without fingerprints) by line key.
  function applyComments(mount: UiElement): void {
    const pr = mount.closest("section.pr").dataset.pr;
    const fd = DATA.view(mount.dataset.fid);
    if (!fd) return;
    const diffFingerprint = storedFile(fd).fingerprint || "";
    const rows = fd.hunks.flatMap((hunk) => hunk.rows);
    // Re-anchoring may touch many comments; persist once at the end.
    let dirty = false;
    for (const id in state.lines) {
      const c = state.lines[id];
      if (!c || c.pr !== pr || c.file !== fd.path) continue;
      const row =
        (c.fingerprint && rows.find((candidate) => candidate.f === c.fingerprint)) ||
        (c.contentFingerprint &&
          uniqueContentFingerprint(c.pr, c.file, c.contentFingerprint) &&
          rows.find((candidate) => candidate.cf === c.contentFingerprint)) ||
        (!c.fingerprint && rows.find((candidate) => rowKey(candidate) === c.key)) ||
        undefined;
      const g = row
        ? mount.querySelector(
            '.gutter[data-key="' + cssEsc(rowKey(row)) + '"][data-file="' + cssEsc(c.file) + '"]',
          )
        : null;
      if (row && g) {
        const rangePrefix = c.pr + "\0" + c.file + "\0";
        if (
          c.startKey &&
          c.startKey !== c.key &&
          (c.rangeStale ||
            !rangeStartMatchesAnchor(
              c.startFingerprint,
              lineEvidence(c.pr, c.file).anchorFingerprints.get(rangePrefix + c.startKey),
            ))
        ) {
          continue;
        }
        const currentKey = rowKey(row);
        const currentId = uid(pr, c.file, currentKey);
        const oldKey = c.key;
        if (id !== currentId) {
          if (c.startKey && c.startKey !== oldKey) {
            c.rangeStale = true;
            dirty = true;
            continue;
          }
          const oldAttachmentId = attachmentId("line", c.pr, c.file, c.key);
          const newAttachmentId = attachmentId("line", pr, c.file, currentKey);
          if (state.attachments[oldAttachmentId]) {
            state.attachments[newAttachmentId] = state.attachments[oldAttachmentId];
            delete state.attachments[oldAttachmentId];
          }
          delete state.lines[id];
          c.key = currentKey;
          c.lineno = linenoOf(g);
          if (!c.startKey || c.startKey === oldKey) {
            c.startKey = currentKey;
            c.startLineno = linenoOf(g);
          }
          c.code = row.c;
          c.diffFingerprint = diffFingerprint;
          state.lines[currentId] = c;
          dirty = true;
        }
        const fingerprint = row.f || "";
        const contentFingerprint = row.cf || "";
        if (
          c.fingerprint !== fingerprint ||
          c.contentFingerprint !== contentFingerprint ||
          c.diffFingerprint !== diffFingerprint
        ) {
          c.fingerprint = fingerprint;
          c.contentFingerprint = contentFingerprint;
          c.diffFingerprint = diffFingerprint;
          dirty = true;
        }
        createCommentRow(g, c.text);
      }
    }
    if (dirty) save();
  }

  // Per-file anchors and fingerprints. Keys are prefixed with
  // pr + "\0" + file + "\0" so the lookups read like a global index, but only
  // files that actually carry comments are ever fingerprinted.
  const lineEvidenceCache = new Map<string, LineEvidence>();
  function lineEvidence(pr: string, file: string): LineEvidence {
    const prefix = pr + "\0" + file + "\0";
    const cached = lineEvidenceCache.get(prefix);
    if (cached) return cached;
    const fingerprints = new Set<string>(),
      anchors = new Set<string>(),
      anchorFingerprints = new Map<string, string>(),
      content = new Map<string, Set<string>>();
    DATA.filesFor(pr, file).forEach((stored) => {
      ensureFingerprints(stored);
      stored.hunks.forEach((hunk) =>
        hunk.rows.forEach((row) => {
          const key = rowKey(row);
          if (row.f) fingerprints.add(prefix + row.f);
          anchors.add(prefix + key);
          anchorFingerprints.set(prefix + key, row.f || "");
          if (row.cf) {
            const contentKey = prefix + row.cf;
            const matches = content.get(contentKey) ?? new Set<string>();
            matches.add(row.f + "\0" + key);
            content.set(contentKey, matches);
          }
        }),
      );
    });
    const evidence = { fingerprints, anchors, anchorFingerprints, content };
    lineEvidenceCache.set(prefix, evidence);
    return evidence;
  }
  // Anchors alone need no hashing, so findings can be checked cheaply.
  const anchorCache = new Map<string, Set<string>>();
  function lineAnchors(pr: string, file: string): Set<string> {
    const prefix = pr + "\0" + file;
    let anchors = anchorCache.get(prefix);
    if (!anchors) {
      anchors = new Set(
        DATA.filesFor(pr, file).flatMap((stored) =>
          stored.hunks.flatMap((hunk) => hunk.rows.map(rowKey)),
        ),
      );
      anchorCache.set(prefix, anchors);
    }
    return anchors;
  }
  function uniqueContentFingerprint(pr: string, file: string, contentFingerprint: string): boolean {
    return (
      lineEvidence(pr, file).content.get(pr + "\0" + file + "\0" + contentFingerprint)?.size === 1
    );
  }
  function orphanedComments(): Array<[string, StoredLineComment]> {
    return Object.entries(state.lines).filter(([, comment]) => {
      if (!comment) return false;
      const prefix = comment.pr + "\0" + comment.file + "\0";
      const evidence = lineEvidence(comment.pr, comment.file);
      if (
        comment.startKey &&
        comment.startKey !== comment.key &&
        (comment.rangeStale ||
          !rangeStartMatchesAnchor(
            comment.startFingerprint,
            evidence.anchorFingerprints.get(prefix + comment.startKey),
          ))
      ) {
        return true;
      }
      if (!comment.fingerprint) return !evidence.anchors.has(prefix + comment.key);
      if (evidence.fingerprints.has(prefix + comment.fingerprint)) return false;
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

  // ---- current file (keyboard navigation target) ----
  let currentFile: UiElement | null = null;
  // Set by j/k so a second press during the smooth scroll steps from the
  // target instead of from whatever file is under the header mid-scroll.
  let steppedFile: UiElement | null = null;
  for (const type of ["wheel", "touchmove", "mousedown"]) {
    window.addEventListener(type, () => (steppedFile = null), { passive: true });
  }
  function setCurrentFile(fileEl: UiElement): void {
    currentFile = fileEl;
    if (fileEl !== steppedFile) steppedFile = null;
  }

  // ---- LM review (inline rows + findings list) ----
  function findingOptions(finding: AutomatedFinding): string[] {
    return finding.options?.length
      ? finding.options
      : ["Address this finding", "Keep current approach"];
  }
  // A finding is reviewed once an option is chosen or a reply with content
  // exists. Opening the reply box alone changes nothing.
  function findingReplied(pr: string, finding: AutomatedFinding): boolean {
    const comment = state.lines[uid(pr, finding.file, finding.key)];
    return (
      !!comment &&
      hasCommentContent(comment.text, attachmentId("line", pr, finding.file, finding.key))
    );
  }
  function findingReviewed(pr: string, finding: AutomatedFinding): boolean {
    return Boolean(state.aiState[pr + " " + finding.aid]) || findingReplied(pr, finding);
  }
  function findingStatus(pr: string, finding: AutomatedFinding): string {
    return [state.aiState[pr + " " + finding.aid] || "", findingReplied(pr, finding) ? "reply" : ""]
      .filter(Boolean)
      .join(" + ");
  }
  function findingAnchored(pr: string, finding: AutomatedFinding): boolean {
    return lineAnchors(pr, finding.file).has(finding.key);
  }
  const findingRowRefreshers = new Map<string, Set<() => void>>();
  let findingRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  function lineCommentChanged(id: string): void {
    const refreshers = findingRowRefreshers.get(id);
    if (!refreshers?.size) return;
    refreshers.forEach((refresh) => refresh());
    // The comment box saves on every keystroke; the list, progress and tree
    // are rebuilt once typing pauses.
    clearTimeout(findingRefreshTimer);
    findingRefreshTimer = setTimeout(() => {
      renderFindingList();
      updateProgress();
      refreshTree();
    }, 250);
  }
  function insertAiRow(g: UiElement, c: AutomatedFinding, pr: string): void {
    const tr = g.closest("tr");
    const mount = g.closest(".diff-mount");
    const aiId = pr + " " + c.aid;
    if (mount.querySelector('.ai-comment[data-aid="' + cssEsc(aiId) + '"]')) return;
    const severity = c.severity || "comment";
    g.classList.add("has-finding", "sev-" + severity);
    g.title = severity + " finding on this line · click to comment";
    const row = document.createElement("tr");
    row.className = "comment-row ai-comment sv-" + severity;
    row.dataset.aid = aiId;
    const td = document.createElement("td");
    td.colSpan = tr.children.length;
    const options = findingOptions(c);
    td.innerHTML = `<div class="ai-box">
      <div class="ai-box-head"><span class="who">✦ ${escAttr(REVIEWER)}</span><span class="sev sev-${escAttr(c.severity)}">${escAttr(c.severity)}</span><span class="ai-confidence">${Math.round(c.confidence * 100)}% confidence</span></div>
      <div class="ai-box-body">${renderFindingMarkdown(c.body)}</div>
      <div class="ai-rationale"><strong>Why:</strong> ${renderInlineMarkdown(c.rationale)}</div>
      ${c.suggestedChange ? `<div class="ai-suggested-change"><strong>Proposed change</strong><pre tabindex="0"><code>${escAttr(c.suggestedChange)}</code></pre></div>` : ""}
      <div class="ai-box-actions">${options.map((option, index) => `<button type="button" data-option="${index}" aria-pressed="false">${escAttr(option)}</button>`).join("")}<button type="button" data-a="reply">Reply</button>${server ? askButtonsHtml("data-ask-finding") : ""}<span class="ai-state"></span></div>
    </div>`;
    highlightMarkdownCode(td);
    row.appendChild(td);
    tr.after(row);
    const optionButtons = [...td.querySelectorAll("[data-option]")],
      rep = td.querySelector('[data-a="reply"]'),
      st = td.querySelector(".ai-state");
    const replyId = uid(pr, c.file, c.key);
    const refreshers = findingRowRefreshers.get(replyId) ?? new Set<() => void>();
    findingRowRefreshers.set(replyId, refreshers);
    const refresh = () => {
      if (!row.isConnected) {
        refreshers.delete(refresh);
        return;
      }
      const s = state.aiState[aiId] || "";
      optionButtons.forEach((button, index) => {
        const on = s === options[index];
        button.classList.toggle("on-option", on);
        button.setAttribute("aria-pressed", String(on));
      });
      rep.classList.toggle("on-reply", findingReplied(pr, c));
      st.textContent = findingStatus(pr, c);
    };
    refreshers.add(refresh);
    const changed = (): void => {
      save();
      refresh();
      renderFindingList();
      updateProgress();
      refreshTree();
    };
    optionButtons.forEach((button, index) =>
      button.addEventListener("click", () => {
        const option = options[index];
        if (state.aiState[aiId] === option) delete state.aiState[aiId];
        else state.aiState[aiId] = option;
        changed();
      }),
    );
    // Reply only opens the comment box under this card; the finding becomes
    // reviewed when that reply has content.
    rep.addEventListener("click", () => {
      const ta = createCommentRow(g, "");
      if (ta) ta.focus();
    });
    td.querySelectorAll("[data-ask-finding]").forEach((button) =>
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-disabled") === "true") return;
        const id = threadFromFinding(g, c, pr);
        startThreadAction(id, button.dataset.askFinding as AskAction);
      }),
    );
    syncAskButtons(td);
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

  // ---- ask about lines (served mode): Ask / Explain / Propose fix threads ----
  // A thread is anchored like a line comment (fingerprint, then key) and is
  // saved in state with its selected rows, so it survives rebuilds.
  const ASK_LABELS: Record<AskAction, string> = {
    ask: "Ask",
    explain: "Explain",
    fix: "Propose fix",
  };
  const ASK_DEFAULT_TEXT: Record<AskAction, string> = {
    ask: "",
    explain: "Explain these lines.",
    fix: "Propose a fix for these lines.",
  };
  let askBusy = false;
  const askPending = new Map<string, number>();
  function askButtonsHtml(attribute: string): string {
    return (["ask", "explain", "fix"] as const)
      .map(
        (action) =>
          `<button type="button" class="ask-btn" ${attribute}="${action}" data-ask-action="${action}">${ASK_LABELS[action]}</button>`,
      )
      .join("");
  }
  function askDisabledReason(): string {
    if (!server) return "Questions need the page opened by trace-review serve.";
    if (!session?.provider) {
      return "No claude or codex CLI is available. Restart serve with --llm claude or --llm codex.";
    }
    if (askBusy) return "Another request is running; wait for its answer.";
    return "";
  }
  function syncAskButtons(root: ParentNode = document): void {
    const reason = askDisabledReason();
    root.querySelectorAll("[data-ask-action]").forEach((button) => {
      button.setAttribute("aria-disabled", String(!!reason));
      button.title =
        reason || ASK_LABELS[button.dataset.askAction as AskAction] + " the language model";
    });
  }
  const threadKey = (pr: string, file: string, startKey: string, key: string, aid = ""): string =>
    ["ask", pr, file, startKey, key, aid].join("\0");
  const rowKind = (row: ClientRow | undefined): "add" | "del" | "ctx" =>
    row?.t === "a" ? "add" : row?.t === "d" ? "del" : "ctx";
  function threadFromRange(selection: DiffRangeSelection): string {
    const end = selection.end;
    const start = selection.start;
    const pr = end.closest("section.pr").dataset.pr || "";
    const id = threadKey(pr, selection.file, start.dataset.key || "", end.dataset.key || "");
    if (!state.threads[id]) {
      const row = rowFor(end);
      state.threads[id] = {
        pr,
        file: selection.file,
        key: end.dataset.key || "",
        startKey: start.dataset.key || "",
        lineno: linenoOf(end),
        startLineno: linenoOf(start),
        side: selection.oldSide ? "old" : "new",
        fingerprint: row?.f || "",
        contentFingerprint: row?.cf || "",
        rows: selection.rows.map((item) => ({ ...item })),
        messages: [],
      };
    }
    return id;
  }
  function threadFromFinding(g: UiElement, finding: AutomatedFinding, pr: string): string {
    const id = threadKey(pr, finding.file, finding.key, finding.key, finding.aid);
    if (!state.threads[id]) {
      const row = rowFor(g);
      state.threads[id] = {
        pr,
        file: finding.file,
        key: finding.key,
        startKey: finding.key,
        lineno: linenoOf(g),
        startLineno: linenoOf(g),
        side: finding.key.startsWith("o") ? "old" : "new",
        fingerprint: row?.f || "",
        contentFingerprint: row?.cf || "",
        findingAid: finding.aid,
        rows: [{ line: linenoOf(g), kind: rowKind(row), code: row?.c || "" }],
        messages: [],
      };
    }
    return id;
  }
  function threadAnchor(mount: UiElement, thread: StoredThread): UiElement | null {
    const fd = DATA.view(mount.dataset.fid);
    if (!fd || fd.path !== thread.file) return null;
    storedFile(fd);
    const rows = fd.hunks.flatMap((hunk) => hunk.rows);
    const row =
      (thread.fingerprint && rows.find((candidate) => candidate.f === thread.fingerprint)) ||
      rows.find((candidate) => rowKey(candidate) === thread.key);
    if (!row) return null;
    return mount.querySelector(
      '.gutter[data-key="' + cssEsc(rowKey(row)) + '"][data-file="' + cssEsc(thread.file) + '"]',
    );
  }
  function threadMeta(message: ThreadMessage): string {
    return [
      message.provider || "",
      message.durationMs != null ? (message.durationMs / 1000).toFixed(1) + " s" : "",
      message.costUsd != null ? "$" + message.costUsd.toFixed(4) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  function threadHtml(id: string, thread: StoredThread): string {
    const lines =
      thread.startLineno && thread.startLineno !== thread.lineno
        ? "lines " + thread.startLineno + "–" + thread.lineno
        : "line " + thread.lineno;
    const lang = fileLanguage(thread.pr, thread.file);
    const messages = thread.messages
      .map((message, index) => {
        if (message.role === "user") {
          return `<div class="ask-msg ask-user"><span class="ask-role">You · ${escAttr(ASK_LABELS[message.action] || "Ask")}</span><div class="ask-text">${escAttr(message.text)}</div></div>`;
        }
        if (message.role === "error") {
          return `<div class="ask-msg ask-error" role="alert"><span class="ask-role">Request failed</span><div class="ask-text">${escAttr(message.text)}</div></div>`;
        }
        const suggestion = message.suggestion
          ? `<pre class="md-code ask-suggestion"><code${/^[a-z0-9_+-]+$/i.test(lang) ? ` class="language-${lang}"` : ""}>${escAttr(message.suggestion)}</code></pre>` +
            (thread.side === "new"
              ? `<button type="button" class="ask-btn ask-primary" data-thread-suggest="${index}">Add as suggested change</button>`
              : "")
          : "";
        const meta = threadMeta(message);
        return `<div class="ask-msg ask-answer"><span class="ask-role">✦ ${escAttr(message.provider || "LM")}</span><div class="ask-body ai-box-body">${renderFindingMarkdown(message.text)}</div>${suggestion}${meta ? `<span class="ask-meta">${escAttr(meta)}</span>` : ""}</div>`;
      })
      .join("");
    const started = askPending.get(id);
    const pending = started
      ? `<div class="ask-msg ask-pending" aria-live="polite">Waiting for the answer… <span data-ask-elapsed="${started}">0 s</span></div>`
      : "";
    return (
      `<div class="ask-box"><div class="ask-head"><span class="who">✦ Ask LM</span><span class="ask-loc">${escAttr(thread.file)} · ${lines}</span><button type="button" class="ask-btn" data-thread-delete title="Delete this thread">Delete</button></div>` +
      messages +
      pending +
      `<div class="ask-input"><textarea data-thread-question placeholder="Ask about these lines…" aria-label="Question about ${escAttr(thread.file)} ${lines}"></textarea>` +
      `<div class="ask-actions"><button type="button" class="ask-btn ask-primary" data-thread-action="ask" data-ask-action="ask">Ask</button>` +
      `<button type="button" class="ask-btn" data-thread-action="explain" data-ask-action="explain">Explain</button>` +
      `<button type="button" class="ask-btn" data-thread-action="fix" data-ask-action="fix">Propose fix</button></div></div></div>`
    );
  }
  function renderThreadInto(mount: UiElement, id: string): void {
    const thread = state.threads[id];
    let row: UiElement | undefined = rowsWithData(mount, ".ask-thread", "thread", id)[0];
    const anchor = thread ? threadAnchor(mount, thread) : null;
    if (!thread || !anchor) {
      row?.remove();
      return;
    }
    const question = row?.querySelector("[data-thread-question]")?.value || "";
    if (!row) {
      row = document.createElement("tr");
      row.className = "comment-row ask-thread";
      row.dataset.thread = id;
      const td = document.createElement("td");
      td.colSpan = anchor.closest("tr").children.length;
      row.appendChild(td);
      let after: Element = anchor.closest("tr");
      while (after.nextElementSibling?.classList.contains("comment-row")) {
        after = after.nextElementSibling;
      }
      after.after(row);
    }
    (row.firstElementChild as UiElement).innerHTML = threadHtml(id, thread);
    row.querySelector("[data-thread-question]").value = question;
    highlightMarkdownCode(row);
    syncAskButtons(row);
  }
  function threadMounts(thread: StoredThread): UiElement[] {
    return [
      ...document.querySelectorAll(
        'section.pr[data-pr="' + cssEsc(thread.pr) + '"] .diff-mount[data-rendered]',
      ),
    ].filter((mount) => DATA.view(mount.dataset.fid)?.path === thread.file);
  }
  function renderThread(id: string): void {
    const thread = state.threads[id];
    if (!thread) {
      rowsWithData(document, ".ask-thread", "thread", id).forEach((row) => row.remove());
      return;
    }
    threadMounts(thread).forEach((mount) => renderThreadInto(mount, id));
  }
  function applyThreads(mount: UiElement): void {
    if (!server) return;
    const pr = mount.closest("section.pr").dataset.pr;
    const path = DATA.view(mount.dataset.fid)?.path;
    for (const id in state.threads) {
      const thread = state.threads[id];
      if (thread && thread.pr === pr && thread.file === path) renderThreadInto(mount, id);
    }
  }
  function focusThread(id: string): void {
    const thread = state.threads[id];
    const mount = thread && threadMounts(thread)[0];
    const row = mount ? rowsWithData(mount, ".ask-thread", "thread", id)[0] : undefined;
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    row?.querySelector("[data-thread-question]")?.focus();
  }
  function startThreadAction(id: string, action: AskAction, question = ""): void {
    renderThread(id);
    if (action === "ask" && !question.trim()) {
      focusThread(id);
      return;
    }
    void runAsk(id, action, question.trim());
  }
  function findingFor(pr: string, aid: string | undefined): AutomatedFinding | undefined {
    return aid ? REVIEW[pr]?.comments.find((comment) => comment.aid === aid) : undefined;
  }
  async function runAsk(id: string, action: AskAction, question: string): Promise<void> {
    const thread = state.threads[id];
    const client = server;
    if (!thread || !client) return;
    const reason = askDisabledReason();
    if (reason) {
      showServeStatus(reason, "error");
      return;
    }
    askBusy = true;
    askPending.set(id, Date.now());
    syncAskButtons();
    thread.messages.push({
      role: "user",
      action,
      text: question || ASK_DEFAULT_TEXT[action],
      at: new Date().toISOString(),
    });
    save();
    renderThread(id);
    const finding = findingFor(thread.pr, thread.findingAid);
    try {
      let job = await client.ask({
        action,
        question,
        file: thread.file,
        side: thread.side,
        rows: thread.rows,
        ...(finding
          ? {
              finding: {
                severity: finding.severity,
                body: finding.body,
                rationale: finding.rationale,
              },
            }
          : {}),
      });
      while (job.status === "pending") {
        await new Promise((resolve) => setTimeout(resolve, 700));
        job = await client.askStatus(job.id);
      }
      thread.messages.push(
        job.status === "done"
          ? {
              role: "assistant",
              action,
              text: job.answer || "",
              suggestion: job.suggestion ?? null,
              provider: job.provider,
              ...(job.durationMs != null ? { durationMs: job.durationMs } : {}),
              ...(job.costUsd != null ? { costUsd: job.costUsd } : {}),
              at: new Date().toISOString(),
            }
          : {
              role: "error",
              action,
              text: job.error || "The request failed.",
              at: new Date().toISOString(),
            },
      );
    } catch (error) {
      thread.messages.push({
        role: "error",
        action,
        text: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      });
    } finally {
      askBusy = false;
      askPending.delete(id);
      save();
      renderThread(id);
      syncAskButtons();
    }
  }
  setInterval(() => {
    document.querySelectorAll("[data-ask-elapsed]").forEach((label) => {
      label.textContent = Math.round((Date.now() - Number(label.dataset.askElapsed)) / 1000) + " s";
    });
  }, 1000);
  document.addEventListener("click", (event) => {
    const target = eventElement(event);
    const row = target?.closest(".ask-thread");
    if (!row || !target) return;
    const id = row.dataset.thread || "";
    const thread = state.threads[id];
    if (!thread) return;
    const actionButton = target.closest("[data-thread-action]");
    if (actionButton) {
      if (actionButton.getAttribute("aria-disabled") === "true") return;
      const input = row.querySelector("[data-thread-question]");
      const question = input?.value || "";
      if (input) input.value = "";
      startThreadAction(id, actionButton.dataset.threadAction as AskAction, question);
      return;
    }
    if (target.closest("[data-thread-delete]")) {
      delete state.threads[id];
      save();
      renderThread(id);
      return;
    }
    const suggest = target.closest("[data-thread-suggest]");
    if (suggest) {
      const message = thread.messages[Number(suggest.dataset.threadSuggest)];
      const mount = row.closest(".diff-mount");
      const end = threadAnchor(mount, thread);
      if (!message?.suggestion || !end) return;
      const block = "```suggestion\n" + message.suggestion + "\n```";
      const ta = createCommentRow(end, block, thread.startKey);
      // An existing comment on the end line takes the selected range as well.
      const start = ta?.closest(".comment-box")?.querySelector("select");
      if (start && start.value !== thread.startKey) {
        if ([...start.querySelectorAll("option")].some((o) => o.value === thread.startKey)) {
          start.value = thread.startKey;
          start.dispatchEvent(new Event("change"));
        }
      }
      if (ta && !ta.value.includes(block)) {
        ta.value = (ta.value.trim() ? ta.value + "\n\n" : "") + block;
        ta.dispatchEvent(new Event("input"));
      }
      ta?.focus();
    }
  });
  document.addEventListener("keydown", (event) => {
    const input = eventElement(event)?.closest("[data-thread-question]");
    if (!input || event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    (
      input.closest(".ask-thread")?.querySelector('[data-thread-action="ask"]') as UiElement | null
    )?.click();
  });
  function renderFindingList(): void {
    if (!HAS_REVIEW) return;
    document.querySelectorAll("[data-finding-list]").forEach((list) => {
      const pr = list.dataset.findingList;
      const rev = REVIEW[pr];
      if (!rev) return;
      list.innerHTML = rev.comments
        .map((c) => {
          const status = findingStatus(pr, c);
          const statusHtml = status ? `<span class="fi-status">${escAttr(status)}</span>` : "";
          const outside = findingAnchored(pr, c)
            ? ""
            : `<span class="outside-diff" title="This line is not part of the diff; opens the file instead">outside diff</span>`;
          return `<button type="button" class="finding-item sv-${escAttr(c.severity)}${status ? " done" : ""}" data-pr="${escAttr(pr)}" data-file="${escAttr(c.file)}" data-key="${escAttr(c.key)}" data-aid="${escAttr(c.aid)}"><span class="finding-top"><span class="sev sev-${escAttr(c.severity)}">${escAttr(c.severity)}</span><span class="finding-loc">${escAttr(c.file)}:${escAttr(c.line)}</span>${outside}<span class="ai-confidence">${Math.round(c.confidence * 100)}% confidence</span>${statusHtml}</span><span class="finding-text">${renderInlineMarkdown(c.body)}</span></button>`;
        })
        .join("");
    });
  }

  // ---- render all mounts in a mode ----
  // Mounts near the viewport render first (IntersectionObserver); the rest
  // fill in during idle time. When the idle callback fires by timeout
  // (timeRemaining() is 0 on a busy page) at least one mount still renders,
  // so a large review never stalls on "Preparing diff…".
  let renderGeneration = 0;
  let mountObserver: IntersectionObserver | null = null;
  function renderMount(mnt: UiElement, mode: "unified" | "split"): void {
    const fd = DATA.view(mnt.dataset.fid);
    if (!fd) return;
    mnt.innerHTML = mode === "split" ? splitTable(fd) : unifiedTable(fd);
    mnt.classList.remove("pending");
    // wide code scrolls horizontally, so keyboard users must be able to focus it
    if (!mnt.hasAttribute("tabindex")) {
      mnt.setAttribute("tabindex", "0");
      mnt.setAttribute("role", "region");
      mnt.setAttribute("aria-label", "Diff of " + fd.path);
    }
    mnt.dataset.rendered = mode;
    applyComments(mnt);
    applyReview(mnt);
    applyThreads(mnt);
  }
  // Render a mount now if the idle renderer has not reached it yet.
  function ensureRendered(fileEl: UiElement): void {
    const mount = fileEl.querySelector(".diff-mount");
    if (mount && mount.dataset.rendered !== mode) renderMount(mount, mode);
  }
  const whenIdle = (callback: (deadline: IdleDeadline | null) => void): void => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(callback, { timeout: 120 });
    else setTimeout(() => callback(null), 16);
  };
  // Hidden order views and hidden PR tabs are not rendered until shown.
  const mountShown = (mount: UiElement): boolean =>
    !mount.closest("[data-order-view][hidden], section.pr[hidden]");
  // `reset` (a diff-mode change) clears every mount; otherwise only shown
  // mounts that are not yet rendered in this mode are scheduled.
  function renderAll(mode: "unified" | "split", reset = true): void {
    const generation = ++renderGeneration;
    mountObserver?.disconnect();
    const all = [...document.querySelectorAll(".diff-mount")];
    if (reset) {
      all.forEach((mnt) => {
        mnt.innerHTML = "";
        delete mnt.dataset.rendered;
        mnt.classList.add("pending");
      });
    }
    const mounts = all.filter((mnt) => mnt.dataset.rendered !== mode && mountShown(mnt));
    const pending = new Set(mounts);
    const priority: UiElement[] = [];
    let cursor = 0;
    let scheduled = false;
    const nextMount = (): UiElement | undefined => {
      while (priority.length) {
        const mount = priority.shift();
        if (mount && pending.has(mount)) return mount;
      }
      while (cursor < mounts.length) {
        const mount = mounts[cursor++];
        if (pending.has(mount)) return mount;
      }
      return undefined;
    };
    const renderOne = (mount: UiElement): void => {
      pending.delete(mount);
      mountObserver?.unobserve(mount);
      if (mount.dataset.rendered !== mode) renderMount(mount, mode);
    };
    const finish = (): void => {
      mountObserver?.disconnect();
      mountObserver = null;
      renderOrphans();
    };
    const pump = (deadline: IdleDeadline | null): void => {
      scheduled = false;
      if (generation !== renderGeneration) return;
      let count = 0;
      let mount: UiElement | undefined;
      while (
        (count === 0 || (count < 8 && (!deadline || deadline.timeRemaining() > 2))) &&
        (mount = nextMount())
      ) {
        renderOne(mount);
        count++;
      }
      if (pending.size) schedule();
      else finish();
    };
    const schedule = (): void => {
      if (scheduled || generation !== renderGeneration) return;
      scheduled = true;
      whenIdle(pump);
    };
    if (typeof IntersectionObserver === "function") {
      mountObserver = new IntersectionObserver(
        (entries) => {
          if (generation !== renderGeneration) return;
          const visible = entries
            .filter((entry) => entry.isIntersecting && pending.has(entry.target as UiElement))
            .map((entry) => entry.target as UiElement);
          if (!visible.length) return;
          // render what is on screen now, without waiting for idle time
          visible.slice(0, 6).forEach(renderOne);
          priority.unshift(...visible.slice(6));
          if (pending.size) schedule();
          else finish();
        },
        { rootMargin: "600px 0px" },
      );
      mounts.forEach((mount) => mountObserver?.observe(mount));
    } else {
      mounts.slice(0, 4).forEach(renderOne);
    }
    if (pending.size) schedule();
    else finish();
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
      `<svg class="pd-ring" viewBox="0 0 46 46" aria-hidden="true"><circle class="pd-track" cx="23" cy="23" r="${r}"/>` +
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
          if (findingReviewed(p, c)) fdone++;
        }
      }
      if (ftotal) html += ring(fdone, ftotal, "Reviewed");
      const rv = pr ? REVIEW[pr] : null;
      if (rv?.comments?.length) {
        const cursor = Math.max(0, Math.min(findingCursor[pr] ?? 0, rv.comments.length - 1));
        findingCursor[pr] = cursor;
        html +=
          `<div class="pd-find-nav"><div class="pd-find-label">Finding ${cursor + 1}/${rv.comments.length}</div>` +
          `<button type="button" data-finding-step="-1" title="Previous finding (p)" aria-label="Previous finding">←</button>` +
          `<button type="button" data-finding-step="1" title="Next finding (n)" aria-label="Next finding">→</button></div>`;
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
    const candidates = visibleEvidenceFiles(sec).filter(
      (file) => file.dataset.file === it.dataset.file,
    );
    candidates.forEach(ensureRendered);
    const g = candidates
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
    if (!g) {
      // The anchor is outside the diff: open the file instead of doing nothing.
      const fileEl = candidates[0];
      if (!fileEl) return;
      const group = fileEl.closest(".group");
      if (group) group.classList.remove("collapsed");
      fileEl.classList.remove("collapsed");
      scrollFileToTop(fileEl);
      setCurrentFile(fileEl);
      return;
    }
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
  // Shift-click a second gutter to extend a range from the last clicked one.
  let lastGutter: UiElement | null = null;
  let hoveredGutter: UiElement | null = null;
  document.getElementById("main").addEventListener("click", (e) => {
    const g = eventElement(e)?.closest(".gutter");
    if (!g || g.classList.contains("empty") || !g.dataset.key) return;
    if (g.dataset.rangeClick === "ignore") {
      delete g.dataset.rangeClick;
      return;
    }
    const mouse = e as MouseEvent;
    if (mouse.shiftKey && lastGutter?.isConnected && lastGutter !== g) {
      const selection = rangeFor(lastGutter, g);
      if (selection) {
        window.getSelection()?.removeAllRanges();
        showRangeToolbar(selection, mouse.clientX, mouse.clientY);
        return;
      }
    }
    lastGutter = g;
    const ta = createCommentRow(g, "");
    if (ta) ta.focus();
  });
  document.getElementById("main").addEventListener("mouseover", (e) => {
    const row = eventElement(e)?.closest("tr.line");
    if (!row) return;
    const gutters = [...row.querySelectorAll(".gutter[data-key]")];
    // prefer the new side in split view, matching GitHub
    hoveredGutter = gutters[gutters.length - 1] || hoveredGutter;
  });
  document.getElementById("main").addEventListener("mouseleave", () => {
    hoveredGutter = null;
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
    const boundary = (row: UiElement): boolean =>
      row.classList.contains("line-hunk") || row.classList.contains("line-gap");
    while (first > 0 && !boundary(rows[first - 1])) first--;
    while (last < rows.length && !boundary(rows[last])) last++;
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
        line: linenoOf(gutter) || gutter.dataset.key || "",
        code: rowFor(gutter)?.c || "",
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
    if (mouse.shiftKey) {
      // shift-click extends a range in the click handler; avoid text selection
      event.preventDefault();
      return;
    }
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

  const rangeAskGroup = rangeToolbar.querySelector("[data-range-ask-group]");
  if (rangeAskGroup) {
    rangeAskGroup.hidden = !server;
    rangeAskGroup.innerHTML = server ? askButtonsHtml("data-range-ask") : "";
    syncAskButtons(rangeAskGroup);
    rangeAskGroup.querySelectorAll("[data-range-ask]").forEach((button) =>
      button.addEventListener("click", () => {
        if (!activeRange || button.getAttribute("aria-disabled") === "true") return;
        const id = threadFromRange(activeRange);
        hideRangeToolbar();
        startThreadAction(id, button.dataset.rangeAsk as AskAction);
      }),
    );
  }

  const carbonModal = document.getElementById("carbonModal");
  const carbonSelectable = document.getElementById("carbonSelectable");
  const carbonCanvas = document.getElementById("carbonCanvas") as unknown as HTMLCanvasElement;
  type CarbonTheme = "none" | "aurora" | "sunset" | "forest" | "slate";
  const carbonThemes: Record<
    CarbonTheme,
    { css: string; office: string; stops: [string, string, string] }
  > = {
    none: {
      css: "transparent",
      office: "#0d1117",
      stops: ["#0d1117", "#0d1117", "#0d1117"],
    },
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
  let carbonTheme: CarbonTheme = "none";
  let carbonFile = "";
  let carbonRows: ExportPairRow[] = [];
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
        const code = (gutter && rowFor(gutter)?.c) || "";
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

    const lang = mountFile(selection.start)?.lang || "";
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
      `<div class="carbon-sheet" style="min-width:${selectableExportWidth(rows, layout)}px;padding:${carbonTheme === "none" ? 0 : 24}px;background:${carbonThemes[carbonTheme].css}"><div class="carbon-window">` +
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

  // The HTML download mirrors the preview: same layout and background choice.
  function carbonRichDocument(
    file: string,
    rows: ExportPairRow[],
    layout: "split" | "compact",
    theme: CarbonTheme,
  ): string {
    const headStyle = "padding:4px 12px;color:#8b949e;background:#161b22;text-align:left";
    const table =
      layout === "compact"
        ? `<thead><tr><th style="${headStyle}">Unified diff</th></tr></thead><tbody>` +
          compactExportRows(rows)
            .map((side) => `<tr>${richSide(side, false)}</tr>`)
            .join("")
        : `<thead><tr><th style="${headStyle}">Before</th>` +
          `<th style="${headStyle};border-left:1px solid #30363d">After</th></tr></thead><tbody>` +
          rows
            .map((row) => `<tr>${richSide(row.old, false)}${richSide(row.next, true)}</tr>`)
            .join("");
    const padding = theme === "none" ? 0 : 24;
    const body =
      `<div style="box-sizing:border-box;width:max-content;min-width:${selectableExportWidth(rows, layout)}px;padding:${padding}px;border-radius:16px;background:${carbonThemes[theme].css}">` +
      `<div style="overflow:hidden;border-radius:14px;color:#e6edf3;background:#0d1117">` +
      `<div style="padding:16px 20px;color:#c9d1d9;font:600 13px ui-monospace,monospace;text-align:center">${escAttr(file)}</div>` +
      `<table style="width:100%;border-collapse:collapse;tab-size:4;font:13px/24px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">` +
      table +
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
      `<nobr><span style="display:inline-block;width:32pt;color:#8b949e;text-align:right">${escAttr(side.line)}</span>` +
      `<span style="display:inline-block;width:18pt;padding-left:4pt;color:${markerColor}">${marker}</span>` +
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
    const hasBackground = carbonTheme !== "none";
    const frameCell = hasBackground
      ? `<td width="20" bgcolor="${accent}" style="width:15pt;padding:0;background:${accent}">&nbsp;</td>`
      : "";
    const tableColumnCount = columnCount + (hasBackground ? 2 : 0);
    const frameRow = hasBackground
      ? `<tr><td colspan="${tableColumnCount}" bgcolor="${accent}" style="height:14pt;padding:0;background:${accent}">&nbsp;</td></tr>`
      : "";
    const before = rows.flatMap((row) => (row.old ? [row.old] : []));
    const after = rows.flatMap((row) => (row.next ? [row.next] : []));
    const titleSpacer = "&nbsp;".repeat(Math.max(6, Math.floor((120 - file.length) / 2) - 5));
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
      `<table width="${hasBackground ? 1000 : 960}" border="0" cellspacing="0" cellpadding="0" bgcolor="${accent}" ` +
      `style="width:${hasBackground ? 750 : 720}pt;border-collapse:collapse;table-layout:fixed;background:${accent}">` +
      frameRow +
      `<tr>${frameCell}<td colspan="${columnCount}" align="left" bgcolor="#0d1117" style="height:24pt;padding:0 8pt;background:#0d1117;` +
      `font-family:Consolas,'Courier New',monospace;font-size:9pt;font-weight:bold;color:#c9d1d9">` +
      `<span style="font-family:Arial,sans-serif;font-size:10pt;white-space:nowrap">` +
      `<span style="color:#ff5f56">●</span>&nbsp;<span style="color:#ffbd2e">●</span>&nbsp;<span style="color:#27c93f">●</span></span>` +
      `${titleSpacer}${escAttr(file)}</td>${frameCell}</tr>` +
      heading +
      body +
      frameRow +
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
    openDialog(carbonModal);
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
    closeDialog(carbonModal);
  });
  carbonModal.addEventListener("click", (event) => {
    if (event.target === carbonModal) closeDialog(carbonModal);
  });
  const showCarbonCopied = (label = "Copied ✓") => {
    const copied = document.getElementById("carbonCopied");
    copied.textContent = label;
    copied.hidden = false;
    setTimeout(() => (copied.hidden = true), 1800);
  };
  const currentCarbonFilename = () =>
    carbonFilenameBase + (carbonLayout === "compact" ? "-compact" : "");
  const downloadCarbon = (content: BlobPart, type: string, extension: string) => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([content], { type }));
    link.download = currentCarbonFilename() + extension;
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
    downloadCarbon(
      carbonRichDocument(carbonFile, carbonRows, carbonLayout, carbonTheme),
      "text/html;charset=utf-8",
      ".html",
    );
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
  function bindFileCollapse(h: UiElement): void {
    h.addEventListener("click", (e) => {
      if (eventElement(e)?.closest(".file-actions")) return;
      h.closest(".file").classList.toggle("collapsed");
    });
  }

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
    closeDialog(fileModal);
    fileModalCode.innerHTML = "";
    fileModalImage.innerHTML = "";
  }
  dialogClosers.set(fileModal, closeFileModal);
  fileModalTabs
    .querySelectorAll("[data-file-view]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        selectFileView(button.dataset.fileView === "image" ? "image" : "code"),
      ),
    );
  function bindViewFileButton(button: UiElement): void {
    // Nothing to show without embedded file content, so do not offer it.
    const contentFid = button.closest(".file")?.querySelector(".diff-mount")?.dataset.fid;
    if (!contentFid || typeof DATA.view(contentFid)?.fullFile?.content !== "string") {
      button.hidden = true;
      return;
    }
    button.addEventListener("click", () => {
      const fileEl = button.closest(".file");
      const fid = fileEl.querySelector(".diff-mount").dataset.fid;
      const file = DATA.view(fid);
      if (!file) return;
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
      openDialog(fileModal, document.getElementById("closeFileModal"));
    });
  }
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
  // The Git-order view may not be materialized yet, so its viewed state is
  // stored by key rather than through its elements.
  const rawViewedId = (sec: UiElement, file: string): string => sec.dataset.pr + " raw::" + file;
  const hasRawView = (sec: UiElement): boolean => !!sec.querySelector('[data-order-view="raw"]');
  function syncRawViewed(sec: UiElement, file: string, persist: boolean): void {
    const grouped = groupedOccurrences(sec, file),
      viewed =
        grouped.length > 0 && grouped.every((candidate) => candidate.classList.contains("viewed"));
    rawOccurrences(sec, file).forEach((candidate) => applyViewed(candidate, viewed));
    if (persist && hasRawView(sec)) {
      if (viewed) state.viewed[rawViewedId(sec, file)] = true;
      else delete state.viewed[rawViewedId(sec, file)];
    }
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
      if (hasRawView(sec)) state.viewed[rawViewedId(sec, file)] = true;
      delete state.viewed[legacyId];
      migratedViewedState = true;
    });
  });
  if (migratedViewedState) save();
  // Wire one file block. Blocks of a lazily materialized view take their
  // viewed state from the grouped view instead of their own stored key.
  function initFileElement(fileEl: UiElement, applyStoredViewed: boolean): void {
    const pr = fileEl.closest("section.pr").dataset.pr,
      id = viewedId(fileEl);
    const header = fileEl.querySelector(":scope > .file-header");
    if (header) bindFileCollapse(header);
    const viewButton = fileEl.querySelector(".view-file-btn");
    if (viewButton) bindViewFileButton(viewButton);
    const pathToggle = fileEl.querySelector(":scope > .file-header .file-path");
    if (pathToggle) bindHeaderToggle(pathToggle);
    syncExpanded(fileEl);
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
    if (applyStoredViewed && state.viewed[id]) setViewed(fileEl, true, false);
  }
  document.querySelectorAll(".file").forEach((fileEl) => initFileElement(fileEl, true));
  document.querySelectorAll("section.pr").forEach((sec) => {
    // A file marked viewed in Git order counts as viewed in every group.
    if (sec.querySelector("template[data-lazy-view]")) {
      new Set(
        [...sec.querySelectorAll('[data-order-view="grouped"] .file')].map(
          (file) => file.dataset.file,
        ),
      ).forEach((file) => {
        if (!state.viewed[rawViewedId(sec, file)]) return;
        const related = groupedOccurrences(sec, file);
        related.forEach((candidate) => applyViewed(candidate, true));
        new Set(related.map((candidate) => candidate.closest(".group")).filter(Boolean)).forEach(
          syncGroupCb,
        );
      });
    }
    new Set([...sec.querySelectorAll(".file")].map((file) => file.dataset.file)).forEach((file) =>
      syncRawViewed(sec, file, false),
    );
  });
  // Materialize the shown order views of a section that still ship as
  // inert <template>s, then wire their file blocks.
  function materializeViews(sec: UiElement): void {
    sec
      .querySelectorAll("[data-order-view]:not([hidden]) > template[data-lazy-view]")
      .forEach((template) => {
        const view = template.parentElement as UiElement;
        const content = (template as unknown as HTMLTemplateElement).content;
        template.remove();
        view.append(content);
        const files = [...view.querySelectorAll(".file")];
        files.forEach((fileEl) => initFileElement(fileEl, false));
        new Set(files.map((file) => file.dataset.file)).forEach((file) =>
          syncRawViewed(sec, file, false),
        );
        updateCounts();
      });
  }

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
  const navigationQuery: NavigationQuery = {};
  function navigationGroups(
    sec: UiElement,
    path: string,
  ): {
    groups: string[];
    risks: string[];
  } {
    const groups = new Set<string>(),
      risks = new Set<string>();
    groupedOccurrences(sec, path).forEach((file) => {
      const group = file.closest(".group");
      const title = group?.querySelector(".group-title")?.textContent.trim();
      const risk = group
        ?.querySelector(".group-risk")
        ?.textContent.replace(/\s+risk\s*$/i, "")
        .trim();
      if (title) groups.add(title);
      if (risk) risks.add(risk);
    });
    return { groups: [...groups], risks: [...risks] };
  }
  function navigationLines(file: UiElement): Array<{ key: string; text: string }> {
    const id = file.querySelector(".diff-mount")?.dataset.fid;
    if (!id) return [];
    return (DATA.view(id)?.hunks || [])
      .flatMap((hunk) => hunk.rows)
      .map((row) => ({ key: rowKey(row), text: row.c }))
      .filter((line) => line.key !== "undefined");
  }
  function isTestPath(path: string): boolean {
    return /(^|\/)(test|tests|spec|specs)(\/|$)|\.(test|spec)\.[^/]+$/i.test(path);
  }
  function isGeneratedPath(path: string): boolean {
    return (
      /(^|\/)(dist|build|coverage|vendor|generated|gen)(\/|$)/i.test(path) ||
      /\.(min\.(js|css)|generated\.[^.]+)$/i.test(path)
    );
  }
  // The navigation index is built once per PR and order view; only the
  // viewed / open-finding flags are refreshed on each update.
  const treeIndexCache = new Map<string, { elements: UiElement[]; files: TreeFile[] }>();
  const SEVERITY_RANK = ["concern", "question", "suggestion", "nit", "comment", "praise"];
  function collectTreeFiles(sec: UiElement): TreeFile[] {
    const pr = sec.dataset.pr || "";
    const elements = visibleEvidenceFiles(sec);
    const key =
      pr + "\0" + (sec.querySelector('[data-order-view="raw"]:not([hidden])') ? "raw" : "grouped");
    let cached = treeIndexCache.get(key);
    if (
      !cached ||
      cached.elements.length !== elements.length ||
      cached.elements.some((element, index) => element !== elements[index])
    ) {
      cached = { elements, files: buildTreeFiles(sec, elements) };
      treeIndexCache.set(key, cached);
    }
    cached.files.forEach((file, index) => {
      file.viewed = elements[index].classList.contains("viewed");
      file.hasOpenFinding = file.findingRefs.some((finding) => !findingReviewed(pr, finding));
    });
    return cached.files;
  }
  function buildTreeFiles(sec: UiElement, elements: UiElement[]): TreeFile[] {
    const pr = sec.dataset.pr || "";
    return elements.map((el) => {
      const p = el.dataset.file || "";
      const num = (sel: string): number => {
        const t = el.querySelector(".file-header " + sel);
        return t ? parseInt(t.textContent.replace(/[^0-9]/g, "")) || 0 : 0;
      };
      const metadata = navigationGroups(sec, p);
      const lines = navigationLines(el);
      const fileFindings = (REVIEW[pr]?.comments || []).filter((finding) => finding.file === p);
      const findings = findingsWithinNavigationLines(lines, fileFindings);
      const findingRefs = [
        ...findings,
        ...fileFindings.filter((finding) => !findingAnchored(pr, finding)),
      ];
      const topSeverity =
        SEVERITY_RANK.find((severity) =>
          findingRefs.some((finding) => finding.severity === severity),
        ) ||
        findingRefs[0]?.severity ||
        "";
      return {
        findingRefs,
        topSeverity,
        id: el.dataset.change || p,
        path: p,
        content: lines.map((line) => line.text).join("\n"),
        lines,
        findingText: findings.flatMap((finding) => [finding.body, finding.rationale]).join("\n"),
        findings: findings.map((finding) => ({
          key: finding.key,
          text: [finding.body, finding.rationale].join("\n"),
        })),
        hasOpenFinding: findings.some((finding) => !findingReviewed(pr, finding)),
        severities: [...new Set(findings.map((finding) => finding.severity))],
        test: isTestPath(p),
        generated: isGeneratedPath(p),
        risks: metadata.risks,
        groups: metadata.groups,
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
        html += `<li class="ft-dir"><div class="ft-row ft-dirrow" role="button" tabindex="0"><span class="ft-tw">▾</span><span class="ft-name">${escAttr(name)}</span></div><ul class="ft-children">${renderTreeDir(child)}</ul></li>`;
      });
    node.files
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((f) => {
        html += `<li class="ft-file${f.viewed ? " viewed" : ""}" data-file="${escAttr(f.path)}"${f.change ? ` data-change="${escAttr(f.change)}"` : ""}><div class="ft-row" role="button" tabindex="0"><span class="ft-name" title="${escAttr(f.path)}">${escAttr(f.name)}${f.topic ? `<small class="ft-topic">${escAttr(f.topic)}</small>` : ""}</span>${f.findingRefs.length ? `<span class="ft-find sev-${escAttr(f.topSeverity)}" title="${f.findingRefs.length} finding${f.findingRefs.length === 1 ? "" : "s"}, highest: ${escAttr(f.topSeverity)}" aria-label="${f.findingRefs.length} finding${f.findingRefs.length === 1 ? "" : "s"}, highest ${escAttr(f.topSeverity)}">${f.findingRefs.length}</span>` : ""}<span class="ft-stats"><span class="stat-add">+${f.add}</span> <span class="stat-del">-${f.del}</span></span></div></li>`;
      });
    return html;
  }
  function navigationSelectOptions(
    select: UiElement,
    values: string[],
    current: string | undefined,
  ): void {
    const label = select.dataset.navSelect === "group" ? "All groups" : "All";
    select.innerHTML = `<option value="">${label}</option>${values
      .sort((a, b) => a.localeCompare(b))
      .map((value) => `<option value="${escAttr(value)}">${escAttr(value)}</option>`)
      .join("")}`;
    select.value = current || "";
  }
  function syncNavigationControls(files: TreeFile[]): void {
    const w = document.getElementById("fileTree");
    w.querySelectorAll("[data-nav-toggle]").forEach((button) => {
      const key = button.dataset.navToggle as "unread" | "openFindings" | "tests" | "generated";
      button.setAttribute("aria-pressed", String(Boolean(navigationQuery[key])));
    });
    navigationSelectOptions(
      w.querySelector('[data-nav-select="group"]'),
      [...new Set(files.flatMap((file) => file.groups))],
      navigationQuery.group,
    );
  }
  function refreshTree(): void {
    const w = document.getElementById("fileTree");
    if (!w || w.hidden) return;
    const sec = activeSection();
    if (!sec) return;
    const files = collectTreeFiles(sec);
    const matches = filterNavigationItems(files, navigationQuery) as TreeFile[];
    const viewed = files.filter((f) => f.viewed).length;
    w.querySelector(".ft-count").textContent =
      files.length + " file" + (files.length === 1 ? "" : "s");
    w.querySelector(".ft-viewed").textContent = viewed + "/" + files.length + " viewed";
    w.querySelector("[data-nav-results]").textContent =
      matches.length + " of " + files.length + " shown";
    syncNavigationControls(files);
    w.querySelector(".ft-body").innerHTML =
      matches.length > 0
        ? `<ul class="ft-root">${renderTreeDir(treeModel(matches))}</ul>`
        : '<p class="ft-empty">No files match the current search and filters.</p>';
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
  function navigateTreeFile(fr: UiElement): void {
    const sec = activeSection();
    if (!sec) return;
    const el = visibleEvidenceFiles(sec).find((file) =>
      fr.dataset.change
        ? file.dataset.change === fr.dataset.change
        : file.dataset.file === fr.dataset.file,
    );
    if (!el) return;
    const group = el.closest(".group");
    if (group) group.classList.remove("collapsed");
    el.classList.remove("collapsed");
    const item = collectTreeFiles(sec).find(
      (candidate) =>
        candidate.path === el.dataset.file &&
        (!fr.dataset.change || candidate.change === fr.dataset.change),
    );
    const key = item ? firstNavigationLineMatch(item, navigationQuery.text) : undefined;
    const line = key
      ? el.querySelector('.gutter[data-key="' + cssEsc(key) + '"]')?.closest("tr")
      : null;
    if (line) line.scrollIntoView({ block: "center", behavior: "smooth" });
    else scrollFileToTop(el);
  }
  const treeBody = document.querySelector("#fileTree .ft-body");
  treeBody.addEventListener("click", (e) => {
    const target = eventElement(e);
    const dir = target?.closest(".ft-dirrow");
    if (dir) {
      dir.parentElement?.classList.toggle("collapsed");
      return;
    }
    const file = target?.closest(".ft-file");
    if (file) navigateTreeFile(file);
  });
  treeBody.addEventListener("keydown", (e) => {
    if (!(e instanceof KeyboardEvent) || (e.key !== "Enter" && e.key !== " ")) return;
    const target = eventElement(e);
    const dir = target?.closest(".ft-dirrow");
    if (dir) {
      e.preventDefault();
      dir.parentElement?.classList.toggle("collapsed");
      return;
    }
    const file = target?.closest(".ft-file");
    if (file) {
      e.preventDefault();
      navigateTreeFile(file);
    }
  });
  const navigationSearch = document.querySelector("#fileTree [data-nav-search]");
  const refreshTreeSoon = debounce(refreshTree, 120);
  navigationSearch.addEventListener("input", () => {
    navigationQuery.text = navigationSearch.value;
    refreshTreeSoon();
  });
  navigationSearch.addEventListener("keydown", (e) => {
    if (!(e instanceof KeyboardEvent) || (e.key !== "Enter" && e.key !== "ArrowDown")) return;
    refreshTree();
    const first = document.querySelector("#fileTree .ft-file .ft-row");
    if (!first) return;
    e.preventDefault();
    if (e.key === "Enter") first.click();
    else first.focus();
  });
  document.querySelectorAll("#fileTree [data-nav-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.navToggle as "unread" | "openFindings" | "tests" | "generated";
      navigationQuery[key] = !navigationQuery[key];
      refreshTree();
    });
  });
  document.querySelectorAll("#fileTree [data-nav-select]").forEach((select) => {
    select.addEventListener("change", () => {
      const value = select.value || undefined;
      if (select.dataset.navSelect === "severity") navigationQuery.severity = value;
      if (select.dataset.navSelect === "risk") navigationQuery.risk = value;
      if (select.dataset.navSelect === "group") navigationQuery.group = value;
      refreshTree();
    });
  });
  document.querySelector("#fileTree [data-nav-clear]").addEventListener("click", () => {
    navigationQuery.text = "";
    navigationQuery.unread = false;
    navigationQuery.openFindings = false;
    navigationQuery.tests = false;
    navigationQuery.generated = false;
    navigationQuery.severity = undefined;
    navigationQuery.risk = undefined;
    navigationQuery.group = undefined;
    navigationSearch.value = "";
    document.querySelectorAll("#fileTree [data-nav-select]").forEach((select) => {
      select.value = "";
    });
    refreshTree();
    navigationSearch.focus();
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
      renderAll(mode, false);
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

  // ---- theme: system default, manual override persisted across reviews ----
  const THEME_KEY = "htmlreview:theme";
  const themeBtn = document.getElementById("themeBtn");
  const THEMES = [
    { v: null, icon: "◐", label: "system" },
    { v: "light", icon: "☀", label: "light" },
    { v: "dark", icon: "☾", label: "dark" },
  ];
  let ti = 0;
  try {
    const savedTheme = localStorage.getItem(THEME_KEY);
    ti = Math.max(
      0,
      THEMES.findIndex((theme) => theme.v === savedTheme),
    );
  } catch (e) {}
  function applyTheme(): void {
    const t = THEMES[ti];
    if (t.v) document.documentElement.setAttribute("data-theme", t.v);
    else document.documentElement.removeAttribute("data-theme");
    themeBtn.textContent = t.icon;
    themeBtn.title = "Theme: " + t.label;
    themeBtn.setAttribute("aria-label", "Theme: " + t.label + ". Switch theme");
  }
  applyTheme();
  themeBtn.addEventListener("click", () => {
    ti = (ti + 1) % THEMES.length;
    applyTheme();
    try {
      const theme = THEMES[ti].v;
      if (theme) localStorage.setItem(THEME_KEY, theme);
      else localStorage.removeItem(THEME_KEY);
    } catch (e) {}
  });

  // ---- header overflow menu (secondary and destructive actions) ----
  const headerMenu = document.getElementById("headerMenu") as UiElement & { open: boolean };
  document.addEventListener("click", (event) => {
    if (headerMenu?.open && !eventElement(event)?.closest("#headerMenu")) headerMenu.open = false;
  });

  // ---- export ----
  function attachmentMarkdown(id: string, indent = ""): string {
    return attachmentItems(id)
      .map(
        (item, index) =>
          indent + "![Pasted image " + (index + 1) + "](" + attachmentLink(item) + ")",
      )
      .join("\n");
  }
  function fileLanguage(pr: string, file: string): string {
    return DATA.filesFor(pr, file)[0]?.lang || "";
  }
  // The full code of a range comment, read from the embedded diff rows.
  function commentRangeCode(comment: StoredLineComment): { code: string; lang: string } {
    const oldSide = comment.key.startsWith("o");
    const start = parseInt(comment.startLineno || "", 10);
    const end = parseInt(comment.lineno || "", 10);
    let best = new Map<number, string>();
    let lang = "";
    for (const data of DATA.filesFor(comment.pr, comment.file)) {
      const lines = new Map<number, string>();
      for (const hunk of data.hunks) {
        for (const row of hunk.rows) {
          const line = oldSide
            ? row.t !== "a"
              ? row.o
              : undefined
            : row.t !== "d"
              ? row.n
              : undefined;
          if (line != null && line >= start && line <= end) lines.set(line, row.c);
        }
      }
      if (lines.size > best.size) {
        best = lines;
        lang = data.lang;
      }
    }
    if (!best.size) return { code: comment.code || "", lang };
    return {
      code: [...best.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, code]) => code)
        .join("\n"),
      lang,
    };
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
          const s = findingStatus(pr, c) || "open";
          block += markdownListItem(
            "[" +
              s +
              "] " +
              c.file +
              " L" +
              c.line +
              " (" +
              c.severity +
              ", " +
              Math.round(c.confidence * 100) +
              "% confidence) —",
            c.body.trim() + "\n\nRationale: " + c.rationale.trim(),
          );
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
          block += markdownListItem("**File:**", fm.note || "Pasted image");
          if (fileAttachments) block += fileAttachments + "\n";
        }
        fm.lines.sort((a, b) => (parseInt(a.lineno ?? "") || 0) - (parseInt(b.lineno ?? "") || 0));
        for (const c of fm.lines) {
          const lineAttachments = attachmentMarkdown(attachmentId("line", pr, c.file, c.key), "  ");
          const isRange = !!c.startLineno && c.startLineno !== c.lineno;
          block += markdownListItem(
            "**L" + (isRange ? c.startLineno + "–" + c.lineno : c.lineno) + "** —",
            c.text || "Pasted image",
          );
          const quoted = isRange
            ? commentRangeCode(c)
            : { code: (c.code || "").trim(), lang: fileLanguage(c.pr, c.file) };
          if (quoted.code.trim()) block += markdownCodeBlock(quoted.code, quoted.lang);
          if (lineAttachments) block += lineAttachments + "\n";
        }
      }
      const orphans = orphanedComments().filter(([, comment]) => comment.pr === pr);
      if (orphans.length) {
        block += "\n### Orphaned comments\n";
        for (const [, comment] of orphans) {
          block += markdownListItem(
            "**" + comment.file + ":" + (comment.lineno || comment.key) + "** —",
            comment.text || "Pasted image",
          );
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
  // The agent hand-off written by the server: the Markdown export plus the
  // same comments as structured items.
  function buildFeedback(): { markdown: string; items: Array<Record<string, unknown>> } {
    const items: Array<Record<string, unknown>> = [];
    const imagePaths = (id: string): string[] =>
      attachmentItems(id)
        .filter((item) => item.file && session?.attachmentsDir)
        .map((item) => (session?.attachmentsDir + "/" + item.file).replace(/\\/g, "/"));
    const withImages = (item: Record<string, unknown>, id: string): Record<string, unknown> => {
      const attachments = imagePaths(id);
      return attachments.length ? { ...item, attachments } : item;
    };
    const lineNumber = (value: string | undefined): number | undefined => {
      const parsed = parseInt(String(value || "").replace(/^o/, ""), 10);
      return Number.isInteger(parsed) ? parsed : undefined;
    };
    for (const pr of Object.keys(REVIEW)) {
      for (const finding of REVIEW[pr].comments) {
        items.push({
          kind: "finding",
          pr,
          file: finding.file,
          side: finding.key.startsWith("o") ? "old" : "new",
          line: lineNumber(finding.line),
          severity: finding.severity,
          status: findingStatus(pr, finding) || "open",
          text: finding.body,
        });
      }
    }
    for (const pr of new Set([
      ...Object.keys(state.general),
      ...Object.keys(state.attachments)
        .filter((key) => key.startsWith("general\0"))
        .map((key) => key.split("\0")[1]),
    ])) {
      const id = attachmentId("general", pr, "", "");
      if (hasCommentContent(state.general[pr], id)) {
        items.push(withImages({ kind: "general", pr, text: (state.general[pr] || "").trim() }, id));
      }
    }
    for (const comment of Object.values(state.files)) {
      const id = attachmentId("file", comment.pr, comment.file, "");
      if (!comment || !hasCommentContent(comment.text, id)) continue;
      items.push(
        withImages({ kind: "file", pr: comment.pr, file: comment.file, text: comment.text }, id),
      );
    }
    const orphans = new Set(orphanedComments().map(([id]) => id));
    for (const [key, comment] of Object.entries(state.lines)) {
      const id = attachmentId("line", comment.pr, comment.file, comment.key);
      if (!comment || !hasCommentContent(comment.text, id)) continue;
      const isRange = !!comment.startLineno && comment.startLineno !== comment.lineno;
      const code = isRange ? commentRangeCode(comment).code : (comment.code || "").trim();
      items.push(
        withImages(
          {
            kind: orphans.has(key) ? "orphan" : "line",
            pr: comment.pr,
            file: comment.file,
            side: comment.key.startsWith("o") ? "old" : "new",
            line: lineNumber(comment.lineno || comment.key),
            ...(isRange ? { startLine: lineNumber(comment.startLineno) } : {}),
            text: comment.text,
            ...(code ? { code } : {}),
          },
          id,
        ),
      );
    }
    return { markdown: buildMarkdown(), items };
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
        const status = findingStatus(pr, comment) || "open";
        summary += markdownListItem(
          `[${status}] ${comment.file} L${comment.line} —`,
          comment.body.trim(),
        );
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
      openDialog(modal, exportText);
      exportText.select();
    }
  });
  document.getElementById("clearReviewBtn").addEventListener("click", () => {
    if (headerMenu) headerMenu.open = false;
    const confirmed = window.confirm(
      "Clear this review?\n\n" +
        "This removes all comments, pasted images, viewed state, finding decisions, " +
        "and grouping choices stored for this review in this browser. This cannot be undone.",
    );
    if (!confirmed) return;
    if (server && syncer) {
      const client = server;
      void (async () => {
        await syncer.flush();
        const result = await client.clearState(syncer.revision).catch(() => null);
        // An older build of the page reloads itself (onStale) instead.
        if (result && isStaleReview(result.status, result.data)) return;
        if (!result || result.status !== 200) {
          window.alert("The review could not be cleared on the review server. Try again.");
          return;
        }
        syncer.reset(Number(result.data.revision), {});
        try {
          localStorage.removeItem(STORE_KEY);
        } catch {}
        window.location.reload();
      })();
      return;
    }
    try {
      localStorage.removeItem(STORE_KEY);
    } catch (error) {
      window.alert("The review could not be cleared because browser storage is unavailable.");
      return;
    }
    window.location.reload();
  });
  document.getElementById("exportBtn").addEventListener("click", () => {
    exportText.value = buildMarkdown();
    document.getElementById("githubReviewTab").hidden = !GITHUB[activeSection()?.dataset.pr || ""];
    setExportTab("markdown");
    openDialog(modal);
  });
  document.getElementById("closeModal").addEventListener("click", () => closeDialog(modal));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeDialog(modal);
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

  // Served mode publishes through the server, which runs the same publisher
  // (gh authentication and PR head check). The page never sees a token.
  const publishModal = document.getElementById("publishModal");
  const publishEvent = document.getElementById("publishEvent");
  const publishButton = document.getElementById("publishGithubBtn");
  const confirmPublishButton = document.getElementById("confirmPublishBtn");
  const publishResult = document.getElementById("publishResult");
  let pendingPublication: { plan: GithubReviewPlan; event: GithubReviewEvent } | null = null;
  if (server && session?.github) {
    document.getElementById("servePublishControls").hidden = false;
    publishButton.hidden = false;
    document.getElementById("downloadGithubPlanBtn").classList.remove("btn-primary");
    document.querySelector("#githubReviewPanel .publish-command").hidden = true;
    document.querySelector("#githubReviewPanel .hint").textContent =
      "Preview which comments become native threads and which stay in the review summary. Publishing asks for confirmation; the server then rechecks gh authentication and the PR head before writing to GitHub.";
  }
  publishButton?.addEventListener("click", () => {
    const plan = githubDraft(activeReviewTarget());
    if (!plan) return;
    const event = (publishEvent.value || "COMMENT") as GithubReviewEvent;
    pendingPublication = { plan, event };
    document.getElementById("publishPreview").textContent = githubReviewPreview(plan, event);
    publishResult.hidden = true;
    publishResult.classList.remove("error");
    confirmPublishButton.hidden = false;
    confirmPublishButton.removeAttribute("disabled");
    confirmPublishButton.textContent =
      event === "APPROVE"
        ? "Approve on GitHub"
        : event === "REQUEST_CHANGES"
          ? "Request changes on GitHub"
          : "Publish to GitHub";
    openDialog(publishModal, document.getElementById("cancelPublishBtn"));
  });
  confirmPublishButton?.addEventListener("click", async () => {
    if (!server || !pendingPublication) return;
    confirmPublishButton.setAttribute("disabled", "");
    confirmPublishButton.textContent = "Publishing…";
    try {
      const result = await server.publish(pendingPublication.plan, pendingPublication.event);
      publishResult.innerHTML =
        `Published ${result.nativeComments} native thread${result.nativeComments === 1 ? "" : "s"} with ${result.fallbackComments} summary fallback${result.fallbackComments === 1 ? "" : "s"}.` +
        (result.url && /^https:\/\/github\.com\//.test(result.url)
          ? ` <a href="${escAttr(result.url)}" target="_blank" rel="noopener noreferrer">Open the review</a>`
          : "");
      confirmPublishButton.hidden = true;
      pendingPublication = null;
    } catch (error) {
      publishResult.textContent = error instanceof Error ? error.message : String(error);
      publishResult.classList.add("error");
      confirmPublishButton.removeAttribute("disabled");
      confirmPublishButton.textContent = "Try again";
    }
    publishResult.hidden = false;
  });
  const closePublish = (): void => {
    pendingPublication = null;
    closeDialog(publishModal);
  };
  dialogClosers.set(publishModal, closePublish);
  document.getElementById("cancelPublishBtn")?.addEventListener("click", closePublish);
  document.getElementById("closePublishModal")?.addEventListener("click", closePublish);

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
    materializeViews(sec);
    renderAll(mode, false);
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

  // ---- keyboard model ----
  const shortcutsModal = document.getElementById("shortcutsModal");
  document.getElementById("shortcutList").innerHTML = SHORTCUTS.map(
    (shortcut) =>
      `<dt><kbd>${escAttr(shortcut.keys)}</kbd></dt><dd>${escAttr(shortcut.label)}</dd>`,
  ).join("");
  function openShortcuts(): void {
    if (headerMenu) headerMenu.open = false;
    openDialog(shortcutsModal, document.getElementById("closeShortcutsModal"));
  }
  document.getElementById("shortcutsBtn").addEventListener("click", openShortcuts);
  document
    .getElementById("closeShortcutsModal")
    .addEventListener("click", () => closeDialog(shortcutsModal));
  shortcutsModal.addEventListener("click", (event) => {
    if (event.target === shortcutsModal) closeDialog(shortcutsModal);
  });

  function stickyOffset(): number {
    const cs = getComputedStyle(document.documentElement);
    const px = (name: string): number => parseInt(cs.getPropertyValue(name)) || 0;
    return px("--h-app") + px("--h-tabs") + px("--h-diffhead");
  }
  function navigableFiles(): UiElement[] {
    const sec = activeSection();
    return sec ? visibleEvidenceFiles(sec) : [];
  }
  function inViewport(element: UiElement): boolean {
    const rect = element.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > stickyOffset() && rect.top < window.innerHeight;
  }
  // The file j/k/v/c act on: the last one navigated to while it is still on
  // screen, otherwise the first file under the sticky headers.
  function currentFileElement(files = navigableFiles()): UiElement | undefined {
    if (
      currentFile?.isConnected &&
      files.includes(currentFile) &&
      (steppedFile === currentFile || inViewport(currentFile))
    ) {
      return currentFile;
    }
    const offset = stickyOffset();
    return files.find((file) => {
      const rect = file.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > offset + 1;
    });
  }
  function stepFile(step: 1 | -1): void {
    const files = navigableFiles();
    if (!files.length) return;
    const current = currentFileElement(files);
    const index = current ? files.indexOf(current) : -1;
    const next = files[Math.max(0, Math.min(files.length - 1, index + step))];
    if (!next) return;
    const group = next.closest(".group");
    if (group) group.classList.remove("collapsed");
    setCurrentFile(next);
    steppedFile = next;
    scrollFileToTop(next);
    next.querySelector(".file-path")?.focus({ preventScroll: true });
  }
  function commentOnFocusedLine(): void {
    if (activeRange) {
      rangeToolbar.querySelector("[data-range-comment]").click();
      return;
    }
    let gutter = hoveredGutter?.isConnected ? hoveredGutter : null;
    if (gutter && !inViewport(gutter)) gutter = null;
    if (!gutter) {
      const file = currentFileElement();
      if (!file) return;
      file.classList.remove("collapsed");
      ensureRendered(file);
      gutter =
        file.querySelector(".line-add .gutter[data-key], .line-del .gutter[data-key]") ||
        file.querySelector(".gutter[data-key]");
    }
    if (!gutter) return;
    lastGutter = gutter;
    const ta = createCommentRow(gutter, "");
    if (ta) {
      ta.focus({ preventScroll: true });
      ta.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.key === "Escape") return;
    if (openDialogs.length) return;
    const target = eventElement(event);
    const action = shortcutAction({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      targetTag: target?.tagName,
      targetEditable: target?.isContentEditable,
      targetType: target?.getAttribute("type") || "",
    });
    if (!action) return;
    event.preventDefault();
    if (action === "help") openShortcuts();
    else if (action === "next-file") stepFile(1);
    else if (action === "previous-file") stepFile(-1);
    else if (action === "next-finding" || action === "previous-finding") {
      const step = action === "next-finding" ? "1" : "-1";
      document.querySelector(`#progressDock [data-finding-step="${step}"]`)?.click();
    } else if (action === "toggle-viewed") {
      const file = currentFileElement();
      const checkbox = file?.querySelector(".viewed-cb");
      if (!file || !checkbox) return;
      setCurrentFile(file);
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (action === "comment") commentOnFocusedLine();
  });

  // File and group headers: keyboard-operable toggles. The role sits on the
  // path/title rather than the whole header, which also holds checkboxes and
  // buttons (an interactive role may not contain other controls).
  function syncExpanded(container: UiElement): void {
    const toggle = container.matches(".file")
      ? container.querySelector(":scope > .file-header .file-path")
      : container.querySelector(":scope > .group-head .group-title");
    if (toggle)
      toggle.setAttribute("aria-expanded", String(!container.classList.contains("collapsed")));
  }
  function bindHeaderToggle(toggle: UiElement): void {
    const label = toggle.textContent?.trim() || "";
    toggle.setAttribute("role", "button");
    toggle.setAttribute("tabindex", "0");
    if (toggle.matches(".file-path")) {
      toggle.title = label;
      // isolate the path so narrow layouts can truncate it from the left
      toggle.innerHTML = `<bdi>${escAttr(label)}</bdi>`;
    }
    toggle.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle.closest(".file-header, .group-head")?.click();
    });
  }
  // File blocks are wired by initFileElement.
  document.querySelectorAll(".group-head .group-title").forEach(bindHeaderToggle);
  // Startup collapses files restored as viewed before this observer exists.
  document.querySelectorAll(".file, .group").forEach(syncExpanded);
  new MutationObserver((records) => {
    for (const record of records) {
      const element = record.target as UiElement;
      if (element.matches(".file, .group")) syncExpanded(element);
    }
  }).observe(document.getElementById("main"), {
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  document.getElementById("main").addEventListener("focusin", (event) => {
    const file = eventElement(event)?.closest(".file");
    if (file) setCurrentFile(file);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (closeTopDialog()) {
      e.preventDefault();
      return;
    }
    if (headerMenu?.open) {
      headerMenu.open = false;
      headerMenu.querySelector("summary")?.focus();
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

  // ---- served mode: live badge, rebuild events, scroll restore ----
  function startServedMode(client: ReviewServerClient): void {
    document.body.classList.add("served");
    if (serveBadge) {
      serveBadge.hidden = false;
      serveBadge.textContent = "Saved to disk";
      serveBadge.title =
        "Comments are saved by trace-review serve" +
        (session?.feedbackFile ? " · agent feedback: " + session.feedbackFile : "");
    }
    client.listen((message) => {
      if (message.event === "reload") {
        showServeStatus("The review was rebuilt; reloading with your comments…");
        void reloadPreservingScroll();
      } else if (message.event === "rebuilding") {
        showServeStatus("The review result changed; rebuilding…");
      } else if (message.event === "rebuild-error") {
        showServeStatus("Rebuild failed: " + String(message.data.message || ""), "error");
      } else if (
        message.event === "state" &&
        message.data.client !== client.clientId &&
        Number(message.data.revision) > (syncer?.revision ?? 0) &&
        !syncer?.pending
      ) {
        void reloadPreservingScroll();
      }
    });
    window.addEventListener("pagehide", () => syncer?.flushOnUnload());
    let saved: { y?: number; at?: number } = {};
    try {
      saved = JSON.parse(safeSessionStorage()?.getItem(SCROLL_STORAGE_KEY) || "{}") as typeof saved;
      safeSessionStorage()?.removeItem(SCROLL_STORAGE_KEY);
    } catch {}
    if (typeof saved.y === "number" && Date.now() - (saved.at || 0) < 60_000) {
      const y = saved.y;
      requestAnimationFrame(() => window.scrollTo(0, y));
      setTimeout(() => window.scrollTo(0, y), 400);
    }
    if (importedLocalState || restoredUnsaved) save();
  }

  // ---- init ----
  setMode(mode);
  renderFindingList();
  updateCounts();
  renderOrphans();
  if (server) startServedMode(server);
  else if (serveToken && window.location.protocol.startsWith("http")) {
    showServeStatus(
      "The review server did not answer, so comments are kept in this browser only.",
      "error",
    );
  } else if (document.querySelector('meta[name="trace-review-serve"]')) {
    showServeStatus(
      "Open the URL printed by trace-review serve (it carries the access token) to save comments on disk. Until then they stay in this browser.",
      "error",
    );
  }
})();
