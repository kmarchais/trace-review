// A small loopback HTTP server for one review. The page and the coding agent
// share reviewer state on disk; the agent's result and spec files are watched
// and every rebuild is pushed to the page as a Server-Sent Event.
//
// Security model: the server only binds a loopback address; every request
// must name that exact host and port (blocking DNS rebinding); every API call
// carries a random per-run token in a header; mutating calls must come from
// the page's own origin and send JSON (blocking cross-site form posts).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  GithubReviewPublicationError,
  GITHUB_REVIEW_EVENTS,
  parseGithubReviewPlan,
  publishGithubReview,
  type GithubPublisher,
  type GithubReviewEvent,
} from "./github-review.mjs";
import { asyncGhRunner, createGhPublisher } from "./github-publisher.mjs";
import {
  attachmentContentType,
  feedbackReport,
  ReviewStateStore,
  validateStatePayload,
} from "./review-state.mjs";
import { parseAskRequest, type AskRunner } from "./serve-ask.mjs";

export const TOKEN_HEADER = "x-trace-review-token";
export const REVIEW_HEADER = "x-trace-review-id";
export const CLIENT_HEADER = "x-trace-review-client";
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const DRAIN_LIMIT_BYTES = 64 * 1024 * 1024;
const LOOPBACK_HOSTS = new Map([
  ["127.0.0.1", "127.0.0.1"],
  ["localhost", "127.0.0.1"],
  ["::1", "::1"],
  ["[::1]", "::1"],
]);

export interface RebuildOutcome {
  /** The rebuilt review page, when it moved or first appeared. */
  htmlPath?: string;
}

export interface WatchOptions {
  files: string[];
  /** Watched files the rebuild rewrites itself; their changes do not trigger a rebuild. */
  outputs?: string[];
  rebuild(changed: string[]): Promise<RebuildOutcome>;
  pollMs?: number;
  debounceMs?: number;
}

export interface ReviewServerOptions {
  reviewDir: string;
  specPath: string;
  htmlPath: string | null;
  ask: AskRunner;
  host?: string;
  port?: number;
  token?: string;
  publisher?: GithubPublisher;
  watch?: WatchOptions;
  log?: (message: string) => void;
}

export interface ReviewServer {
  host: string;
  port: number;
  token: string;
  /** Base URL without the token. */
  url: string;
  /** URL to open: the token travels in the fragment, which is never sent to a server. */
  openUrl: string;
  store: ReviewStateStore;
  broadcast(event: string, data: unknown): void;
  close(): Promise<void>;
}

