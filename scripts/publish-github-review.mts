#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  GithubReviewPublicationError,
  parseGithubReviewPlan,
  publishGithubReview,
  type GithubPublicationContext,
  type GithubReviewRequest,
} from "./lib/github-review.mjs";

interface Args {
  plan?: string;
  confirm: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { confirm: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan") args.plan = argv[++index];
    else if (arg === "--confirm") args.confirm = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument '${arg}'.`);
  }
  return args;
}

function gh(args: readonly string[], input?: string): string {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `gh exited ${result.status}`).trim());
  }
  return result.stdout.trim();
}

const publisher = {
  async isAuthenticated(): Promise<boolean> {
    const result = spawnSync("gh", ["auth", "status", "--hostname", "github.com"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  },
  async currentHead(target: GithubPublicationContext): Promise<string> {
    return gh([
      "api",
      `repos/${target.repository}/pulls/${target.pullRequest}`,
      "--jq",
      ".head.sha",
    ]);
  },
  async createReview(
    target: GithubPublicationContext,
    request: GithubReviewRequest,
  ): Promise<{ url?: string }> {
    const url = gh(
      [
        "api",
        "--method",
        "POST",
        `repos/${target.repository}/pulls/${target.pullRequest}/reviews`,
        "--input",
        "-",
        "--jq",
        ".html_url",
      ],
      JSON.stringify(request),
    );
    return url ? { url } : {};
  },
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.plan) {
    console.log("Usage: node publish-github-review.mjs --plan review.github.json [--confirm]");
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const planPath = path.resolve(args.plan);
  const plan = parseGithubReviewPlan(JSON.parse(fs.readFileSync(planPath, "utf8")));
  const result = await publishGithubReview(plan, {
    publisher,
    async confirm(_plan, preview) {
      console.log(`${preview}\n`);
      if (args.confirm) return true;
      if (!process.stdin.isTTY) {
        throw new Error(
          "Interactive confirmation is unavailable. Re-run with --confirm after reviewing the preview.",
        );
      }
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await prompt.question("Publish this GitHub review? [y/N] ");
        return /^(y|yes)$/i.test(answer.trim());
      } finally {
        prompt.close();
      }
    },
  });

  if (result.status === "cancelled") {
    console.log("Publication cancelled; the plan was not changed.");
    return;
  }
  console.log(
    `Published ${result.nativeComments} native thread${result.nativeComments === 1 ? "" : "s"} with ${result.fallbackComments} summary fallback${result.fallbackComments === 1 ? "" : "s"}.`,
  );
  if (result.url) console.log(result.url);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const prefix =
    error instanceof GithubReviewPublicationError
      ? `GitHub review publication failed [${error.code}]`
      : "GitHub review publication failed";
  console.error(`${prefix}: ${message}`);
  process.exitCode = 2;
});
