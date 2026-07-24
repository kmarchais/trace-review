import { preflightPatch } from "./preflight.mjs";

export const PR_FIELDS =
  "number,url,title,body,baseRefName,headRefName,headRefOid,labels,statusCheckRollup,reviews,comments";

function trim(value) {
  return String(value ?? "").trim();
}

function repositoryFromRemote(remote) {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(trim(remote));
  return match ? { owner: match[1], name: match[2], remote } : { remote };
}

function normalizeCheck(check) {
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

function normalizePr(raw) {
  return {
    number: raw.number,
    url: raw.url,
    title: raw.title,
    description: raw.body || "",
    baseBranch: raw.baseRefName,
    headBranch: raw.headRefName,
    headSha: raw.headRefOid,
    labels: (raw.labels || []).map((label) => label.name).filter(Boolean),
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

function normalizeReviewComments(raw) {
  const pages = Array.isArray(raw) && Array.isArray(raw[0]) ? raw.flat() : raw;
  return (Array.isArray(pages) ? pages : []).map((comment) => ({
    author: comment.user?.login || "",
    body: comment.body || "",
    url: comment.html_url || "",
    path: comment.path || "",
    line: comment.line ?? null,
    originalLine: comment.original_line ?? null,
    side: comment.side || "",
    startLine: comment.start_line ?? null,
    createdAt: comment.created_at || "",
  }));
}

export function validateContext(context) {
  const diagnostics = [];
  const addMissing = (path) => {
    diagnostics.push({
      level: "error",
      code: "missing-field",
      path,
      message: `Required context field '${path}' is missing.`,
    });
  };
  const requireString = (value, path, allowEmpty = false) => {
    if (value === undefined || value === null || (!allowEmpty && value === "")) {
      addMissing(path);
    } else if (typeof value !== "string") {
      diagnostics.push({
        level: "error",
        code: "invalid-field-type",
        path,
        message: `Context field '${path}' must be a string.`,
      });
    }
  };
  const requireArray = (value, path, validateItem) => {
    if (value === undefined || value === null) {
      addMissing(path);
    } else if (!Array.isArray(value)) {
      diagnostics.push({
        level: "error",
        code: "invalid-field-type",
        path,
        message: `Context field '${path}' must be an array.`,
      });
    } else if (validateItem) {
      value.forEach((item, index) => validateItem(item, `${path}[${index}]`));
    }
  };
  const requireObject = (value, path, validateFields) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      diagnostics.push({
        level: "error",
        code: "invalid-field-type",
        path,
        message: `Context field '${path}' must be an object.`,
      });
    } else {
      validateFields(value, path);
    }
  };
  const requireNullableNumber = (value, path) => {
    if (value !== null && typeof value !== "number") {
      diagnostics.push({
        level: "error",
        code: "invalid-field-type",
        path,
        message: `Context field '${path}' must be a number or null.`,
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
    if (!Number.isInteger(context.pullRequest?.number) || context.pullRequest.number < 1) {
      if (context.pullRequest?.number === undefined || context.pullRequest?.number === null) {
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

function gitFacts(repo, run) {
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

function collectLocalContext(facts, selection, reason, options, run) {
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
  const defaultBranch = baseRef.includes("/") ? baseRef.slice(baseRef.lastIndexOf("/") + 1) : baseRef;
  if (facts.git.branch === defaultBranch) baseRef = "HEAD";

  const diff = run("git", ["diff", "--binary", "--no-ext-diff", baseRef], {
    cwd: facts.repository.root,
  });
  const context = {
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
    preflight: preflightPatch(diff, run, facts.repository.root),
    collectionDiagnostics: [],
  };
  context.validation = validateContext(context);
  return context;
}

export function collectPrContext(options, run) {
  const selection = options.pr || "auto";
  const mode = selection === "auto" ? "auto" : selection === "none" ? "none" : "explicit";
  const facts = gitFacts(options.repo || process.cwd(), run);

  if (mode === "none") {
    return collectLocalContext(
      facts,
      selection,
      "remote-context-disabled",
      options,
      run,
    );
  }

  const viewArgs = ["pr", "view"];
  if (mode === "explicit") viewArgs.push(selection);
  viewArgs.push("--json", PR_FIELDS);
  let raw;
  try {
    raw = JSON.parse(run("gh", viewArgs, { cwd: facts.repository.root }));
  } catch (error) {
    if (mode !== "auto") throw error;
    return collectLocalContext(
      facts,
      selection,
      "current-branch-pr-not-found",
      options,
      run,
    );
  }
  const pullRequest = normalizePr(raw);
  const collectionDiagnostics = [];
  const repoOwner = /github\.com\/([^/]+)/.exec(pullRequest.url)?.[1] || facts.repository.owner;
  const repoName =
    /github\.com\/[^/]+\/([^/]+)\/pull\//.exec(pullRequest.url)?.[1] ||
    facts.repository.name;
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
  } catch (error) {
    pullRequest.reviewComments = [];
    collectionDiagnostics.push({
      level: "warning",
      code: "review-comments-unavailable",
      message: `Could not collect inline review comments: ${error.message}`,
    });
  }
  const diffSelector = mode === "explicit" ? selection : String(pullRequest.number);
  const diff = run("gh", ["pr", "diff", diffSelector, "--patch"], {
    cwd: facts.repository.root,
  });
  const context = {
    schemaVersion: 1,
    source: "github",
    selection: { mode, requested: selection },
    repository: facts.repository,
    git: facts.git,
    pullRequest,
    diff,
    preflight: preflightPatch(diff, run, facts.repository.root),
    collectionDiagnostics,
  };
  context.validation = validateContext(context);
  return context;
}
