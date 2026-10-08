import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCliArgs, UsageError } from "../scripts/lib/cli-args.mjs";
import {
  asyncGhRunner,
  createGhPublisher,
  type GhResult,
} from "../scripts/lib/github-publisher.mjs";
import { ReviewStateStore, stateFileStem } from "../scripts/lib/review-state.mjs";
import {
  AskRunner,
  buildAskPrompt,
  createFakeAskProvider,
  parseAskRequest,
} from "../scripts/lib/serve-ask.mjs";
import {
  loopbackBindAddress,
  startReviewServer,
  type ReviewServer,
  type ReviewServerOptions,
} from "../scripts/lib/serve.mjs";
import {
  mergeReviewStates,
  parseServerSentEvents,
  readServeToken,
  ReviewServerClient,
  StateSyncer,
  type ReviewStateRecord,
  type SyncCallbacks,
} from "../src/review-sync.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "runtime", "scripts", "trace-review.mjs");
const REVIEW_ID = "acme-widgets-pr-42-abc123";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: Record<string, unknown>;
}

function reviewDirectory(t: TestContext, github = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-serve-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, "spec.json"),
    JSON.stringify({
      schemaVersion: 1,
      reviewId: REVIEW_ID,
      prs: [
        {
          id: "pr-42",
          ...(github
            ? { github: { repository: "acme/widgets", pullRequest: 42, headSha: "abc123" } }
            : {}),
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "review.html"),
    "<!doctype html><html><head></head><body>Review</body></html>",
  );
  return dir;
}

async function serve(
  t: TestContext,
  dir: string,
  overrides: Partial<ReviewServerOptions> = {},
): Promise<ReviewServer> {
  const server = await startReviewServer({
    reviewDir: dir,
    specPath: path.join(dir, "spec.json"),
    htmlPath: path.join(dir, "review.html"),
    ask: new AskRunner({
      provider: createFakeAskProvider(20),
      repo: dir,
      workDir: path.join(dir, "state", "ask"),
      timeoutMs: 5_000,
    }),
    token: "test-token",
    ...overrides,
  });
  t.after(() => server.close());
  return server;
}

function call(
  server: ReviewServer,
  options: {
    method?: string;
    path?: string;
    body?: unknown;
    headers?: Record<string, string | undefined>;
  } = {},
): Promise<Reply> {
  const origin = `http://127.0.0.1:${server.port}`;
  const method = options.method ?? "GET";
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    host: `127.0.0.1:${server.port}`,
    "x-trace-review-token": server.token,
    ...(method !== "GET" ? { origin, "content-type": "application/json" } : {}),
  };
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[key];
    else headers[key] = value;
  }
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port: server.port, method, path: options.path ?? "/", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {}
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json });
        });
      },
    );
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test("the server only binds loopback addresses", () => {
  assert.equal(loopbackBindAddress("127.0.0.1"), "127.0.0.1");
  assert.equal(loopbackBindAddress("localhost"), "127.0.0.1");
  assert.equal(loopbackBindAddress("::1"), "::1");
  for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
    assert.throws(() => loopbackBindAddress(host), /only listens on/);
  }
});

test("requests with a wrong host, origin, token, or content type are rejected", async (t) => {
  const server = await serve(t, reviewDirectory(t));
  const state = { baseRevision: 0, state: {} };

  const page = await call(server);
  assert.equal(page.status, 200);
  assert.match(page.text, /<meta name="trace-review-serve" content="1">/);
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal((await call(server, { headers: { host: "localhost:" + server.port } })).status, 200);

  const rebound = await call(server, { path: "/api/session", headers: { host: "evil.example" } });
  assert.equal(rebound.status, 403);
  assert.equal(
    (await call(server, { headers: { host: "evil.example:" + server.port } })).status,
    403,
  );

  const missing = await call(server, {
    path: "/api/session",
    headers: { "x-trace-review-token": undefined },
  });
  assert.equal(missing.status, 401);
  const wrong = await call(server, {
    path: "/api/state",
    headers: { "x-trace-review-token": "nope" },
  });
  assert.equal(wrong.status, 401);

  const foreign = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: state,
    headers: { origin: "https://evil.example" },
  });
  assert.equal(foreign.status, 403);
  const noOrigin = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: state,
    headers: { origin: undefined },
  });
  assert.equal(noOrigin.status, 403);
  const crossSite = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: state,
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossSite.status, 403);
  const form = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: state,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(form.status, 415);
  const text = await call(server, {
    method: "POST",
    path: "/api/ask",
    body: {},
    headers: { "content-type": "text/plain" },
  });
  assert.equal(text.status, 415);

  const session = await call(server, { path: "/api/session" });
  assert.equal(session.status, 200);
  assert.equal(session.json.reviewId, REVIEW_ID);
  assert.equal(session.json.provider, "fake");
});

