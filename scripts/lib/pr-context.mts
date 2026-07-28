import fs from "node:fs";
import path from "node:path";
import { parseDiffPaths, preflightPatch } from "./preflight.mjs";
import { detectChangeGroups } from "./change-groups.mjs";
import type { ChangeGrouping } from "./change-groups.mjs";
import type { CommandRunner, PatchAnalysis } from "./preflight.mjs";

type JsonObject = Record<string, unknown>;

export interface ContextDiagnostic {
  level: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

interface GitHubCheck extends JsonObject {
  __typename?: string;
  context?: string;
  state?: string;
  targetUrl?: string;
  name?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  detailsUrl?: string;
}

interface RawPullRequest extends JsonObject {
  number?: number;
  url?: string;
  title?: string;
  body?: string;
  baseRefName?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefOid?: string;
  headRepository?: { nameWithOwner?: string };
  labels?: Array<{ name?: string }>;
  statusCheckRollup?: GitHubCheck[];
  reviews?: Array<{
    author?: { login?: string };
    state?: string;
    body?: string;
    submittedAt?: string;
  }>;
  comments?: Array<{
    author?: { login?: string };
    body?: string;
    url?: string;
    createdAt?: string;
  }>;
}

interface RawReviewComment extends JsonObject {
  user?: { login?: string };
  body?: string;
  html_url?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  side?: string;
  start_line?: number | null;
  created_at?: string;
}

export interface NormalizedPullRequest {
  number: number;
  url: string;
  title: string;
  description: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  baseSha: string;
  headRepository: string;
  labels: string[];
  checks: Array<{ name: string; status: string; conclusion: string; detailsUrl: string }>;
  reviews: Array<{ author: string; state: string; body: string; submittedAt: string }>;
  comments: Array<{ author: string; body: string; url: string; createdAt: string }>;
  reviewComments?: Array<{
    author: string;
    body: string;
    url: string;
    path: string;
    line: number | null;
    originalLine: number | null;
    side: string;
    startLine: number | null;
    createdAt: string;
  }>;
}

export interface RepositoryFacts {
  root: string;
  remote: string;
  owner?: string;
  name?: string;
}

export interface GitFacts {
  branch: string;
  headSha: string;
  dirty: boolean;
  status: string[];
  baseRef?: string;
  headRef?: string;
  diffArgs?: string[];
  diffLabel?: string;
}

export interface ContextValidation {
  valid: boolean;
  diagnostics: ContextDiagnostic[];
}

export interface CollectedContext {
  schemaVersion: 1;
  source: "local" | "github";
  selection: { mode: string; requested: string; reason?: string };
  repository: RepositoryFacts;
  git: GitFacts;
  pullRequest: NormalizedPullRequest | null;
  diff: string;
  preflight: PatchAnalysis;
  changeGroups: ChangeGrouping;
  collectionDiagnostics: ContextDiagnostic[];
  validation: ContextValidation;
}

export interface CollectedFileContent {
  path: string;
  revision: "head" | "base";
  content?: string;
  unavailable?: "binary" | "too-large" | "missing";
}

export interface FileContentsBundle {
  schemaVersion: 1;
  maxFileBytes: number;
  maxTotalBytes: number;
  files: CollectedFileContent[];
}

export interface CollectOptions {
  pr?: string;
  repo?: string;
  base?: string;
  revisions?: string[];
}

export const PR_FIELDS =
  "number,url,title,body,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,labels,statusCheckRollup,reviews,comments";

export const MAX_FULL_FILE_BYTES = 1024 * 1024;
export const MAX_FULL_FILES_BYTES = 10 * 1024 * 1024;
const GITHUB_BLOB_BATCH_SIZE = 10;

function trim(value: unknown): string {
  return String(value ?? "").trim();
}

function repositoryFromRemote(remote: string): Omit<RepositoryFacts, "root"> {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(trim(remote));
  return match ? { owner: match[1], name: match[2], remote } : { remote };
}

function normalizeCheck(check: GitHubCheck): NormalizedPullRequest["checks"][number] {
  if (check.__typename === "StatusContext") {
    return {
      name: check.context || "",
      status: check.state || "",
      conclusion: check.state || "",
      detailsUrl: check.targetUrl || "",
    };
  }
  return {
    name: check.name || check.workflowName || "",
    status: check.status || "",
    conclusion: check.conclusion || "",
    detailsUrl: check.detailsUrl || "",
  };
}

function normalizePr(raw: RawPullRequest): NormalizedPullRequest {
  return {
    number: raw.number ?? 0,
    url: raw.url ?? "",
    title: raw.title ?? "",
    description: raw.body || "",
    baseBranch: raw.baseRefName ?? "",
    headBranch: raw.headRefName ?? "",
    headSha: raw.headRefOid ?? "",
    baseSha: raw.baseRefOid ?? "",
    headRepository: raw.headRepository?.nameWithOwner || "",
    labels: (raw.labels || [])
      .map((label) => label.name)
      .filter((label): label is string => Boolean(label)),
    checks: (raw.statusCheckRollup || []).map(normalizeCheck),
    reviews: (raw.reviews || []).map((review) => ({
      author: review.author?.login || "",
      state: review.state || "",
      body: review.body || "",
      submittedAt: review.submittedAt || "",
    })),
    comments: (raw.comments || []).map((comment) => ({
      author: comment.author?.login || "",
      body: comment.body || "",
      url: comment.url || "",
      createdAt: comment.createdAt || "",
    })),
  };
}

function deletedFiles(diff: string): Set<string> {
  const deleted = new Set<string>();
  let currentPath = "";
  for (const line of diff.replace(/\r\n?/g, "\n").split("\n")) {
    const paths = parseDiffPaths(line);
    if (paths) {
      currentPath = paths.path;
      continue;
    }
    if (currentPath && (line.startsWith("deleted file mode ") || line === "+++ /dev/null")) {
      deleted.add(currentPath);
    }
  }
  return deleted;
}

function githubContent(
  context: CollectedContext,
  filePath: string,
  revision: "head" | "base",
  run: CommandRunner,
  source?: Pick<RemoteFileRequest, "owner" | "name" | "sha">,
): string {
  const owner = source?.owner || context.repository.owner || "";
  const name = source?.name || context.repository.name || "";
  const sha =
    source?.sha ||
    (revision === "head" ? context.pullRequest?.headSha || "" : context.pullRequest?.baseSha || "");
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const endpoint = `repos/${owner}/${name}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`;
  const encoded = run("gh", ["api", endpoint, "--jq", ".content"], {
    cwd: context.repository.root,
  });
  return Buffer.from(encoded.replace(/\s/g, ""), "base64").toString("utf8");
}

interface RemoteFileRequest {
  path: string;
  sourcePath: string;
  revision: "head" | "base";
  owner: string;
  name: string;
  sha: string;
}

interface RemoteFileResult {
  content?: string;
  unavailable?: "binary" | "too-large" | "missing";
}

function repositoryParts(value: string): { owner: string; name: string } | null {
  const match = /^([^/]+)\/([^/]+)$/.exec(value);
  return match ? { owner: match[1], name: match[2] } : null;
}

function collectGithubFileContents(
  context: CollectedContext,
  deleted: ReadonlySet<string>,
  run: CommandRunner,
): Map<string, RemoteFileResult> {
  const baseRepository = {
    owner: context.repository.owner || "",
    name: context.repository.name || "",
  };
  const headRepository =
    repositoryParts(context.pullRequest?.headRepository || "") || baseRepository;
  const requests = context.preflight.files
    .filter((file) => !file.binary)
    .map((file): RemoteFileRequest => {
      const revision = deleted.has(file.path) ? "base" : "head";
      const repository = revision === "head" ? headRepository : baseRepository;
      return {
        path: file.path,
        sourcePath: revision === "base" ? file.oldPath : file.path,
        revision,
        ...repository,
        sha:
          revision === "head"
            ? context.pullRequest?.headSha || ""
            : context.pullRequest?.baseSha || "",
      };
    });
  const results = new Map<string, RemoteFileResult>();
  const groups = new Map<string, RemoteFileRequest[]>();
  for (const request of requests) {
    const key = `${request.owner}/${request.name}`;
    const group = groups.get(key) || [];
    group.push(request);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    for (let offset = 0; offset < group.length; offset += GITHUB_BLOB_BATCH_SIZE) {
      const batch = group.slice(offset, offset + GITHUB_BLOB_BATCH_SIZE);
      const definitions = batch.map((_, index) => `$expr${index}:String!`).join(",");
      const selections = batch
        .map(
          (_, index) =>
            `f${index}:object(expression:$expr${index}){... on Blob{byteSize isBinary isTruncated text}}`,
        )
        .join("");
      const query = `query($owner:String!,$name:String!,${definitions}){repository(owner:$owner,name:$name){${selections}}}`;
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${batch[0].owner}`,
        "-f",
        `name=${batch[0].name}`,
        ...batch.flatMap((request, index) => [
          "-f",
          `expr${index}=${request.sha}:${request.sourcePath}`,
        ]),
      ];
      try {
        const response = JSON.parse(run("gh", args, { cwd: context.repository.root })) as {
          data?: {
            repository?: Record<
              string,
              {
                byteSize?: number;
                isBinary?: boolean | null;
                isTruncated?: boolean;
                text?: string | null;
              } | null
            >;
          };
        };
        batch.forEach((request, index) => {
          const blob = response.data?.repository?.[`f${index}`];
          if (!blob) {
            results.set(request.path, { unavailable: "missing" });
          } else if (blob.isBinary || blob.text === null) {
            results.set(request.path, { unavailable: "binary" });
          } else if (blob.isTruncated || (blob.byteSize || 0) > MAX_FULL_FILE_BYTES) {
            results.set(request.path, { unavailable: "too-large" });
          } else if (typeof blob.text === "string") {
            results.set(request.path, { content: blob.text });
          } else {
            results.set(request.path, { unavailable: "missing" });
          }
        });
      } catch {
        for (const request of batch) {
          try {
            results.set(request.path, {
              content: githubContent(context, request.sourcePath, request.revision, run, request),
            });
          } catch {
            results.set(request.path, { unavailable: "missing" });
          }
        }
      }
    }
  }
  return results;
}

export function collectFileContents(
  context: CollectedContext,
  run: CommandRunner,
): FileContentsBundle {
  let totalBytes = 0;
  const deleted = deletedFiles(context.diff);
  const remoteFiles =
    context.source === "github" ? collectGithubFileContents(context, deleted, run) : null;
  const files = context.preflight.files.map((file): CollectedFileContent => {
    const revision = deleted.has(file.path) ? "base" : "head";
    if (file.binary) return { path: file.path, revision, unavailable: "binary" };
    if (totalBytes >= MAX_FULL_FILES_BYTES) {
      return { path: file.path, revision, unavailable: "too-large" };
    }
    let content: string;
    try {
      if (context.source === "github") {
        const remote = remoteFiles?.get(file.path);
        if (!remote?.content) {
          return {
            path: file.path,
            revision,
            unavailable: remote?.unavailable || "missing",
          };
        }
        content = remote.content;
      } else if (revision === "base") {
        const source =
          context.git.baseRef === "INDEX"
            ? `:${file.oldPath}`
            : `${context.git.baseRef}:${file.oldPath}`;
        content = run("git", ["show", source], {
          cwd: context.repository.root,
        });
      } else if (context.git.headRef && context.git.headRef !== "WORKTREE") {
        content = run("git", ["show", `${context.git.headRef}:${file.path}`], {
          cwd: context.repository.root,
        });
      } else {
        content = fs.readFileSync(path.join(context.repository.root, file.path), "utf8");
      }
    } catch {
      return { path: file.path, revision, unavailable: "missing" };
    }
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_FULL_FILE_BYTES || totalBytes + bytes > MAX_FULL_FILES_BYTES) {
      return { path: file.path, revision, unavailable: "too-large" };
    }
    totalBytes += bytes;
    return { path: file.path, revision, content };
  });
  return {
    schemaVersion: 1,
    maxFileBytes: MAX_FULL_FILE_BYTES,
    maxTotalBytes: MAX_FULL_FILES_BYTES,
    files,
  };
}

function normalizeReviewComments(
  raw: unknown,
): NonNullable<NormalizedPullRequest["reviewComments"]> {
  const pages = Array.isArray(raw) && Array.isArray(raw[0]) ? raw.flat() : raw;
  return (Array.isArray(pages) ? pages : []).map((comment) => ({
    author: (comment as RawReviewComment).user?.login || "",
    body: (comment as RawReviewComment).body || "",
    url: (comment as RawReviewComment).html_url || "",
    path: (comment as RawReviewComment).path || "",
    line: (comment as RawReviewComment).line ?? null,
    originalLine: (comment as RawReviewComment).original_line ?? null,
    side: (comment as RawReviewComment).side || "",
    startLine: (comment as RawReviewComment).start_line ?? null,
    createdAt: (comment as RawReviewComment).created_at || "",
  }));
}

export function validateContext(context: CollectedContext): ContextValidation {
  const diagnostics: ContextDiagnostic[] = [];
  const addMissing = (fieldPath: string): void => {
    diagnostics.push({
      level: "error",
      code: "missing-field",
      path: fieldPath,
      message: `Required context field '${fieldPath}' is missing.`,
    });
  };
  const requireString = (value: unknown, fieldPath: string, allowEmpty = false): void => {
    if (value === undefined || value === null || (!allowEmpty && value === "")) {
      addMissing(fieldPath);
    } else if (typeof value !== "string") {
      diagnostics.push({
        level: "error",
        code: "invalid-field-type",
        path: fieldPath,
        message: `Context field '${fieldPath}' must be a string.`,
      });
    }
  };
  const requireArray = (
    value: unknown,
    fieldPath: string,
    validateItem?: (item: unknown, path: string) => void,
  ): void => {
    if (value === undefined || value === null) {
      addMissing(fieldPath);
    } else if (!Array.isArray(value)) {
      diagnostics.push({
        level: "error",
        code: "invalid-field-type",
        path: fieldPath,
        message: `Context field '${fieldPath}' must be an array.`,
      });
    } else if (validateItem) {
      value.forEach((item, index) => validateItem(item, `${fieldPath}[${index}]`));
    }
  };
  const requireObject = (
    value: unknown,
    fieldPath: string,
    validateFields: (item: JsonObject, path: string) => void,
  ): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      diagnostics.push({
        level: "error",
        code: "invalid-field-type",
        path: fieldPath,
        message: `Context field '${fieldPath}' must be an object.`,
      });
    } else {
      validateFields(value as JsonObject, fieldPath);
    }
  };
  const requireNullableNumber = (value: unknown, fieldPath: string): void => {
    if (value !== null && typeof value !== "number") {
      diagnostics.push({
        level: "error",
        code: "invalid-field-type",
        path: fieldPath,
        message: `Context field '${fieldPath}' must be a number or null.`,
      });
    }
  };

  if (context.schemaVersion === undefined || context.schemaVersion === null) {
    addMissing("schemaVersion");
  }
  if (context.schemaVersion !== undefined && context.schemaVersion !== 1) {
    diagnostics.push({
      level: "error",
      code: "unsupported-schema-version",
      path: "schemaVersion",
      message: `Unsupported context schema version '${context.schemaVersion}'. Expected version 1.`,
    });
  }
  requireString(context.source, "source");
  requireString(context.repository?.root, "repository.root");
  requireString(context.git?.headSha, "git.headSha");
  if (context.source === "github") {
    const pullRequestNumber = context.pullRequest?.number;
    if (!Number.isInteger(pullRequestNumber) || (pullRequestNumber ?? 0) < 1) {
      if (pullRequestNumber === undefined || pullRequestNumber === null) {
        addMissing("pullRequest.number");
      } else {
        diagnostics.push({
          level: "error",
          code: "invalid-field-type",
          path: "pullRequest.number",
          message: "Context field 'pullRequest.number' must be a positive integer.",
        });
      }
    }
    requireString(context.pullRequest?.url, "pullRequest.url");
    requireString(context.pullRequest?.title, "pullRequest.title");
    requireString(context.pullRequest?.baseBranch, "pullRequest.baseBranch");
    requireString(context.pullRequest?.headBranch, "pullRequest.headBranch");
    requireString(context.pullRequest?.headSha, "pullRequest.headSha");
    requireString(context.pullRequest?.description, "pullRequest.description", true);
    requireArray(context.pullRequest?.labels, "pullRequest.labels", (label, itemPath) =>
      requireString(label, itemPath),
    );
    requireArray(context.pullRequest?.checks, "pullRequest.checks", (check, itemPath) =>
      requireObject(check, itemPath, (item, objectPath) => {
        requireString(item.name, `${objectPath}.name`, true);
        requireString(item.status, `${objectPath}.status`, true);
        requireString(item.conclusion, `${objectPath}.conclusion`, true);
        requireString(item.detailsUrl, `${objectPath}.detailsUrl`, true);
      }),
    );
    requireArray(context.pullRequest?.reviews, "pullRequest.reviews", (review, itemPath) =>
      requireObject(review, itemPath, (item, objectPath) => {
        requireString(item.author, `${objectPath}.author`, true);
        requireString(item.state, `${objectPath}.state`, true);
        requireString(item.body, `${objectPath}.body`, true);
        requireString(item.submittedAt, `${objectPath}.submittedAt`, true);
      }),
    );
    requireArray(context.pullRequest?.comments, "pullRequest.comments", (comment, itemPath) =>
      requireObject(comment, itemPath, (item, objectPath) => {
        requireString(item.author, `${objectPath}.author`, true);
        requireString(item.body, `${objectPath}.body`, true);
        requireString(item.url, `${objectPath}.url`, true);
        requireString(item.createdAt, `${objectPath}.createdAt`, true);
      }),
    );
    requireArray(
      context.pullRequest?.reviewComments,
      "pullRequest.reviewComments",
      (comment, itemPath) =>
        requireObject(comment, itemPath, (item, objectPath) => {
          requireString(item.author, `${objectPath}.author`, true);
          requireString(item.body, `${objectPath}.body`, true);
          requireString(item.url, `${objectPath}.url`, true);
          requireString(item.path, `${objectPath}.path`, true);
          requireNullableNumber(item.line, `${objectPath}.line`);
          requireNullableNumber(item.originalLine, `${objectPath}.originalLine`);
          requireString(item.side, `${objectPath}.side`, true);
          requireNullableNumber(item.startLine, `${objectPath}.startLine`);
          requireString(item.createdAt, `${objectPath}.createdAt`, true);
        }),
    );
  }
  if (!context.preflight?.patch?.valid) {
    diagnostics.push({
      level: "error",
      code: "invalid-patch",
      path: "preflight.patch",
      message: "Collected diff is not a valid Git patch.",
    });
  }
  return {
    valid: !diagnostics.some((item) => item.level === "error"),
    diagnostics,
  };
}

function gitFacts(
  repo: string,
  run: CommandRunner,
): { repository: RepositoryFacts; git: GitFacts } {
  const root = trim(run("git", ["rev-parse", "--show-toplevel"], { cwd: repo }));
  const branch = trim(run("git", ["branch", "--show-current"], { cwd: root }));
  const headSha = trim(run("git", ["rev-parse", "HEAD"], { cwd: root }));
  let remote = "";
  try {
    remote = trim(run("git", ["remote", "get-url", "origin"], { cwd: root }));
  } catch {
    // A local-only repository is valid when remote context is disabled or unavailable.
  }
  const status = trim(run("git", ["status", "--short", "--untracked-files=normal"], { cwd: root }));
  return {
    repository: { root, ...repositoryFromRemote(remote) },
    git: {
      branch,
      headSha,
      dirty: Boolean(status),
      status: status ? status.split("\n") : [],
    },
  };
}

function collectLocalContext(
  facts: ReturnType<typeof gitFacts>,
  selection: string,
  reason: string,
  options: CollectOptions,
  run: CommandRunner,
  collectionDiagnostics: ContextDiagnostic[] = [],
): CollectedContext {
  if (options.revisions !== undefined) {
    const revisions = options.revisions;
    const diff = run("git", ["diff", "--binary", "--no-ext-diff", ...revisions], {
      cwd: facts.repository.root,
    });
    let baseRef = "INDEX";
    let headRef = "WORKTREE";
    let diffLabel = "Working tree changes";
    if (revisions.length === 1) {
      const range = /^(.*?)(\.\.\.?)(.*)$/.exec(revisions[0]);
      if (range) {
        const left = range[1] || "HEAD";
        const right = range[3] || "HEAD";
        baseRef =
          range[2] === "..."
            ? trim(run("git", ["merge-base", left, right], { cwd: facts.repository.root }))
            : left;
        headRef = right;
        diffLabel = `${left}${range[2]}${right}`;
      } else {
        baseRef = revisions[0];
        diffLabel = `${revisions[0]} ↔ working tree`;
      }
    } else if (revisions.length === 2) {
      [baseRef, headRef] = revisions;
      diffLabel = `${baseRef} ↔ ${headRef}`;
    } else if (revisions.length > 2) {
      throw new Error("Quick revision comparisons accept at most two Git revisions.");
    }
    let headSha = facts.git.headSha;
    if (headRef !== "WORKTREE") {
      headSha = trim(
        run("git", ["rev-parse", `${headRef}^{commit}`], { cwd: facts.repository.root }),
      );
    }
    const preflight = preflightPatch(diff, run, facts.repository.root);
    const context: CollectedContext = {
      schemaVersion: 1,
      source: "local",
      selection: {
        mode: "none",
        requested: revisions.join(" "),
        reason: "explicit-git-diff",
      },
      repository: facts.repository,
      git: {
        ...facts.git,
        headSha,
        baseRef,
        headRef,
        diffArgs: revisions,
        diffLabel,
      },
      pullRequest: null,
      diff,
      preflight,
      changeGroups: detectChangeGroups(diff, preflight),
      collectionDiagnostics,
      validation: { valid: false, diagnostics: [] },
    };
    context.validation = validateContext(context);
    return context;
  }

  let baseRef = options.base;
  if (!baseRef) {
    try {
      baseRef = trim(
        run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
          cwd: facts.repository.root,
        }),
      );
    } catch {
      baseRef = "HEAD";
    }
  }
  const defaultBranch = baseRef.includes("/")
    ? baseRef.slice(baseRef.lastIndexOf("/") + 1)
    : baseRef;
  if (facts.git.branch === defaultBranch) baseRef = "HEAD";

  const diff = run("git", ["diff", "--binary", "--no-ext-diff", baseRef], {
    cwd: facts.repository.root,
  });
  const preflight = preflightPatch(diff, run, facts.repository.root);
  const context: CollectedContext = {
    schemaVersion: 1,
    source: "local",
    selection: {
      mode: selection === "none" ? "none" : "auto",
      requested: selection,
      reason,
    },
    repository: facts.repository,
    git: { ...facts.git, baseRef },
    pullRequest: null,
    diff,
    preflight,
    changeGroups: detectChangeGroups(diff, preflight),
    collectionDiagnostics,
    validation: { valid: false, diagnostics: [] },
  };
  context.validation = validateContext(context);
  return context;
}

export function collectPrContext(options: CollectOptions, run: CommandRunner): CollectedContext {
  const selection = options.pr || "auto";
  const mode = selection === "auto" ? "auto" : selection === "none" ? "none" : "explicit";
  const facts = gitFacts(options.repo || process.cwd(), run);

  if (mode === "none") {
    return collectLocalContext(facts, selection, "remote-context-disabled", options, run);
  }

  const viewArgs = ["pr", "view"];
  if (mode === "explicit") viewArgs.push(selection);
  viewArgs.push("--json", PR_FIELDS);
  let raw: RawPullRequest;
  try {
    raw = JSON.parse(run("gh", viewArgs, { cwd: facts.repository.root })) as RawPullRequest;
  } catch (error: unknown) {
    if (mode !== "auto") throw error;
    const noPullRequest =
      /no pull requests? found|could not find a pull request|no pull request found/i.test(
        error instanceof Error ? error.message : "",
      );
    const collectionDiagnostics: ContextDiagnostic[] = noPullRequest
      ? []
      : [
          {
            level: "warning",
            code: "remote-context-unavailable",
            message: `GitHub context unavailable: ${error instanceof Error ? error.message : String(error)}`,
          },
        ];
    return collectLocalContext(
      facts,
      selection,
      noPullRequest ? "current-branch-pr-not-found" : "remote-context-unavailable",
      options,
      run,
      collectionDiagnostics,
    );
  }
  const pullRequest = normalizePr(raw);
  const collectionDiagnostics: ContextDiagnostic[] = [];
  const repoOwner = /github\.com\/([^/]+)/.exec(pullRequest.url)?.[1] || facts.repository.owner;
  const repoName =
    /github\.com\/[^/]+\/([^/]+)\/pull\//.exec(pullRequest.url)?.[1] || facts.repository.name;
  try {
    const reviewComments = JSON.parse(
      run(
        "gh",
        [
          "api",
          "--paginate",
          "--slurp",
          `repos/${repoOwner}/${repoName}/pulls/${pullRequest.number}/comments`,
        ],
        { cwd: facts.repository.root },
      ),
    );
    pullRequest.reviewComments = normalizeReviewComments(reviewComments);
  } catch (error: unknown) {
    pullRequest.reviewComments = [];
    collectionDiagnostics.push({
      level: "warning",
      code: "review-comments-unavailable",
      message: `Could not collect inline review comments: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const diffSelector = mode === "explicit" ? selection : String(pullRequest.number);
  const diff = run("gh", ["pr", "diff", diffSelector], {
    cwd: facts.repository.root,
  });
  const preflight = preflightPatch(diff, run, facts.repository.root);
  const context: CollectedContext = {
    schemaVersion: 1,
    source: "github",
    selection: { mode, requested: selection },
    repository: facts.repository,
    git: facts.git,
    pullRequest,
    diff,
    preflight,
    changeGroups: detectChangeGroups(diff, preflight),
    collectionDiagnostics,
    validation: { valid: false, diagnostics: [] },
  };
  context.validation = validateContext(context);
  return context;
}