/** The address to bind, or an error for anything that is not loopback. */
export function loopbackBindAddress(host: string): string {
  const address = LOOPBACK_HOSTS.get(host.trim().toLowerCase());
  if (!address) {
    throw new Error(
      `Refusing to bind '${host}': the review server only listens on 127.0.0.1, localhost, or ::1.`,
    );
  }
  return address;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function sameToken(expected: string, actual: string | string[] | undefined): boolean {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: http.OutgoingHttpHeaders = {},
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(text);
}

const tooLarge = (): HttpError =>
  new HttpError(413, "The request body is too large.", { code: "too-large" });

// An oversized body is answered with 413 and `Connection: close` (see the
// request handler) once the client has finished sending it: the excess is
// read and discarded, because closing the socket while the client is still
// uploading resets the connection and the client never sees the answer.
// Beyond DRAIN_LIMIT_BYTES (or a declared length above it) the answer is sent
// at once.
function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (Number(request.headers["content-length"]) > DRAIN_LIMIT_BYTES) {
      reject(tooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > DRAIN_LIMIT_BYTES) {
        request.off("data", onData);
        reject(tooLarge());
      } else if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
      } else {
        chunks.push(chunk);
      }
    };
    request.on("data", onData);
    request.on("end", () => {
      if (size > MAX_BODY_BYTES) {
        reject(tooLarge());
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") as unknown);
      } catch {
        reject(new HttpError(400, "The request body is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface SpecSummary {
  reviewId: string | null;
  github: Array<{ repository: string; pullRequest: number; headSha: string }>;
}

function readSpec(specPath: string): SpecSummary {
  try {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as {
      reviewId?: unknown;
      prs?: Array<{ github?: { repository: string; pullRequest: number; headSha: string } }>;
    };
    return {
      reviewId: typeof spec.reviewId === "string" && spec.reviewId ? spec.reviewId : null,
      github: (spec.prs || []).flatMap((pr) => (pr.github ? [pr.github] : [])),
    };
  } catch {
    return { reviewId: null, github: [] };
  }
}

/** Polls a few files and reports content changes once they have settled. */
export class FileWatcher {
  private readonly signatures = new Map<string, string>();
  private readonly hashes = new Map<string, string>();
  private readonly pending = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly files: readonly string[],
    private readonly onChange: (changed: string[]) => void,
    private readonly pollMs = 300,
    private readonly debounceMs = 250,
  ) {
    this.refresh();
  }

  private signature(file: string): string {
    try {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  private hash(file: string): string {
    try {
      return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    } catch {
      return "missing";
    }
  }

  /**
   * Accept the current content of `files` as seen (the rebuild's own outputs).
   * Every other file keeps its last reported hash, so a write that landed
   * during a rebuild is still reported once it settles.
   */
  refresh(files: readonly string[] = this.files): void {
    for (const file of files) {
      if (!this.files.includes(file)) continue;
      this.pending.delete(file);
      this.signatures.set(file, this.signature(file));
      this.hashes.set(file, this.hash(file));
    }
  }

  start(): void {
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private poll(): void {
    const now = Date.now();
    const changed: string[] = [];
    for (const file of this.files) {
      const signature = this.signature(file);
      if (signature !== this.signatures.get(file)) {
        this.signatures.set(file, signature);
        this.pending.set(file, now);
        continue;
      }
      const since = this.pending.get(file);
      if (since === undefined || now - since < this.debounceMs) continue;
      this.pending.delete(file);
      const hash = this.hash(file);
      if (hash === "missing" || hash === this.hashes.get(file)) continue;
      this.hashes.set(file, hash);
      changed.push(file);
    }
    if (changed.length) this.onChange(changed);
  }
}

const WAITING_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Waiting for the review</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:15vh auto;max-width:560px;padding:0 20px;color:#1f2328}@media(prefers-color-scheme:dark){body{background:#0d1117;color:#f0f6fc}}code{font-family:ui-monospace,monospace}</style></head>
<body><h1>Waiting for the review result</h1><p>Write <code>.review/lm/result.json</code>; this page reloads as soon as the review is built.</p><p id="status"></p>
<script>(function(){var k="trace-review:serve-token",m=/(?:^#|&)token=([^&]+)/.exec(location.hash);if(m){sessionStorage.setItem(k,decodeURIComponent(m[1]));history.replaceState(null,"",location.pathname)}var t=sessionStorage.getItem(k);if(!t){document.getElementById("status").textContent="Open the URL printed in the terminal.";return}
function listen(){fetch("/api/events",{headers:{"x-trace-review-token":t}}).then(function(r){var d=r.body.getReader(),x=new TextDecoder(),b="";function read(){return d.read().then(function(s){if(s.done)throw 0;b+=x.decode(s.value,{stream:true});if(/event: reload/.test(b))location.reload();var e=/event: rebuild-error\\ndata: (.*)/.exec(b);if(e){try{document.getElementById("status").textContent=JSON.parse(e[1]).message}catch(_){}b=""}return read()})}return read()}).catch(function(){setTimeout(listen,1500)})}listen()})();</script></body></html>`;

// The only external scripts a review page loads: highlight.js (pinned, with
// subresource integrity) and, for diagrams, the Mermaid ES module and its chunks.
const PAGE_SCRIPT_SOURCES = [
  "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/",
  "https://cdn.jsdelivr.net/npm/mermaid@11/",
];

/**
 * The served page's Content-Security-Policy: scripts run only from the two
 * CDN paths above or as the page's own inline scripts, allowed by hash. The
 * page holds the API token, so nothing else may execute in its origin.
 */
export function pageContentSecurityPolicy(html: string): string {
  const hashes = new Set<string>();
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1];
    if (/\ssrc\s*=/i.test(attributes)) continue;
    const type = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1]?.toLowerCase();
    if (type && type !== "module" && !/(?:java|ecma)script/.test(type)) continue;
    // Browsers hash the script text after normalizing line breaks to LF.
    const source = match[2].replace(/\r\n?/g, "\n");
    hashes.add(`'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`);
  }
  return [
    ["script-src", "'self'", ...hashes, ...PAGE_SCRIPT_SOURCES].join(" "),
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Open a URL with the platform handler, without a shell. */
export function openUrlInBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

export async function startReviewServer(options: ReviewServerOptions): Promise<ReviewServer> {
  const bindAddress = loopbackBindAddress(options.host ?? "127.0.0.1");
  const token = options.token ?? randomBytes(32).toString("base64url");
  const store = new ReviewStateStore(path.join(options.reviewDir, "state"));
  const publisher = options.publisher ?? createGhPublisher(asyncGhRunner({ timeoutMs: 120_000 }));
  const log = options.log ?? (() => {});
  let htmlPath = options.htmlPath;
  let currentReviewId = readSpec(options.specPath).reviewId;
  let publishing = false;
  const clients = new Set<http.ServerResponse>();
  let allowedHosts = new Set<string>();
  let allowedOrigins = new Set<string>();

  const broadcast = (event: string, data: unknown): void => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(frame);
  };

  // State belongs to the review the served page was built from. spec.json may
  // already name the next review while its rebuild runs; the switch (and the
  // migration of the comments) happens only once that rebuild has finished.
  const requireReview = (request: http.IncomingMessage): string => {
    const reviewId = currentReviewId ?? readSpec(options.specPath).reviewId;
    if (!reviewId) throw new HttpError(409, "The review has not been built yet.");
    const asked = request.headers[REVIEW_HEADER];
    if (typeof asked === "string" && asked && asked !== reviewId) {
      throw new HttpError(409, "This page shows an older build of the review.", {
        code: "stale-review",
        reviewId,
      });
    }
    return reviewId;
  };

  async function handleApi(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /api/session") {
      const reviewId = currentReviewId ?? readSpec(options.specPath).reviewId;
      const document = reviewId ? store.read(reviewId) : null;
      const files = reviewId ? store.files(reviewId) : null;
      sendJson(response, 200, {
        reviewId,
        revision: document?.revision ?? 0,
        provider: options.ask.providerName,
        github: readSpec(options.specPath).github.length > 0,
        attachmentsDir: files?.attachments ?? null,
        feedbackFile: files?.feedback ?? null,
      });
      return;
    }
    if (route === "GET /api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      response.write(
        `retry: 2000\nevent: hello\ndata: ${JSON.stringify({ reviewId: currentReviewId })}\n\n`,
      );
      clients.add(response);
      const heartbeat = setInterval(() => response.write(": ping\n\n"), 15_000);
      heartbeat.unref();
      request.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(response);
      });
      return;
    }
    if (route === "GET /api/state") {
      sendJson(response, 200, store.read(requireReview(request)));
      return;
    }
    if (route === "PUT /api/state") {
      const reviewId = requireReview(request);
      const body = await readJsonBody(request);
      if (!isRecord(body) || !Number.isInteger(body.baseRevision)) {
        throw new HttpError(400, "baseRevision is required.");
      }
      const invalid = validateStatePayload(body.state);
      if (invalid) throw new HttpError(400, invalid);
      const result = store.write(reviewId, {
        baseRevision: Number(body.baseRevision),
        state: body.state as Record<string, unknown>,
        ...(body.feedback !== undefined ? { feedback: body.feedback } : {}),
      });
      if (!result.ok) {
        sendJson(response, 409, { code: "conflict", ...result.conflict });
        return;
      }
      broadcast("state", {
        reviewId,
        revision: result.document.revision,
        client: String(request.headers[CLIENT_HEADER] || ""),
      });
      sendJson(response, 200, { revision: result.document.revision });
      return;
    }
    if (route === "POST /api/state/clear") {
      const reviewId = requireReview(request);
      const body = await readJsonBody(request);
      if (!isRecord(body) || !Number.isInteger(body.baseRevision)) {
        throw new HttpError(400, "baseRevision is required.");
      }
      const result = store.clear(reviewId, Number(body.baseRevision));
      if (!result.ok) {
        sendJson(response, 409, { code: "conflict", ...result.conflict });
        return;
      }
      broadcast("state", {
        reviewId,
        revision: result.document.revision,
        client: String(request.headers[CLIENT_HEADER] || ""),
      });
      sendJson(response, 200, { revision: result.document.revision });
      return;
    }
    if (route === "POST /api/attachments") {
      const reviewId = requireReview(request);
      const body = await readJsonBody(request);
      if (!isRecord(body) || typeof body.data !== "string" || typeof body.type !== "string") {
        throw new HttpError(400, "An image needs type and base64 data.");
      }
      try {
        const saved = store.saveAttachment(reviewId, {
          name: String(body.name ?? ""),
          type: body.type,
          data: body.data,
        });
        sendJson(response, 201, saved);
      } catch (error: unknown) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/attachments/")) {
      const reviewId = requireReview(request);
      let file: string;
      try {
        file = decodeURIComponent(url.pathname.slice("/api/attachments/".length));
      } catch {
        throw new HttpError(404, "No such attachment.");
      }
      const target = store.attachmentFile(reviewId, file);
      const type = attachmentContentType(file);
      if (!target || !type) throw new HttpError(404, "No such attachment.");
      const bytes = fs.readFileSync(target);
      response.writeHead(200, {
        "Content-Type": type,
        "Content-Length": bytes.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      });
      response.end(bytes);
      return;
    }
    if (route === "GET /api/feedback") {
      const reviewId = requireReview(request);
      sendJson(response, 200, feedbackReport(store, store.read(reviewId)));
      return;
    }
    if (route === "POST /api/ask") {
      requireReview(request);
      const parsed = parseAskRequest(await readJsonBody(request));
      if (typeof parsed === "string") throw new HttpError(400, parsed);
      if (!options.ask.providerName) {
        throw new HttpError(503, "No claude or codex CLI is available for questions.");
      }
      if (options.ask.busy) throw new HttpError(429, "Another request is still running.");
      sendJson(response, 202, options.ask.start(parsed));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/ask/")) {
      const job = options.ask.get(url.pathname.slice("/api/ask/".length));
      if (!job) throw new HttpError(404, "No such request.");
      sendJson(response, 200, job);
      return;
    }
    if (route === "POST /api/publish") {
      requireReview(request);
      const body = await readJsonBody(request);
      if (!isRecord(body) || body.confirm !== true) {
        throw new HttpError(400, "Publishing requires an explicit confirmation.");
      }
      const event = (body.event ?? "COMMENT") as GithubReviewEvent;
      if (!GITHUB_REVIEW_EVENTS.includes(event)) {
        throw new HttpError(400, "event must be COMMENT, APPROVE, or REQUEST_CHANGES.");
      }
      let plan;
      try {
        plan = parseGithubReviewPlan(body.plan);
      } catch (error: unknown) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
      const target = readSpec(options.specPath).github.find(
        (github) =>
          github.repository === plan.target.repository &&
          github.pullRequest === plan.target.pullRequest &&
          github.headSha === plan.target.headSha,
      );
      if (!target) {
        throw new HttpError(400, "The plan does not target the pull request of this review.");
      }
      if (publishing) throw new HttpError(429, "A publication is already running.");
      publishing = true;
      try {
        const result = await publishGithubReview(plan, {
          publisher,
          event,
          confirm: async () => true,
        });
        log(`Published a GitHub review (${event})${result.url ? `: ${result.url}` : ""}`);
        sendJson(response, 200, result);
      } catch (error: unknown) {
        if (error instanceof GithubReviewPublicationError) {
          const status =
            error.code === "stale-head"
              ? 409
              : error.code === "authentication-required"
                ? 403
                : 502;
          throw new HttpError(status, error.message, { code: error.code });
        }
        throw error;
      } finally {
        publishing = false;
      }
      return;
    }
    throw new HttpError(404, "Not found.");
  }

  function servePage(response: http.ServerResponse): void {
    let html = WAITING_PAGE;
    if (htmlPath) {
      try {
        const built = fs.readFileSync(htmlPath, "utf8");
        // The marker lets a page opened without the token explain how to connect.
        if (built.trim()) {
          html = built.replace(/<head>/i, '<head>\n<meta name="trace-review-serve" content="1">');
        }
      } catch {}
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": pageContentSecurityPolicy(html),
      "Referrer-Policy": "no-referrer",
    });
    response.end(html);
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      try {
        const host = String(request.headers.host || "").toLowerCase();
        if (!allowedHosts.has(host)) throw new HttpError(403, "Forbidden host.");
        const url = new URL(request.url || "/", `http://${host}`);
        const method = request.method || "GET";
        if (!url.pathname.startsWith("/api/")) {
          if ((method !== "GET" && method !== "HEAD") || url.pathname !== "/") {
            throw new HttpError(404, "Not found.");
          }
          servePage(response);
          return;
        }
        if (!sameToken(token, request.headers[TOKEN_HEADER])) {
          throw new HttpError(401, "Missing or invalid review token.");
        }
        if (method !== "GET" && method !== "HEAD") {
          const origin = String(request.headers.origin || "");
          if (!allowedOrigins.has(origin)) throw new HttpError(403, "Forbidden origin.");
          const fetchSite = request.headers["sec-fetch-site"];
          if (fetchSite && fetchSite !== "same-origin") {
            throw new HttpError(403, "Cross-site requests are not allowed.");
          }
          if (!/^application\/json\b/i.test(String(request.headers["content-type"] || ""))) {
            throw new HttpError(415, "Requests must send application/json.");
          }
        }
        await handleApi(request, response, url);
      } catch (error: unknown) {
        if (response.headersSent) {
          response.end();
          return;
        }
        if (error instanceof HttpError) {
          // A 413 closes the connection rather than read further requests after it.
          sendJson(
            response,
            error.status,
            { error: error.message, ...error.body },
            error.status === 413 ? { Connection: "close" } : {},
          );
        } else {
          log(`Server error: ${error instanceof Error ? error.message : String(error)}`);
          sendJson(response, 500, { error: "Internal server error." });
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, bindAddress, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const hostLabel = bindAddress === "::1" ? "[::1]" : "127.0.0.1";
  allowedHosts = new Set(
    (bindAddress === "::1" ? ["[::1]", "localhost"] : ["127.0.0.1", "localhost"]).map(
      (name) => `${name}:${port}`,
    ),
  );
  allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));

  let watcher: FileWatcher | undefined;
  if (options.watch) {
    const watch = options.watch;
    const outputs = new Set(watch.outputs ?? []);
    let running = false;
    let queued: string[] = [];
    const rebuild = async (changed: string[]): Promise<void> => {
      if (running) {
        // The rebuild rewriting its own outputs is not a new change.
        queued.push(...changed.filter((file) => !outputs.has(file)));
        return;
      }
      running = true;
      broadcast("rebuilding", { files: changed.map((file) => path.basename(file)) });
      log(`Rebuilding after ${changed.map((file) => path.basename(file)).join(", ")} changed`);
      try {
        const outcome = await watch.rebuild(changed);
        if (outcome.htmlPath) htmlPath = outcome.htmlPath;
        const nextId = readSpec(options.specPath).reviewId;
        if (nextId && currentReviewId && nextId !== currentReviewId) {
          store.migrate(currentReviewId, nextId);
        }
        currentReviewId = nextId ?? currentReviewId;
        broadcast("reload", { reviewId: currentReviewId });
        log("Rebuilt the review; the page reloads with its comments.");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        broadcast("rebuild-error", { message });
        log(`Rebuild failed: ${message}`);
      } finally {
        watcher?.refresh([...outputs]);
        running = false;
        if (queued.length) {
          const next = [...new Set(queued)];
          queued = [];
          void rebuild(next);
        }
      }
    };
    watcher = new FileWatcher(
      watch.files,
      (changed) => void rebuild(changed),
      watch.pollMs,
      watch.debounceMs,
    );
    watcher.start();
  }

  const url = `http://${hostLabel}:${port}/`;
  return {
    host: bindAddress,
    port,
    token,
    url,
    openUrl: `${url}#token=${encodeURIComponent(token)}`,
    store,
    broadcast,
    close: () =>
      new Promise<void>((resolve) => {
        watcher?.stop();
        for (const client of clients) client.end();
        clients.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