test("state round-trips with revisions and conflicts answer 409", async (t) => {
  const dir = reviewDirectory(t);
  const server = await serve(t, dir);
  const initial = await call(server, { path: "/api/state" });
  assert.equal(initial.json.revision, 0);

  const first = {
    general: { "pr-42": "Looks good overall." },
    lines: {
      "pr-42\0src/a.ts\x0012": { pr: "pr-42", file: "src/a.ts", key: "12", text: "Rename this." },
    },
  };
  const saved = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: {
      baseRevision: 0,
      state: first,
      feedback: { markdown: "# Review\n\n- **L12** — Rename this.", items: [] },
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.revision, 1);
  const loaded = await call(server, { path: "/api/state" });
  assert.deepEqual(loaded.json.state, first);
  assert.equal(loaded.json.revision, 1);

  const stale = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: { baseRevision: 0, state: { general: { "pr-42": "Overwrite" } } },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.revision, 1);
  assert.deepEqual(stale.json.state, first);

  const files = new ReviewStateStore(path.join(dir, "state")).files(REVIEW_ID);
  const document = JSON.parse(fs.readFileSync(files.state, "utf8"));
  assert.equal(document.revision, 1);
  assert.match(fs.readFileSync(files.feedback, "utf8"), /Rename this/);
  assert.deepEqual(
    fs.readdirSync(path.dirname(files.state)).filter((name) => name.endsWith(".tmp")),
    [],
    "atomic writes leave no temporary files",
  );
  const feedback = await call(server, { path: "/api/feedback" });
  assert.equal(feedback.json.revision, 1);
  assert.match(String(feedback.json.markdown), /Rename this/);

  const cleared = await call(server, {
    method: "POST",
    path: "/api/state/clear",
    body: { baseRevision: 1 },
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual((await call(server, { path: "/api/state" })).json.state, {});
});

test("pasted images are stored as files, never inline in the state", async (t) => {
  const dir = reviewDirectory(t);
  const server = await serve(t, dir);
  const uploaded = await call(server, {
    method: "POST",
    path: "/api/attachments",
    body: {
      name: "shot.png",
      type: "image/png",
      data: `data:image/png;base64,${PNG.toString("base64")}`,
    },
  });
  assert.equal(uploaded.status, 201);
  const file = String(uploaded.json.file);
  assert.match(file, /^[a-f0-9]{24}\.png$/);
  const stored = path.join(dir, "state", stateFileStem(REVIEW_ID), "attachments", file);
  assert.deepEqual(fs.readFileSync(stored), PNG);

  const image = await call(server, { path: `/api/attachments/${file}` });
  assert.equal(image.status, 200);
  assert.equal(image.headers["content-type"], "image/png");
  assert.equal((await call(server, { path: "/api/attachments/..%2Fspec.json" })).status, 404);

  const svg = await call(server, {
    method: "POST",
    path: "/api/attachments",
    body: { name: "x.svg", type: "image/svg+xml", data: "PHN2Zy8+" },
  });
  assert.equal(svg.status, 400);

  const inline = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: {
      baseRevision: 0,
      state: {
        attachments: { a: [{ name: "x", type: "image/png", data: "data:image/png;base64,AA" }] },
      },
    },
  });
  assert.equal(inline.status, 400);
  const referenced = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: {
      baseRevision: 0,
      state: { attachments: { a: [{ name: "x", type: "image/png", file }] } },
    },
  });
  assert.equal(referenced.status, 200);
  const raw = fs.readFileSync(path.join(dir, "state", `${stateFileStem(REVIEW_ID)}.json`), "utf8");
  assert.doesNotMatch(raw, /base64/);
});

