// Reviewer state kept on disk for served reviews: one JSON document per
// review with a revision number, pasted images as files, and a Markdown
// feedback file the coding agent can read. Every write is atomic (temporary
// file + rename), so a reader never sees a partial document.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface FeedbackItem {
  kind: "finding" | "general" | "file" | "line" | "orphan";
  pr: string;
  text: string;
  file?: string;
  side?: "old" | "new";
  line?: number;
  startLine?: number;
  code?: string;
  status?: string;
  severity?: string;
  attachments?: string[];
}

export interface FeedbackSnapshot {
  generatedAt: string;
  markdown: string;
  items: FeedbackItem[];
}

export interface StateDocument {
  schemaVersion: 1;
  reviewId: string;
  revision: number;
  updatedAt: string | null;
  state: Record<string, unknown>;
  feedback: FeedbackSnapshot | null;
}

export type WriteResult =
  { ok: true; document: StateDocument } | { ok: false; conflict: StateDocument };

export interface AttachmentUpload {
  name: string;
  type: string;
  /** Base64 image bytes, optionally as a data URL. */
  data: string;
}

export interface AttachmentRef {
  name: string;
  type: string;
  file: string;
}

export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_FEEDBACK_CHARS = 4 * 1024 * 1024;
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
});
const ATTACHMENT_FILE_RE = /^[a-f0-9]{24}\.(?:png|jpg|gif|webp)$/;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A file-system-safe name for a review ID (branch names may contain `/`). */
export function stateFileStem(reviewId: string): string {
  const safe = reviewId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_");
  return (safe || "review").slice(0, 160);
}

export function attachmentContentType(file: string): string | null {
  if (!ATTACHMENT_FILE_RE.test(file)) return null;
  const extension = file.slice(file.lastIndexOf(".") + 1);
  return Object.entries(IMAGE_EXTENSIONS).find(([, value]) => value === extension)?.[0] ?? null;
}

