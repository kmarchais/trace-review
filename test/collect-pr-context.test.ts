import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { collectPrContext, validateContext } from "../scripts/lib/pr-context.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const patch = fs.readFileSync(path.join(root, "test", "fixtures", "mixed.patch"), "utf8");

function fakeRunner(responses) {
  const calls = [];
  const run = (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    if (!(key in responses)) throw new Error(`Unexpected command: ${key}`);
    const response = responses[key];
    if (response instanceof Error) throw response;
    return response;
  };
  run.calls = calls;
  return run;
}

const prJson = {
  number: 42,
  url: "https://github.com/acme/widgets/pull/42",
  title: "Harden widget parsing",
  body: "Reject malformed widget records.",
  baseRefName: "main",
  headRefName: "feature/widgets",
  headRefOid: "abc123",
  labels: [{ name: "bug" }, { name: "ready" }],
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      name: "test",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: "https://example.test/checks/1",
    },
  ],
  reviews: [
    {
      author: { login: "reviewer" },
      state: "APPROVED",
      body: "Looks good.",
      submittedAt: "2026-07-24T10:00:00Z",
    },
  ],
  comments: [
    {
      author: { login: "maintainer" },
      body: "Please keep the compatibility path.",
      url: "https://github.com/acme/widgets/pull/42#issuecomment-1",
      createdAt: "2026-07-24T09:00:00Z",
    },
  ],
};

test("auto mode collects and validates complete pull request context", () => {
  const run = fakeRunner({
    "git rev-parse --show-toplevel": "C:/work/widgets\n",
    "git branch --show-current": "feature/widgets\n",
    "git rev-parse HEAD": "abc123\n",
    "git remote get-url origin": "https://github.com/acme/widgets.git\n",
    "git status --short --untracked-files=normal": "",
    "git apply --numstat -": "1\t0\tsrc/app.js\n1\t1\tpackage-lock.json\n-\t-\tassets/logo.png\n",
    "gh pr view --json number,url,title,body,baseRefName,headRefName,headRefOid,labels,statusCheckRollup,reviews,comments": `${JSON.stringify(prJson)}\n`,
    "gh api --paginate --slurp repos/acme/widgets/pulls/42/comments": `${JSON.stringify([
      [
        {
          user: { login: "inline-reviewer" },
          body: "This branch needs a null guard.",
          html_url: "https://github.com/acme/widgets/pull/42#discussion_r1",
          path: "src/app.js",
          line: 2,
          original_line: 2,
          side: "RIGHT",
          start_line: null,
          created_at: "2026-07-24T11:00:00Z",
        },
      ],
    ])}\n`,
    "gh pr diff 42 --patch": patch,
  });

  const context = collectPrContext({ repo: "C:/work/widgets", pr: "auto" }, run);

  assert.equal(context.schemaVersion, 1);
  assert.equal(context.source, "github");
  assert.equal(context.selection.mode, "auto");
  assert.equal(context.pullRequest.number, 42);
  assert.deepEqual(context.pullRequest.labels, ["bug", "ready"]);
  assert.deepEqual(context.pullRequest.checks[0], {
    name: "test",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    detailsUrl: "https://example.test/checks/1",
  });
  assert.equal(context.pullRequest.reviews[0].author, "reviewer");
  assert.equal(context.pullRequest.comments[0].author, "maintainer");
  assert.deepEqual(context.pullRequest.reviewComments[0], {
    author: "inline-reviewer",
    body: "This branch needs a null guard.",
    url: "https://github.com/acme/widgets/pull/42#discussion_r1",
    path: "src/app.js",
    line: 2,
    originalLine: 2,
    side: "RIGHT",
    startLine: null,
    createdAt: "2026-07-24T11:00:00Z",
  });
  assert.equal(context.preflight.totals.files, 3);
  assert.equal(context.preflight.patch.gitApply.valid, true);
  assert.equal(context.diff, patch);
  assert.deepEqual(context.validation, { valid: true, diagnostics: [] });
});

test("none mode intentionally skips GitHub and collects the local branch diff", () => {
  const run = fakeRunner({
    "git rev-parse --show-toplevel": "C:/work/widgets\n",
    "git branch --show-current": "feature/widgets\n",
    "git rev-parse HEAD": "abc123\n",
    "git remote get-url origin": "https://github.com/acme/widgets.git\n",
    "git status --short --untracked-files=normal": " M src/app.js\n",
    "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
    "git diff --binary --no-ext-diff origin/main": patch,
    "git apply --numstat -": "1\t0\tsrc/app.js\n1\t1\tpackage-lock.json\n-\t-\tassets/logo.png\n",
  });

  const context = collectPrContext({ repo: "C:/work/widgets", pr: "none" }, run);

  assert.equal(context.source, "local");
  assert.deepEqual(context.selection, {
    mode: "none",
    requested: "none",
    reason: "remote-context-disabled",
  });
  assert.equal(context.pullRequest, null);
  assert.equal(context.git.baseRef, "origin/main");
  assert.equal(context.git.dirty, true);
  assert.equal(context.preflight.totals.files, 3);
  assert.equal(
    run.calls.some((call) => call.startsWith("gh ")),
    false,
  );
  assert.deepEqual(context.collectionDiagnostics, []);
  assert.deepEqual(context.validation, { valid: true, diagnostics: [] });
});