test("feedback prints the reviewer comments for the agent", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-feedback-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ReviewStateStore(path.join(dir, "state"));
  store.write("older-review", {
    baseRevision: 0,
    state: { general: { local: "old" } },
    feedback: { markdown: "# Older review", items: [] },
  });
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(store.files("older-review").state, new Date(0), new Date(0));
  store.write(REVIEW_ID, {
    baseRevision: 0,
    state: { general: { "pr-42": "Ship it after the rename." } },
    feedback: {
      markdown: "# Review: widgets\n\n**My overall:** Ship it after the rename.",
      items: [{ kind: "general", pr: "pr-42", text: "Ship it after the rename." }],
    },
  });
  fs.utimesSync(store.files(REVIEW_ID).state, later, later);

  const latest = spawnSync(process.execPath, [cli, "feedback", "--latest", "--dir", dir], {
    encoding: "utf8",
  });
  assert.equal(latest.status, 0, latest.stderr);
  assert.match(latest.stdout, new RegExp(`Review ${REVIEW_ID} · revision 1`));
  assert.match(latest.stdout, /\*\*My overall:\*\* Ship it after the rename\./);

  const json = spawnSync(process.execPath, [cli, "feedback", REVIEW_ID, "--json", "--dir", dir], {
    encoding: "utf8",
  });
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.reviewId, REVIEW_ID);
  assert.deepEqual(report.items, [
    { kind: "general", pr: "pr-42", text: "Ship it after the rename." },
  ]);

  const older = spawnSync(process.execPath, [cli, "feedback", "older-review", "--dir", dir], {
    encoding: "utf8",
  });
  assert.match(older.stdout, /# Older review/);
  const missing = spawnSync(process.execPath, [cli, "feedback", "--dir", path.join(dir, "none")], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /No served review state/);
});