/** Write through a temporary sibling and rename it into place. */
export function atomicWriteFile(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(temporary, data);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temporary, file);
      return;
    } catch (error: unknown) {
      // Windows refuses to replace a file another process has open; retry briefly.
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** Reject anything that is not shaped like reviewer state. */
export function validateStatePayload(value: unknown): string | null {
  if (!isRecord(value)) return "state must be an object";
  for (const key of STATE_MAPS) {
    if (value[key] !== undefined && !isRecord(value[key])) return `state.${key} must be an object`;
  }
  const attachments = isRecord(value.attachments) ? value.attachments : {};
  for (const [id, list] of Object.entries(attachments)) {
    if (!Array.isArray(list)) return `state.attachments[${JSON.stringify(id)}] must be an array`;
    for (const item of list) {
      if (!isRecord(item) || typeof item.file !== "string" || !ATTACHMENT_FILE_RE.test(item.file)) {
        return "attachments must reference uploaded files, not inline data";
      }
    }
  }
  return null;
}

function validateFeedback(value: unknown): FeedbackSnapshot | null {
  if (!isRecord(value) || typeof value.markdown !== "string" || !Array.isArray(value.items)) {
    return null;
  }
  if (value.markdown.length > MAX_FEEDBACK_CHARS) return null;
  const items = value.items.filter(
    (item): item is FeedbackItem =>
      isRecord(item) && typeof item.kind === "string" && typeof item.text === "string",
  );
  return { generatedAt: new Date().toISOString(), markdown: value.markdown, items };
}

export function isStateEmpty(state: Record<string, unknown>): boolean {
  return STATE_MAPS.every((key) => {
    const map = state[key];
    return !isRecord(map) || Object.keys(map).length === 0;
  });
}

export class ReviewStateStore {
  constructor(readonly root: string) {}

  files(reviewId: string): { state: string; feedback: string; attachments: string } {
    const stem = stateFileStem(reviewId);
    return {
      state: path.join(this.root, `${stem}.json`),
      feedback: path.join(this.root, `${stem}.feedback.md`),
      attachments: path.join(this.root, stem, "attachments"),
    };
  }

  read(reviewId: string): StateDocument {
    const empty: StateDocument = {
      schemaVersion: 1,
      reviewId,
      revision: 0,
      updatedAt: null,
      state: {},
      feedback: null,
    };
    let raw: string;
    try {
      raw = fs.readFileSync(this.files(reviewId).state, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<StateDocument>;
    return {
      ...empty,
      revision: Number.isInteger(parsed.revision) ? Number(parsed.revision) : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      state: isRecord(parsed.state) ? parsed.state : {},
      feedback: parsed.feedback && isRecord(parsed.feedback) ? parsed.feedback : null,
    };
  }

  /** Replace the state when `baseRevision` is current; otherwise report the conflict. */
  write(
    reviewId: string,
    input: { baseRevision: number; state: Record<string, unknown>; feedback?: unknown },
  ): WriteResult {
    const current = this.read(reviewId);
    if (input.baseRevision !== current.revision) return { ok: false, conflict: current };
    const feedback =
      input.feedback === undefined ? current.feedback : validateFeedback(input.feedback);
    const document: StateDocument = {
      schemaVersion: 1,
      reviewId,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      state: input.state,
      feedback,
    };
    const files = this.files(reviewId);
    atomicWriteFile(files.state, `${JSON.stringify(document, null, 2)}\n`);
    // Malformed or oversized feedback is dropped; never leave the old file behind.
    if (feedback) atomicWriteFile(files.feedback, feedbackMarkdown(document));
    else fs.rmSync(files.feedback, { force: true });
    return { ok: true, document };
  }

  /** Remove the state, its feedback file, and its images. */
  clear(reviewId: string, baseRevision: number): WriteResult {
    const result = this.write(reviewId, { baseRevision, state: {}, feedback: null });
    if (!result.ok) return result;
    const files = this.files(reviewId);
    fs.rmSync(files.feedback, { force: true });
    fs.rmSync(path.dirname(files.attachments), { recursive: true, force: true });
    return result;
  }

  saveAttachment(reviewId: string, upload: AttachmentUpload): AttachmentRef {
    const extension = IMAGE_EXTENSIONS[upload.type];
    if (!extension) throw new Error("Only PNG, JPEG, GIF, and WebP images can be attached.");
    const base64 = upload.data.replace(/^data:[^;,]+;base64,/, "");
    if (!/^[A-Za-z0-9+/=\s]*$/.test(base64)) throw new Error("The image data is not base64.");
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length) throw new Error("The image is empty.");
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("The image is larger than 2 MB.");
    const file = `${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}.${extension}`;
    const target = path.join(this.files(reviewId).attachments, file);
    if (!fs.existsSync(target)) atomicWriteFile(target, bytes);
    return { name: String(upload.name || "pasted-image").slice(0, 200), type: upload.type, file };
  }

  /** The absolute path of an uploaded image, or null for anything else. */
  attachmentFile(reviewId: string, file: string): string | null {
    if (!ATTACHMENT_FILE_RE.test(file)) return null;
    const target = path.join(this.files(reviewId).attachments, file);
    return fs.existsSync(target) ? target : null;
  }

  /**
   * Carry another review's state into a new review ID (after a rebuild changed
   * the ID). A target that already has state keeps it: the maps are united and
   * the target's entry wins where both have one.
   */
  migrate(fromId: string, toId: string): boolean {
    if (fromId === toId) return false;
    const source = this.read(fromId);
    if (!source.revision || isStateEmpty(source.state)) return false;
    const target = this.read(toId);
    const from = this.files(fromId).attachments;
    if (fs.existsSync(from)) {
      fs.cpSync(from, this.files(toId).attachments, { recursive: true, force: false });
    }
    if (isStateEmpty(target.state)) {
      return this.write(toId, {
        baseRevision: target.revision,
        state: source.state,
        feedback: source.feedback,
      }).ok;
    }
    const state: Record<string, unknown> = { ...source.state, ...target.state };
    for (const key of STATE_MAPS) {
      const left = source.state[key];
      const right = target.state[key];
      if (isRecord(left) || isRecord(right)) {
        state[key] = { ...(isRecord(left) ? left : {}), ...(isRecord(right) ? right : {}) };
      }
    }
    return this.write(toId, {
      baseRevision: target.revision,
      state,
      feedback: target.feedback ?? source.feedback,
    }).ok;
  }
}

export function feedbackMarkdown(document: StateDocument): string {
  const markdown = document.feedback?.markdown.trim();
  return `${markdown || "_No reviewer feedback has been recorded yet._"}\n`;
}

export interface FeedbackReport {
  reviewId: string;
  revision: number;
  updatedAt: string | null;
  stateFile: string;
  feedbackFile: string;
  attachmentsDir: string;
  items: FeedbackItem[];
  markdown: string;
}

export function feedbackReport(store: ReviewStateStore, document: StateDocument): FeedbackReport {
  const files = store.files(document.reviewId);
  return {
    reviewId: document.reviewId,
    revision: document.revision,
    updatedAt: document.updatedAt,
    stateFile: files.state,
    feedbackFile: files.feedback,
    attachmentsDir: files.attachments,
    items: document.feedback?.items ?? [],
    markdown: feedbackMarkdown(document),
  };
}

/**
 * Find a stored review: by review ID, or the most recently updated one.
 * Returns null when the state directory has no matching document.
 */
export function locateStateDocument(
  store: ReviewStateStore,
  reviewId?: string,
): StateDocument | null {
  if (reviewId) {
    const document = store.read(reviewId);
    return document.revision ? document : null;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(store.root, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const file = path.join(store.root, entry.name);
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StateDocument>;
        if (parsed.schemaVersion !== 1 || typeof parsed.reviewId !== "string") return null;
        return { reviewId: parsed.reviewId, mtime: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { reviewId: string; mtime: number } => entry !== null)
    .sort((left, right) => right.mtime - left.mtime);
  return candidates.length ? store.read(candidates[0].reviewId) : null;
}
