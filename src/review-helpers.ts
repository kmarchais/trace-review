// Pure helpers for the review client. Kept free of DOM access so they can be
// unit-tested with `bun test`.

/** A fence that cannot be closed by any backtick run inside `code`. */
export function markdownFence(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** Indent every non-empty line; blank lines stay empty so Markdown keeps paragraphs. */
export function indentMarkdown(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line ? indent + line : ""))
    .join("\n");
}

/**
 * Render a Markdown list item whose body may span several lines. The first
 * line follows the label; the rest (including ```suggestion blocks) is kept
 * verbatim and indented under the item so it stays part of it.
 */
export function markdownListItem(label: string, body: string, indent = "  "): string {
  const text = body.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
  if (!text) return "- " + label + "\n";
  const [first = "", ...rest] = text.split("\n");
  const startsWithBlock = /^\s*(`{3,}|~{3,})/.test(first);
  if (startsWithBlock) return "- " + label + "\n" + indentMarkdown(text, indent) + "\n";
  return (
    "- " +
    label +
    " " +
    first +
    "\n" +
    (rest.length ? indentMarkdown(rest.join("\n"), indent) + "\n" : "")
  );
}

/** A fenced code block quoting `code`, indented under a list item. */
export function markdownCodeBlock(code: string, lang = "", indent = "  "): string {
  const fence = markdownFence(code);
  return indentMarkdown(fence + lang + "\n" + code + "\n" + fence, indent) + "\n";
}

export interface GapRow {
  t: "a" | "d" | "c";
  o?: number;
  n?: number;
}

export interface HunkGaps {
  /** row index -> number of hidden lines immediately before that row */
  before: Map<number, number>;
  /** hidden lines after the last shown row */
  after: number;
}

const rowIdentity = (row: GapRow): string => `${row.t}:${row.o ?? ""}:${row.n ?? ""}`;

/**
 * Rows hidden from a hunk (for example by a change-group filter) would make
 * line numbers jump silently. With the unfiltered hunk as `original`, every
 * hidden run is located exactly, including at the start and end; without it,
 * holes in the old/new numbering between shown rows give a lower bound, since a
 * hidden context line advances both sides at once.
 */
export function hunkGaps(rows: readonly GapRow[], original?: readonly GapRow[]): HunkGaps {
  if (original?.length) {
    const before = new Map<number, number>();
    let index = 0;
    let hidden = 0;
    for (const row of original) {
      if (index < rows.length && rowIdentity(row) === rowIdentity(rows[index])) {
        if (hidden) before.set(index, hidden);
        hidden = 0;
        index++;
      } else hidden++;
    }
    if (index === rows.length) return { before, after: hidden };
  }
  const before = new Map<number, number>();
  let nextOld: number | undefined;
  let nextNew: number | undefined;
  rows.forEach((row, index) => {
    let skipped = 0;
    if (row.o != null && nextOld != null && row.o > nextOld) skipped = row.o - nextOld;
    if (row.n != null && nextNew != null && row.n > nextNew)
      skipped = Math.max(skipped, row.n - nextNew);
    if (skipped > 0) before.set(index, skipped);
    if (row.o != null) nextOld = row.o + 1;
    if (row.n != null) nextNew = row.n + 1;
  });
  return { before, after: 0 };
}

export type ShortcutAction =
  | "next-file"
  | "previous-file"
  | "next-finding"
  | "previous-finding"
  | "toggle-viewed"
  | "comment"
  | "help";

export interface ShortcutEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  targetTag?: string;
  targetEditable?: boolean;
  targetType?: string;
}

const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/** True when keystrokes in the target should go to the field, not shortcuts. */
export function isTypingTarget(
  tag: string | undefined,
  editable = false,
  type: string | undefined = "",
): boolean {
  const name = (tag || "").toUpperCase();
  if (editable || name === "TEXTAREA" || name === "SELECT") return true;
  return name === "INPUT" && TEXT_INPUT_TYPES.has((type || "").toLowerCase());
}

export const SHORTCUTS: ReadonlyArray<{ keys: string; action: ShortcutAction; label: string }> = [
  { keys: "j", action: "next-file", label: "Next file" },
  { keys: "k", action: "previous-file", label: "Previous file" },
  { keys: "n", action: "next-finding", label: "Next finding" },
  { keys: "p", action: "previous-finding", label: "Previous finding" },
  { keys: "v", action: "toggle-viewed", label: "Toggle viewed on the current file" },
  { keys: "c", action: "comment", label: "Comment on the hovered or selected line" },
  { keys: "?", action: "help", label: "Show keyboard shortcuts" },
];

export function shortcutAction(event: ShortcutEvent): ShortcutAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isTypingTarget(event.targetTag, event.targetEditable, event.targetType)) return null;
  return SHORTCUTS.find((shortcut) => shortcut.keys === event.key)?.action ?? null;
}

export const STATE_VERSION = 2;

export interface StoredState {
  version: number;
  general: Record<string, string>;
  lines: Record<string, Record<string, unknown> & { text: string }>;
  aiState: Record<string, string>;
  aiReply: Record<string, boolean>;
  files: Record<string, Record<string, unknown> & { text: string }>;
  viewed: Record<string, boolean>;
  grouping: Record<string, "grouped" | "raw">;
  attachments: Record<string, StoredAttachment[]>;
  threads: Record<string, Record<string, unknown> & { messages: unknown[] }>;
}

/** A pasted image: inline `data` in the browser, or a server-side `file`. */
export interface StoredAttachment {
  name: string;
  type: string;
  data?: string;
  file?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function pick<T>(value: unknown, accept: (entry: unknown) => entry is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) if (accept(entry)) out[key] = entry;
  return out;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isTrue = (value: unknown): value is boolean => value === true;
const isComment = (value: unknown): value is Record<string, unknown> & { text: string } =>
  isRecord(value) &&
  typeof value.text === "string" &&
  typeof value.pr === "string" &&
  typeof value.file === "string";
const isGrouping = (value: unknown): value is "grouped" | "raw" =>
  value === "grouped" || value === "raw";
const isAttachmentList = (value: unknown): value is StoredAttachment[] =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      isRecord(item) &&
      (typeof item.data === "string" || typeof item.file === "string") &&
      typeof item.name === "string" &&
      typeof item.type === "string",
  );
const isThread = (value: unknown): value is Record<string, unknown> & { messages: unknown[] } =>
  isRecord(value) &&
  typeof value.pr === "string" &&
  typeof value.file === "string" &&
  typeof value.key === "string" &&
  Array.isArray(value.messages);

/**
 * Validate state read from localStorage. Anything malformed is dropped rather
 * than trusted, so a corrupted or foreign entry can never break the page.
 */
export function normalizeStoredState(raw: unknown): StoredState {
  const source = isRecord(raw) ? raw : {};
  const lines = pick(source.lines, isComment) as StoredState["lines"];
  for (const line of Object.values(lines)) {
    if (typeof line.key !== "string") line.key = "";
  }
  return {
    version: STATE_VERSION,
    general: pick(source.general, isString),
    lines,
    aiState: pick(source.aiState, isString),
    aiReply: pick(source.aiReply, isTrue),
    files: pick(source.files, isComment) as StoredState["files"],
    viewed: pick(source.viewed, isTrue),
    grouping: pick(source.grouping, isGrouping),
    attachments: pick(source.attachments, isAttachmentList),
    threads: pick(source.threads, isThread),
  };
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, wait);
  };
}