function nextEvent(server: ReviewServer, name: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${name} event`)), 10_000);
    const request = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: "/api/events",
        headers: { host: `127.0.0.1:${server.port}`, "x-trace-review-token": server.token },
      },
      (response) => {
        let buffer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          const parsed = parseServerSentEvents(buffer);
          buffer = parsed.rest;
          const event = parsed.events.find((candidate) => candidate.event === name);
          if (event) {
            clearTimeout(timer);
            request.destroy();
            resolve(event.data);
          }
        });
      },
    );
    request.on("error", () => {});
    request.end();
  });
}

test("a rewritten result file rebuilds the page and sends a reload event", async (t) => {
  const dir = reviewDirectory(t);
  const result = path.join(dir, "lm", "result.json");
  fs.mkdirSync(path.dirname(result), { recursive: true });
  fs.writeFileSync(result, '{"summary":"first"}');
  const rebuilt: string[][] = [];
  const server = await serve(t, dir, {
    watch: {
      files: [result, path.join(dir, "spec.json")],
      pollMs: 25,
      debounceMs: 50,
      async rebuild(changed) {
        rebuilt.push(changed.map((file) => path.basename(file)));
        fs.writeFileSync(
          path.join(dir, "review.html"),
          "<html><head></head><body>Rebuilt</body></html>",
        );
        return {};
      },
    },
  });
  const reload = nextEvent(server, "reload");
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.writeFileSync(result, '{"summary":"second"}');
  assert.deepEqual(await reload, { reviewId: REVIEW_ID });
  assert.deepEqual(rebuilt, [["result.json"]]);
  assert.match((await call(server)).text, /Rebuilt/);

  // Touching a file without changing it does not rebuild.
  const now = new Date();
  fs.utimesSync(result, now, now);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(rebuilt.length, 1);
});

test("ask runs one provider request at a time and returns the answer", async (t) => {
  const dir = reviewDirectory(t);
  const server = await serve(t, dir);
  const body = {
    action: "fix",
    question: "",
    file: "src/a.ts",
    side: "new",
    rows: [
      { line: "11", kind: "ctx", code: "const a = 1;" },
      { line: "12", kind: "add", code: "const b = a + 1;" },
    ],
  };
  const started = await call(server, { method: "POST", path: "/api/ask", body });
  assert.equal(started.status, 202);
  const busy = await call(server, { method: "POST", path: "/api/ask", body });
  assert.equal(busy.status, 429);

  let job = started.json;
  for (let attempt = 0; job.status === "pending" && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    job = (await call(server, { path: `/api/ask/${String(started.json.id)}` })).json;
  }
  assert.equal(job.status, "done");
  assert.equal(job.provider, "fake");
  assert.equal(job.suggestion, "const a = 1; // reviewed\nconst b = a + 1; // reviewed");

  const invalid = await call(server, {
    method: "POST",
    path: "/api/ask",
    body: { ...body, action: "ask", question: " " },
  });
  assert.equal(invalid.status, 400);

  const offline = await serve(t, dir, {
    token: "other",
    ask: new AskRunner({ provider: null, repo: dir, workDir: dir, timeoutMs: 1_000 }),
  });
  const unavailable = await call(offline, { method: "POST", path: "/api/ask", body });
  assert.equal(unavailable.status, 503);
});

test("ask prompts carry the file, numbered rows, finding, and question", () => {
  const request = parseAskRequest({
    action: "ask",
    question: "Can this overflow?",
    file: "src/a.ts",
    side: "new",
    rows: [{ line: "12", kind: "add", code: "total += price * quantity;" }],
    finding: { severity: "concern", body: "Overflow risk.", rationale: "Unbounded." },
  });
  assert.equal(typeof request, "object");
  const prompt = buildAskPrompt(request as Exclude<typeof request, string>);
  assert.match(prompt, /File: src\/a\.ts \(new side\)/);
  assert.ok(prompt.includes("   12 |+total += price * quantity;"));
  assert.match(prompt, /Finding \(concern\): Overflow risk\./);
  assert.match(prompt, /Reviewer question: Can this overflow\?/);
  assert.match(prompt, /must not modify anything/);
  assert.equal(
    parseAskRequest({ action: "delete", file: "a", rows: [{}] }),
    "action must be ask, explain, or fix.",
  );
});

test("publishing goes through gh after an explicit confirmation", async (t) => {
  const dir = reviewDirectory(t, true);
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  let head = "abc123";
  const run = (args: readonly string[], input?: string): GhResult => {
    calls.push({ args, ...(input !== undefined ? { input } : {}) });
    if (args[0] === "auth") return { status: 0, stdout: "", stderr: "" };
    if (args.includes("POST")) {
      return {
        status: 0,
        stdout: "https://github.com/acme/widgets/pull/42#pullrequestreview-7\n",
        stderr: "",
      };
    }
    return { status: 0, stdout: `${head}\n`, stderr: "" };
  };
  const server = await serve(t, dir, { publisher: createGhPublisher(run) });
  const plan = {
    schemaVersion: 1,
    target: {
      repository: "acme/widgets",
      pullRequest: 42,
      headSha: "abc123",
      url: "https://github.com/acme/widgets/pull/42",
    },
    summary: "Approved with one note.",
    nativeComments: [{ path: "src/a.ts", body: "Nice.", side: "RIGHT", line: 3 }],
    fallbackComments: [],
  };

  const unconfirmed = await call(server, { method: "POST", path: "/api/publish", body: { plan } });
  assert.equal(unconfirmed.status, 400);
  const elsewhere = await call(server, {
    method: "POST",
    path: "/api/publish",
    body: { plan: { ...plan, target: { ...plan.target, pullRequest: 7 } }, confirm: true },
  });
  assert.equal(elsewhere.status, 400);
  assert.equal(calls.length, 0, "nothing reaches gh before the checks pass");

  const published = await call(server, {
    method: "POST",
    path: "/api/publish",
    body: { plan, event: "APPROVE", confirm: true },
  });
  assert.equal(published.status, 200, published.text);
  assert.equal(published.json.url, "https://github.com/acme/widgets/pull/42#pullrequestreview-7");
  const post = calls.find((entry) => entry.args.includes("POST"));
  const request = JSON.parse(post?.input || "{}");
  assert.equal(request.event, "APPROVE");
  assert.equal(request.commit_id, "abc123");
  assert.equal(request.comments[0].path, "src/a.ts");
  assert.doesNotMatch(published.text, /token/i);

  head = "def456";
  const stale = await call(server, {
    method: "POST",
    path: "/api/publish",
    body: { plan, event: "COMMENT", confirm: true },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "stale-head");
});

test("served pages merge concurrent edits and detect the server only over http", () => {
  const base = { lines: { a: { text: "one" } }, viewed: {} };
  const remote = { lines: { a: { text: "one" }, b: { text: "from another tab" } }, viewed: {} };
  const local = { lines: { a: { text: "edited here" } }, viewed: { f: true } };
  const { merged, remoteChanged } = mergeReviewStates(remote, base, local);
  assert.deepEqual(merged, {
    lines: { a: { text: "edited here" }, b: { text: "from another tab" } },
    viewed: { f: true },
  });
  assert.equal(remoteChanged, true);
  const deleted = mergeReviewStates(remote, remote, { lines: { a: { text: "one" } }, viewed: {} });
  assert.deepEqual(deleted.merged.lines, { a: { text: "one" } });

  const { events, rest } = parseServerSentEvents(
    'retry: 2000\nevent: hello\ndata: {"reviewId":"x"}\n\n: ping\n\nevent: reload\ndata: {"reviewId":"y"}\n\nevent: par',
  );
  assert.deepEqual(events, [
    { event: "hello", data: { reviewId: "x" } },
    { event: "reload", data: { reviewId: "y" } },
  ]);
  assert.equal(rest, "event: par");

  const storage = new Map<string, string>();
  const sessionStore = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  };
  const page = { pathname: "/", search: "", hash: "" };
  assert.equal(
    readServeToken({ ...page, protocol: "file:", hash: "#token=x" }, sessionStore),
    null,
  );
  let replaced = "";
  assert.equal(
    readServeToken({ ...page, protocol: "http:", hash: "#token=abc%2B1" }, sessionStore, (url) => {
      replaced = url;
    }),
    "abc+1",
  );
  assert.equal(replaced, "/");
  assert.equal(readServeToken({ ...page, protocol: "http:" }, sessionStore), "abc+1");
});

test("serve and feedback parse like the review command", () => {
  const serveArgs = parseCliArgs(["serve", "main..feature", "--lm", "--port", "8123"], "/repo");
  assert.equal(serveArgs.command, "review");
  assert.equal(serveArgs.serve, true);
  assert.equal(serveArgs.port, 8123);
  assert.deepEqual(serveArgs.revisions, ["main..feature"]);
  assert.equal(serveArgs.mode, "lm-analysis");
  assert.equal(parseCliArgs(["pr", "42", "--serve"], "/repo").serve, true);
  assert.equal(parseCliArgs([], "/repo").serve, false);

  const latest = parseCliArgs(["feedback", "--latest", "--json"], "/repo");
  assert.equal(latest.command, "feedback");
  assert.equal(latest.reviewId, undefined);
  assert.equal(latest.json, true);
  assert.equal(parseCliArgs(["feedback", "abc"], "/repo").reviewId, "abc");
  assert.throws(() => parseCliArgs(["feedback", "abc", "--latest"], "/repo"), UsageError);
  assert.throws(() => parseCliArgs(["serve", "--port", "70000"], "/repo"), UsageError);
  assert.throws(() => parseCliArgs(["finish", "--serve"], "/repo"), UsageError);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(20);
  }
}

test("comments saved while a rebuild switches the review ID are carried over", async (t) => {
  const dir = reviewDirectory(t);
  const spec = path.join(dir, "spec.json");
  let release = (): void => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let rebuilding = false;
  const server = await serve(t, dir, {
    watch: {
      files: [spec],
      outputs: [spec],
      pollMs: 25,
      debounceMs: 50,
      async rebuild() {
        rebuilding = true;
        await released;
        return {};
      },
    },
  });
  const asPage = { "x-trace-review-id": REVIEW_ID };
  const earlier = { general: { "pr-42": "Earlier comment." } };
  const first = await call(server, {
    method: "PUT",
    path: "/api/state",
    headers: asPage,
    body: { baseRevision: 0, state: earlier },
  });
  assert.equal(first.status, 200, first.text);

  const nextId = "acme-widgets-pr-42-def456";
  const specJson = JSON.parse(fs.readFileSync(spec, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(spec, JSON.stringify({ ...specJson, reviewId: nextId }));
  await waitFor(() => rebuilding);

  // spec.json already names the next review, but the page still shows (and
  // saves to) the review it was built from until the rebuild finishes.
  const edited = { ...earlier, lines: { a: { text: "New edit." } } };
  const during = await call(server, {
    method: "PUT",
    path: "/api/state",
    headers: asPage,
    body: { baseRevision: 1, state: edited },
  });
  assert.equal(during.status, 200, during.text);
  assert.equal(during.json.revision, 2);

  const reload = nextEvent(server, "reload");
  await sleep(150);
  release();
  assert.deepEqual(await reload, { reviewId: nextId });
  const asNext = { "x-trace-review-id": nextId };
  assert.deepEqual(
    (await call(server, { path: "/api/state", headers: asNext })).json.state,
    edited,
  );

  // A page still showing the old build is told to reload, never merged.
  const stale = await call(server, {
    method: "PUT",
    path: "/api/state",
    headers: asPage,
    body: { baseRevision: 2, state: {} },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "stale-review");
  assert.equal(stale.json.reviewId, nextId);
  assert.deepEqual(
    (await call(server, { path: "/api/state", headers: asNext })).json.state,
    edited,
  );
});

test("migrating into a review that already has state unites both", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-migrate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ReviewStateStore(path.join(dir, "state"));
  store.write("old", {
    baseRevision: 0,
    state: { general: { x: "old x", y: "old y" }, lines: { l1: { text: "line" } } },
  });
  store.write("new", { baseRevision: 0, state: { general: { y: "new y" } } });
  assert.equal(store.migrate("old", "new"), true);
  const merged = store.read("new");
  assert.equal(merged.revision, 2);
  assert.deepEqual(merged.state, {
    general: { x: "old x", y: "new y" },
    lines: { l1: { text: "line" } },
  });

  // A cleared target (revision > 0, no entries) still receives the comments.
  store.clear("new", 2);
  assert.equal(store.migrate("old", "new"), true);
  assert.deepEqual(store.read("new").state, store.read("old").state);
  assert.equal(store.migrate("empty", "new"), false);
});

test("a result written while a rebuild runs triggers another rebuild", async (t) => {
  const dir = reviewDirectory(t);
  const result = path.join(dir, "lm", "result.json");
  const spec = path.join(dir, "spec.json");
  fs.mkdirSync(path.dirname(result), { recursive: true });
  fs.writeFileSync(result, '{"summary":"first"}');
  const rebuilt: string[][] = [];
  await serve(t, dir, {
    watch: {
      files: [result, spec],
      outputs: [spec],
      pollMs: 25,
      debounceMs: 50,
      async rebuild(changed) {
        rebuilt.push(changed.map((file) => path.basename(file)));
        if (rebuilt.length === 1) {
          // The rebuild rewrites spec.json itself; the agent writes a newer result meanwhile.
          fs.appendFileSync(spec, "\n");
          fs.writeFileSync(result, '{"summary":"third"}');
        }
        return {};
      },
    },
  });
  await sleep(150);
  fs.writeFileSync(result, '{"summary":"second"}');
  await waitFor(() => rebuilt.length >= 2);
  await sleep(300);
  assert.deepEqual(rebuilt, [["result.json"], ["result.json"]]);
});

test(
  "an oversized body is answered with 413 and the connection closed",
  { timeout: 30_000 },
  async (t) => {
    const server = await serve(t, reviewDirectory(t));
    const streamed = await call(server, {
      method: "PUT",
      path: "/api/state",
      body: "x".repeat(12 * 1024 * 1024 + 1),
    });
    assert.equal(streamed.status, 413);
    assert.equal(streamed.headers.connection, "close");
    assert.equal(streamed.json.code, "too-large");
    assert.equal((await call(server, { path: "/api/session" })).status, 200);

    // Under Node (the runtime the server ships for), closing the socket while
    // the client still uploads resets the connection; the client must get the 413.
    const script = `
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const { startReviewServer } = await import(pathToFileURL(process.argv[1]).href);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-413-"));
    fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify({ reviewId: "r" }));
    const server = await startReviewServer({
      reviewDir: dir, specPath: path.join(dir, "spec.json"), htmlPath: null,
      ask: { providerName: null }, token: "t",
    });
    const origin = "http://127.0.0.1:" + server.port;
    const outcome = await fetch(origin + "/api/state", {
      method: "PUT",
      headers: { "x-trace-review-token": "t", origin, "content-type": "application/json" },
      body: "x".repeat(12 * 1024 * 1024 + 1),
    }).then((response) => String(response.status), (error) => "error " + error.cause?.code);
    console.log(outcome);
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  `;
    const node = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(
          "node",
          [
            "--input-type=module",
            "-e",
            script,
            path.join(root, "dist", "runtime", "scripts", "lib", "serve.mjs"),
          ],
          { windowsHide: true },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      },
    );
    assert.equal(node.status, 0, node.stderr);
    assert.equal(node.stdout.trim(), "413");
  },
);

test("a malformed escape in an attachment path is a 404, not a server error", async (t) => {
  const server = await serve(t, reviewDirectory(t));
  assert.equal((await call(server, { path: "/api/attachments/%E0%A4%A" })).status, 404);
  assert.equal((await call(server, { path: "/api/attachments/%zz.png" })).status, 404);
});

test("feedback the store rejects removes the previous feedback file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-feedback-file-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ReviewStateStore(path.join(dir, "state"));
  const state = { general: { "pr-42": "Note." } };
  store.write(REVIEW_ID, {
    baseRevision: 0,
    state,
    feedback: { markdown: "# Old feedback", items: [] },
  });
  const feedbackFile = store.files(REVIEW_ID).feedback;
  assert.match(fs.readFileSync(feedbackFile, "utf8"), /Old feedback/);
  store.write(REVIEW_ID, { baseRevision: 1, state, feedback: { markdown: 42 } });
  assert.equal(fs.existsSync(feedbackFile), false);
  assert.equal(store.read(REVIEW_ID).feedback, null);

  store.write(REVIEW_ID, { baseRevision: 2, state, feedback: { markdown: "# Again", items: [] } });
  assert.equal(fs.existsSync(feedbackFile), true);
  store.write(REVIEW_ID, {
    baseRevision: 3,
    state,
    feedback: { markdown: "x".repeat(4 * 1024 * 1024 + 1), items: [] },
  });
  assert.equal(fs.existsSync(feedbackFile), false);
});

test("the async gh runner does not block and kills gh after its timeout", async () => {
  const echo = asyncGhRunner({
    command: process.execPath,
    prefixArgs: ["-e", "process.stdin.pipe(process.stdout)"],
  });
  assert.deepEqual(await echo(["ignored"], "hello"), { status: 0, stdout: "hello", stderr: "" });

  const hang = asyncGhRunner({
    command: process.execPath,
    prefixArgs: ["-e", "setTimeout(() => {}, 30000)"],
    timeoutMs: 300,
  });
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 20);
  const started = Date.now();
  const result = await hang([]);
  clearInterval(ticker);
  assert.match(String(result.error?.message), /did not finish within/);
  assert.ok(Date.now() - started < 10_000);
  assert.ok(ticks > 3, "the event loop kept running while gh ran");

  const missing = await asyncGhRunner({ command: "trace-review-no-such-gh" })(["auth"]);
  assert.ok(missing.error);
});

function fakeServer(
  replies: Array<{ status: number; body: unknown }>,
  seen: Array<Record<string, string>> = [],
): ReviewServerClient {
  return new ReviewServerClient("token", REVIEW_ID, async (_input, init) => {
    seen.push({ ...(init?.headers as Record<string, string>) });
    const reply = replies.length > 1 ? replies.shift() : replies[0];
    return new Response(JSON.stringify(reply?.body ?? {}), { status: reply?.status ?? 500 });
  });
}

function recordingCallbacks(local: ReviewStateRecord): SyncCallbacks & {
  statuses: string[];
  replaced: ReviewStateRecord[];
  staleWith: Array<{ base: ReviewStateRecord; local: ReviewStateRecord }>;
} {
  const statuses: string[] = [];
  const replaced: ReviewStateRecord[] = [];
  const staleWith: Array<{ base: ReviewStateRecord; local: ReviewStateRecord }> = [];
  return {
    statuses,
    replaced,
    staleWith,
    feedback: () => null,
    snapshot: () => local,
    replace: (state) => void replaced.push(state),
    remoteChanged: () => {},
    stale: (base, unsaved) => void staleWith.push({ base, local: unsaved }),
    status: (kind) => void statuses.push(kind),
  };
}

test("a page told it shows an older review stops saving instead of merging", async () => {
  const seen: Array<Record<string, string>> = [];
  const client = fakeServer(
    [{ status: 409, body: { code: "stale-review", reviewId: "next-review" } }],
    seen,
  );
  let staleCalls = 0;
  client.onStale = () => staleCalls++;
  const local = { lines: { a: { text: "unsaved" } } };
  const callbacks = recordingCallbacks(local);
  const syncer = new StateSyncer(client, 1, { lines: {} }, callbacks, 0, 10);
  syncer.schedule();
  await syncer.flush();
  assert.equal(seen[0]["x-trace-review-id"], REVIEW_ID);
  assert.equal(staleCalls, 1);
  assert.deepEqual(callbacks.staleWith, [{ base: { lines: {} }, local }]);
  assert.deepEqual(callbacks.replaced, [], "nothing is merged into the other review");
  assert.equal(syncer.pending, false);
  syncer.schedule();
  await sleep(30);
  assert.equal(seen.length, 1, "no further saves are sent");
});

test("a 413 is a permanent save error and repeated conflicts retry later", async () => {
  const tooLarge = fakeServer([{ status: 413, body: { error: "too large" } }]);
  const large = recordingCallbacks({ general: { a: "x" } });
  const first = new StateSyncer(tooLarge, 0, {}, large, 0, 10);
  first.schedule();
  await first.flush();
  assert.equal(large.statuses.at(-1), "error");
  assert.equal(first.pending, false, "no retry loop after a 413");

  const conflict = { status: 409, body: { code: "conflict", revision: 3, state: {} } };
  const busy = fakeServer([
    conflict,
    conflict,
    conflict,
    conflict,
    conflict,
    { status: 200, body: { revision: 4 } },
  ]);
  const contested = recordingCallbacks({ general: { a: "x" } });
  const second = new StateSyncer(busy, 0, {}, contested, 0, 10);
  second.schedule();
  await second.flush();
  assert.equal(contested.statuses.at(-1), "error");
  assert.equal(second.pending, true, "a retry is scheduled");
  await waitFor(() => contested.statuses.at(-1) === "saved");
  assert.equal(second.revision, 4);
});

test("the served page allows only its own inline scripts and the pinned CDN scripts", async (t) => {
  const dir = reviewDirectory(t);
  const built = spawnSync(
    process.execPath,
    [
      path.join(root, "dist", "runtime", "scripts", "build-review.mjs"),
      "--spec",
      path.join(root, "examples", "review-spec.json"),
      "--out",
      path.join(dir, "review.html"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(built.status, 0, built.stderr);
  const server = await serve(t, dir);
  const page = await call(server);
  const policy = String(page.headers["content-security-policy"]);
  const scriptSrc = /script-src ([^;]+)/.exec(policy)?.[1].split(" ") ?? [];
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  assert.match(policy, /frame-ancestors 'none'/);
  let inline = 0;
  for (const match of page.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const src = /\ssrc="([^"]+)"/.exec(match[1])?.[1];
    if (src) {
      assert.match(match[1], /\sintegrity="sha384-[A-Za-z0-9+/=]+"/, src);
      assert.match(match[1], /\scrossorigin="anonymous"/, src);
      assert.ok(
        scriptSrc.some((source) => source.endsWith("/") && src.startsWith(source)),
        src,
      );
      continue;
    }
    if (/type="application\/json"/.test(match[1])) continue;
    inline++;
    const hash = createHash("sha256").update(match[2]).digest("base64");
    assert.ok(scriptSrc.includes(`'sha256-${hash}'`), `inline script ${inline} is allowed`);
  }
  assert.ok(inline >= 3, "theme, client, and diagram scripts are hashed");
});
