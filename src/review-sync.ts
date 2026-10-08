// Served-mode support for the review page. When the page is opened from
// `trace-review serve`, reviewer state lives on disk behind a loopback server
// instead of in localStorage. The page detects the server through the access
// token in the URL fragment (kept in sessionStorage for reloads), so a page
// opened from file:// never touches the network.

export const TOKEN_STORAGE_KEY = "trace-review:serve-token";
export const SCROLL_STORAGE_KEY = "trace-review:serve-scroll";
export const UNSAVED_STORAGE_KEY = "trace-review:serve-unsaved";
const TOKEN_HEADER = "x-trace-review-token";
const CLIENT_HEADER = "x-trace-review-client";
const REVIEW_HEADER = "x-trace-review-id";

export type ReviewStateRecord = Record<string, unknown>;

export interface ServerSession {
  reviewId: string | null;
  revision: number;
  provider: string | null;
  github: boolean;
  attachmentsDir: string | null;
  feedbackFile: string | null;
}

export interface ServerEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface AskJobView {
  id: string;
  status: "pending" | "done" | "error";
  provider: string;
  answer?: string;
  suggestion?: string | null;
  durationMs?: number;
  costUsd?: number;
  error?: string;
}

interface LocationLike {
  protocol: string;
  hash: string;
  pathname: string;
  search: string;
}

/**
 * The served-mode token: taken from `#token=` (then removed from the visible
 * URL) or from this tab's sessionStorage. Never available over file://.
 */
