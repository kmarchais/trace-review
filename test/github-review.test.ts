import assert from "node:assert/strict";
import test from "node:test";
import {
  GithubReviewPublicationError,
  prepareGithubReview,
  publishGithubReview,
} from "../scripts/lib/github-review.mjs";

test("eligible line and block comments become native GitHub review comments", () => {
  const plan = prepareGithubReview(
    {
      repository: "acme/widgets",
      pullRequest: 42,
      headSha: "abc123",
      url: "https://github.com/acme/widgets/pull/42",
    },
    {
      summary: "Please address the inline feedback.",
      comments: [
        {
          kind: "line",
          path: "src/widget.ts",
          body: "Handle the empty case.",
          side: "RIGHT",
          line: 18,
          anchorStatus: "current",
        },
        {
          kind: "line",
          path: "src/legacy.ts",
          body: "Keep this range covered.",
          side: "LEFT",
          startSide: "LEFT",
          startLine: 7,
          line: 9,
          anchorStatus: "current",
        },
      ],
    },
  );

  assert.deepEqual(plan.nativeComments, [
    {
      path: "src/widget.ts",
      body: "Handle the empty case.",
      side: "RIGHT",
      line: 18,
    },
    {
      path: "src/legacy.ts",
      body: "Keep this range covered.",
      side: "LEFT",
      line: 9,
      start_side: "LEFT",
      start_line: 7,
    },
  ]);
  assert.deepEqual(plan.fallbackComments, []);
  assert.equal(plan.summary, "Please address the inline feedback.");
});

test("file, orphaned, and incomplete comments remain in the summary fallback", () => {
  const plan = prepareGithubReview(
    {
      repository: "acme/widgets",
      pullRequest: 42,
      headSha: "abc123",
      url: "https://github.com/acme/widgets/pull/42",
    },
    {
      summary: "Overall review.",
      comments: [
        {
          kind: "file",
          path: "src/widget.ts",
          body: "This file needs a smaller interface.",
        },
        {
          kind: "line",
          path: "src/widget.ts",
          body: "This saved comment moved.",
          side: "RIGHT",
          line: 18,
          anchorStatus: "orphaned",
        },
        {
          kind: "line",
          path: "src/widget.ts",
          body: "This has no side.",
          line: 22,
          anchorStatus: "current",
        },
        {
          kind: "line",
          path: "src/widget.ts",
          body: "This range runs backwards.",
          side: "RIGHT",
          startSide: "RIGHT",
          startLine: 30,
          line: 24,
          anchorStatus: "current",
        },
      ],
    },
  );

  assert.deepEqual(plan.nativeComments, []);
  assert.deepEqual(
    plan.fallbackComments.map(({ location, reason }) => ({ location, reason })),
    [
      {
        location: "src/widget.ts",
        reason: "file comments do not have a diff anchor",
      },
      {
        location: "src/widget.ts:18 (RIGHT)",
        reason: "the saved diff anchor is no longer present",
      },
      {
        location: "src/widget.ts:22 (unknown side)",
        reason: "the comment does not have a complete GitHub diff anchor",
      },
      {
        location: "src/widget.ts:30-24 (RIGHT)",
        reason: "the comment does not have a complete GitHub diff anchor",
      },
    ],
  );
});

test("publication refuses a stale pull-request head before confirmation or submission", async () => {
  const plan = prepareGithubReview(
    {
      repository: "acme/widgets",
      pullRequest: 42,
      headSha: "expected-head",
      url: "https://github.com/acme/widgets/pull/42",
    },
    {
      summary: "Review summary.",
      comments: [
        {
          kind: "line",
          path: "src/widget.ts",
          body: "Handle the empty case.",
          side: "RIGHT",
          line: 18,
          anchorStatus: "current",
        },
      ],
    },
  );
  let confirmed = false;
  let submitted = false;

  await assert.rejects(
    publishGithubReview(plan, {
      publisher: {
        async isAuthenticated() {
          return true;
        },
        async currentHead() {
          return "new-head";
        },
        async createReview() {
          submitted = true;
          return { url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1" };
        },
      },
      async confirm() {
        confirmed = true;
        return true;
      },
    }),
    (error: unknown) =>
      error instanceof GithubReviewPublicationError && error.code === "stale-head",
  );
  assert.equal(confirmed, false);
  assert.equal(submitted, false);
});

test("publication requires authentication and explicit confirmation", async () => {
  const plan = prepareGithubReview(
    {
      repository: "acme/widgets",
      pullRequest: 42,
      headSha: "abc123",
      url: "https://github.com/acme/widgets/pull/42",
    },
    { summary: "Review summary.", comments: [] },
  );
  let headChecked = false;
  await assert.rejects(
    publishGithubReview(plan, {
      publisher: {
        async isAuthenticated() {
          return false;
        },
        async currentHead() {
          headChecked = true;
          return "abc123";
        },
        async createReview() {
          throw new Error("must not submit");
        },
      },
      async confirm() {
        throw new Error("must not confirm");
      },
    }),
    (error: unknown) =>
      error instanceof GithubReviewPublicationError && error.code === "authentication-required",
  );
  assert.equal(headChecked, false);

  let submitted = false;
  const cancelled = await publishGithubReview(plan, {
    publisher: {
      async isAuthenticated() {
        return true;
      },
      async currentHead() {
        return "abc123";
      },
      async createReview() {
        submitted = true;
        return {};
      },
    },
    async confirm() {
      return false;
    },
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(submitted, false);
});

test("publication reports a rejected GitHub review without losing the plan", async () => {
  const plan = prepareGithubReview(
    {
      repository: "acme/widgets",
      pullRequest: 42,
      headSha: "abc123",
      url: "https://github.com/acme/widgets/pull/42",
    },
    { summary: "Review summary.", comments: [] },
  );

  await assert.rejects(
    publishGithubReview(plan, {
      publisher: {
        async isAuthenticated() {
          return true;
        },
        async currentHead() {
          return "abc123";
        },
        async createReview() {
          throw new Error("validation failed");
        },
      },
      async confirm() {
        return true;
      },
    }),
    (error: unknown) =>
      error instanceof GithubReviewPublicationError &&
      error.code === "publication-failed" &&
      error.message.includes("validation failed"),
  );
  assert.equal(plan.summary, "Review summary.");
});