test("auto mode falls back to local context when the branch has no pull request", () => {
  const run = fakeRunner({
    "git rev-parse --show-toplevel": "C:/work/widgets\n",
    "git branch --show-current": "feature/widgets\n",
    "git rev-parse HEAD": "abc123\n",
    "git remote get-url origin": "https://github.com/acme/widgets.git\n",
    "git status --short --untracked-files=normal": "",
    "gh pr view --json number,url,title,body,baseRefName,headRefName,headRefOid,labels,statusCheckRollup,reviews,comments":
      new Error("no pull requests found for branch"),
    "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
    "git diff --binary --no-ext-diff origin/main": patch,
    "git apply --numstat -": "1\t0\tsrc/app.js\n1\t1\tpackage-lock.json\n-\t-\tassets/logo.png\n",
  });

  const context = collectPrContext({ repo: "C:/work/widgets", pr: "auto" }, run);

  assert.equal(context.source, "local");
  assert.equal(context.selection.reason, "current-branch-pr-not-found");
  assert.equal(context.git.baseRef, "origin/main");
  assert.equal(context.preflight.patch.valid, true);
});

test("auto mode warns when GitHub context is unavailable", () => {
  const run = fakeRunner({
    "git rev-parse --show-toplevel": "C:/work/widgets\n",
    "git branch --show-current": "feature/widgets\n",
    "git rev-parse HEAD": "abc123\n",
    "git remote get-url origin": "https://github.com/acme/widgets.git\n",
    "git status --short --untracked-files=normal": "",
    "gh pr view --json number,url,title,body,baseRefName,headRefName,headRefOid,labels,statusCheckRollup,reviews,comments":
      new Error("Could not run 'gh': spawn gh ENOENT"),
    "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
    "git diff --binary --no-ext-diff origin/main": patch,
    "git apply --numstat -": "1\t0\tsrc/app.js\n1\t1\tpackage-lock.json\n-\t-\tassets/logo.png\n",
  });

  const context = collectPrContext({ repo: "C:/work/widgets", pr: "auto" }, run);

  assert.equal(context.source, "local");
  assert.equal(context.selection.reason, "remote-context-unavailable");
  assert.deepEqual(context.collectionDiagnostics, [
    {
      level: "warning",
      code: "remote-context-unavailable",
      message: "GitHub context unavailable: Could not run 'gh': spawn gh ENOENT",
    },
  ]);
  assert.equal(context.validation.valid, true);
});

test("explicit mode passes a pull request URL to GitHub selection", () => {
  const selector = "https://github.com/other/project/pull/42";
  const run = fakeRunner({
    "git rev-parse --show-toplevel": "C:/work/widgets\n",
    "git branch --show-current": "another-branch\n",
    "git rev-parse HEAD": "def456\n",
    "git remote get-url origin": "https://github.com/acme/widgets.git\n",
    "git status --short --untracked-files=normal": "",
    "git apply --numstat -": "1\t0\tsrc/app.js\n1\t1\tpackage-lock.json\n-\t-\tassets/logo.png\n",
    [`gh pr view ${selector} --json number,url,title,body,baseRefName,headRefName,headRefOid,labels,statusCheckRollup,reviews,comments`]: `${JSON.stringify({ ...prJson, url: selector })}\n`,
    "gh api --paginate --slurp repos/other/project/pulls/42/comments": "[]\n",
    [`gh pr diff ${selector} --patch`]: patch,
  });

  const context = collectPrContext({ repo: "C:/work/widgets", pr: selector }, run);

  assert.deepEqual(context.selection, { mode: "explicit", requested: selector });
  assert.equal(context.pullRequest.number, 42);
  assert.equal(
    run.calls.some((call) => call.startsWith(`gh pr view ${selector} `)),
    true,
  );
  assert.equal(run.calls.includes(`gh pr diff ${selector} --patch`), true);
});

test("validation reports actionable paths for incomplete GitHub context", () => {
  const validation = validateContext({
    schemaVersion: 1,
    source: "github",
    repository: { root: "C:/work/widgets" },
    git: { headSha: "abc123" },
    pullRequest: { number: 42 },
    preflight: { patch: { valid: true } },
  });

  assert.equal(validation.valid, false);
  assert.deepEqual(
    validation.diagnostics.map((diagnostic) => diagnostic.path),
    [
      "pullRequest.url",
      "pullRequest.title",
      "pullRequest.baseBranch",
      "pullRequest.headBranch",
      "pullRequest.headSha",
      "pullRequest.description",
      "pullRequest.labels",
      "pullRequest.checks",
      "pullRequest.reviews",
      "pullRequest.comments",
      "pullRequest.reviewComments",
    ],
  );
});

test("validation rejects unknown schema versions", () => {
  const validation = validateContext({
    schemaVersion: 2,
    source: "local",
    repository: { root: "C:/work/widgets" },
    git: { headSha: "abc123" },
    preflight: { patch: { valid: true } },
  });

  assert.equal(validation.valid, false);
  assert.equal(validation.diagnostics[0].code, "unsupported-schema-version");
  assert.equal(validation.diagnostics[0].path, "schemaVersion");
});

test("validation rejects malformed entries in required PR collections", () => {
  const validation = validateContext({
    schemaVersion: 1,
    source: "github",
    repository: { root: "C:/work/widgets" },
    git: { headSha: "abc123" },
    pullRequest: {
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      title: "Widgets",
      description: "",
      baseBranch: "main",
      headBranch: "feature/widgets",
      headSha: "abc123",
      labels: [],
      checks: [null],
      reviews: [],
      comments: [],
      reviewComments: [],
    },
    preflight: { patch: { valid: true } },
  });

  assert.equal(validation.valid, false);
  assert.equal(validation.diagnostics[0].code, "invalid-field-type");
  assert.equal(validation.diagnostics[0].path, "pullRequest.checks[0]");
});