export function readServeToken(
  location: LocationLike,
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  replaceUrl?: (url: string) => void,
): string | null {
  if (location.protocol !== "http:" && location.protocol !== "https:") return null;
  const match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (match) {
    const token = decodeURIComponent(match[1]);
    try {
      storage?.setItem(TOKEN_STORAGE_KEY, token);
    } catch {}
    replaceUrl?.(location.pathname + location.search);
    return token;
  }
  try {
    return storage?.getItem(TOKEN_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/** Split a Server-Sent Events buffer into complete events and the unfinished rest. */
export function parseServerSentEvents(buffer: string): { events: ServerEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, "\n");
  const frames = normalized.split("\n\n");
  const rest = frames.pop() ?? "";
  const events: ServerEvent[] = [];
  for (const frame of frames) {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) continue;
    try {
      const parsed = JSON.parse(data.join("\n")) as unknown;
      events.push({
        event,
        data: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
      });
    } catch {}
  }
  return { events, rest };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Three-way merge of reviewer state maps. Entries the page changed since the
 * last synced `base` win; every other entry comes from the server copy.
 */
export function mergeReviewStates(
  remote: ReviewStateRecord,
  base: ReviewStateRecord,
  local: ReviewStateRecord,
): { merged: ReviewStateRecord; remoteChanged: boolean } {
  const merged: ReviewStateRecord = {};
  let remoteChanged = false;
  const keys = new Set([...Object.keys(remote), ...Object.keys(base), ...Object.keys(local)]);
  for (const key of keys) {
    const remoteMap = remote[key];
    const baseMap = base[key];
    const localMap = local[key];
    if (!isRecord(remoteMap) && !isRecord(baseMap) && !isRecord(localMap)) {
      merged[key] = localMap ?? remoteMap;
      continue;
    }
    const remoteEntries = isRecord(remoteMap) ? remoteMap : {};
    const baseEntries = isRecord(baseMap) ? baseMap : {};
    const localEntries = isRecord(localMap) ? localMap : {};
    const result: Record<string, unknown> = { ...remoteEntries };
    const entryKeys = new Set([
      ...Object.keys(remoteEntries),
      ...Object.keys(baseEntries),
      ...Object.keys(localEntries),
    ]);
    for (const entry of entryKeys) {
      const localJson = JSON.stringify(localEntries[entry]);
      const baseJson = JSON.stringify(baseEntries[entry]);
      const remoteJson = JSON.stringify(remoteEntries[entry]);
      if (localJson !== baseJson) {
        if (entry in localEntries) result[entry] = localEntries[entry];
        else delete result[entry];
      } else if (remoteJson !== localJson) {
        remoteChanged = true;
      }
    }
    merged[key] = result;
  }
  return { merged, remoteChanged };
}

/** The server answered that this page shows an older build of the review. */
export const isStaleReview = (status: number, data: unknown): boolean =>
  status === 409 && isRecord(data) && data.code === "stale-review";

export class ReviewServerClient {
  readonly clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private readonly attachmentUrls = new Map<string, string>();
  /** Called when the server says the page is an older build (it should reload). */
  onStale: (() => void) | null = null;

  /**
   * `reviewId` is the review this page was built for; every call names it so
   * the server never applies this page's state to a newer review.
   */
  constructor(
    readonly token: string,
    readonly reviewId: string | null = null,
    private readonly fetcher: (input: string, init?: RequestInit) => Promise<Response> = (
      input,
      init,
    ) => fetch(input, init),
  ) {}

  private headers(json: boolean): Record<string, string> {
    return {
      [TOKEN_HEADER]: this.token,
      [CLIENT_HEADER]: this.clientId,
      ...(this.reviewId ? { [REVIEW_HEADER]: this.reviewId } : {}),
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init: RequestInit = {},
  ): Promise<{ status: number; data: T }> {
    const response = await this.fetcher(path, {
      ...init,
      method,
      headers: this.headers(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      credentials: "omit",
    });
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {}
    if (isStaleReview(response.status, data)) this.onStale?.();
    return { status: response.status, data: data as T };
  }

  private async expect<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, data } = await this.request<T & { error?: string }>(method, path, body);
    if (status < 200 || status >= 300) {
      throw new Error((data && data.error) || `The review server answered ${status}.`);
    }
    return data;
  }

  session(): Promise<ServerSession> {
    return this.expect<ServerSession>("GET", "/api/session");
  }

  loadState(): Promise<{ revision: number; state: ReviewStateRecord }> {
    return this.expect("GET", "/api/state");
  }

  saveState(
    baseRevision: number,
    state: ReviewStateRecord,
    feedback: unknown,
    keepalive = false,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    return this.request("PUT", "/api/state", { baseRevision, state, feedback }, { keepalive });
  }

  clearState(baseRevision: number): Promise<{ status: number; data: Record<string, unknown> }> {
    return this.request("POST", "/api/state/clear", { baseRevision });
  }

  async uploadAttachment(
    name: string,
    type: string,
    dataUrl: string,
  ): Promise<{ name: string; type: string; file: string }> {
    const saved = await this.expect<{ name: string; type: string; file: string }>(
      "POST",
      "/api/attachments",
      { name, type, data: dataUrl },
    );
    this.attachmentUrls.set(saved.file, dataUrl);
    return saved;
  }

  /** A displayable URL for an uploaded image (cached object URL). */
  cachedAttachmentUrl(file: string): string {
    return this.attachmentUrls.get(file) || "";
  }

  async loadAttachment(file: string): Promise<string> {
    const cached = this.attachmentUrls.get(file);
    if (cached) return cached;
    const response = await this.fetcher("/api/attachments/" + encodeURIComponent(file), {
      headers: this.headers(false),
      cache: "no-store",
      credentials: "omit",
    });
    if (response.status === 409) {
      const data: unknown = await response.json().catch(() => null);
      if (isStaleReview(response.status, data)) this.onStale?.();
    }
    if (!response.ok) return "";
    const url = URL.createObjectURL(await response.blob());
    this.attachmentUrls.set(file, url);
    return url;
  }

  ask(request: unknown): Promise<AskJobView> {
    return this.expect("POST", "/api/ask", request);
  }

  askStatus(id: string): Promise<AskJobView> {
    return this.expect("GET", "/api/ask/" + encodeURIComponent(id));
  }

  publish(
    plan: unknown,
    event: string,
  ): Promise<{ url?: string; nativeComments: number; fallbackComments: number }> {
    return this.expect("POST", "/api/publish", { plan, event, confirm: true });
  }

  /** Follow the server's event stream (fetch-based so the token stays in a header). */
  listen(onEvent: (event: ServerEvent) => void): () => void {
    let stopped = false;
    let controller: AbortController | null = null;
    const connect = async (): Promise<void> => {
      while (!stopped) {
        try {
          controller = new AbortController();
          const response = await this.fetcher("/api/events", {
            headers: this.headers(false),
            cache: "no-store",
            credentials: "omit",
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error(String(response.status));
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const parsed = parseServerSentEvents(buffer);
            buffer = parsed.rest;
            parsed.events.forEach(onEvent);
          }
        } catch {}
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    };
    void connect();
    return () => {
      stopped = true;
      controller?.abort();
    };
  }
}

export interface SyncCallbacks {
  /** The Markdown export and structured comments, computed when a save is sent. */
  feedback(): unknown;
  /** The disk copy of the state (attachments as file references only). */
  snapshot(): ReviewStateRecord;
  /** Replace the page's state maps after a merge. */
  replace(state: ReviewStateRecord): void;
  /** Another writer changed entries this page does not show yet. */
  remoteChanged(): void;
  /**
   * The page is an older build of the review: nothing more is sent. `base` and
   * `local` are the last synced and the unsaved state, to carry over a reload.
   */
  stale(base: ReviewStateRecord, local: ReviewStateRecord): void;
  status(kind: "saving" | "saved" | "error", message?: string): void;
}

/**
 * Debounced, serialized saves with optimistic concurrency: each PUT names the
 * revision it was based on, and a 409 answer is merged and retried.
 */
export class StateSyncer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private again = false;
  private stopped = false;
  private base: ReviewStateRecord;

  constructor(
    private readonly client: ReviewServerClient,
    public revision: number,
    initial: ReviewStateRecord,
    private readonly callbacks: SyncCallbacks,
    private readonly delayMs = 300,
    private readonly retryMs = 3000,
  ) {
    this.base = JSON.parse(JSON.stringify(initial)) as ReviewStateRecord;
  }

  get pending(): boolean {
    return this.inFlight || this.timer !== undefined || this.again;
  }

  schedule(): void {
    if (this.stopped) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.callbacks.status("saving");
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.send();
    }, this.delayMs);
  }

  /** Send now (used before reloads); resolves once the server has answered. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
      await this.send();
    }
    while (this.inFlight) await new Promise((resolve) => setTimeout(resolve, 30));
  }

  /** Best effort on page hide: a keepalive request that outlives the page. */
  flushOnUnload(): void {
    if (this.stopped || this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    void this.client
      .saveState(this.revision, this.callbacks.snapshot(), this.callbacks.feedback(), true)
      .catch(() => {});
  }

  /** Adopt a revision written elsewhere (for example after clearing). */
  reset(revision: number, state: ReviewStateRecord): void {
    this.revision = revision;
    this.base = JSON.parse(JSON.stringify(state)) as ReviewStateRecord;
  }

  private async send(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    this.inFlight = true;
    let remoteChanged = false;
    try {
      let done = false;
      for (let attempt = 0; attempt < 5 && !done; attempt++) {
        const snapshot = this.callbacks.snapshot();
        const { status, data } = await this.client.saveState(
          this.revision,
          snapshot,
          this.callbacks.feedback(),
        );
        if (status === 200) {
          this.revision = Number(data.revision);
          this.base = JSON.parse(JSON.stringify(snapshot)) as ReviewStateRecord;
          this.callbacks.status("saved");
          done = true;
          continue;
        }
        if (isStaleReview(status, data)) {
          // Never merge into another review's state: hand over and stop.
          this.stopped = true;
          this.again = false;
          this.callbacks.stale(this.base, snapshot);
          return;
        }
        if (status === 413) {
          // Retrying cannot shrink the request; the next edit tries again.
          this.callbacks.status(
            "error",
            "Comments could not be saved: they are larger than the review server accepts. Remove some images or long comments.",
          );
          done = true;
          continue;
        }
        if (status === 409 && isRecord(data.state)) {
          const merged = mergeReviewStates(data.state, this.base, snapshot);
          remoteChanged ||= merged.remoteChanged;
          this.callbacks.replace(merged.merged);
          this.base = JSON.parse(JSON.stringify(data.state)) as ReviewStateRecord;
          this.revision = Number(data.revision);
          continue;
        }
        throw new Error(String(data?.error || `The review server answered ${status}.`));
      }
      if (!done) throw new Error("other writers kept changing the comments; retrying.");
    } catch (error) {
      this.callbacks.status(
        "error",
        "Comments could not be saved to the review server: " +
          (error instanceof Error ? error.message : String(error)),
      );
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.send();
      }, this.retryMs);
    } finally {
      this.inFlight = false;
    }
    if (remoteChanged) this.callbacks.remoteChanged();
    if (this.again) {
      this.again = false;
      await this.send();
    }
  }
}
