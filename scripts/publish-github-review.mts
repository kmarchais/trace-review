#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { createGhPublisher } from "./lib/github-publisher.mjs";
import {
  GithubReviewPublicationError,
  parseGithubReviewPlan,
  publishGithubReview,
} from "./lib/github-review.mjs";
import { requiredValue } from "./lib/cli.mjs";

interface Args {
  plan?: string;
  confirm: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { confirm: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan") args.plan = requiredValue(argv, index++, arg);
    else if (arg === "--confirm") args.confirm = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument '${arg}'.`);
  }
  return args;
}

const publisher = createGhPublisher();

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
