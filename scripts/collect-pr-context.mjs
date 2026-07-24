#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { collectPrContext } from "./lib/pr-context.mjs";

function usage(message) {
  if (message) console.error(`Error: ${message}`);
  console.error(`Usage:
  node collect-pr-context.mjs [--repo <path>] [--pr auto|none|<number|url>]
    [--base <ref>] [--out <context.json>] [--diff-out <context.patch>]

Options:
  --pr auto        Detect the current branch's pull request; fall back locally (default).
  --pr <number|url> Collect an explicitly selected pull request.
  --pr none        Intentionally disable remote context and collect a local diff.
  --no-remote      Alias for --pr none.
  --base <ref>     Local diff base (default: origin's default branch, or HEAD).`);
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const args = { pr: "auto", repo: process.cwd() };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--repo") args.repo = argv[++index];
    else if (arg === "--pr") args.pr = argv[++index];
    else if (arg === "--base") args.base = argv[++index];
    else if (arg === "--out") args.out = argv[++index];
    else if (arg === "--diff-out") args.diffOut = argv[++index];
    else if (arg === "--no-remote") args.pr = "none";
    else if (arg === "--help" || arg === "-h") args.help = true;
    else usage(`Unknown option: ${arg}`);
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 100 * 1024 * 1024,
    input: options.input,
  });
  if (result.error) {
    throw new Error(`Could not run '${command}': ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `'${command} ${args.join(" ")}' failed${detail ? `: ${detail}` : ` with exit code ${result.status}`}`,
    );
  }
  return result.stdout;
}

function ensureValue(args, key, option) {
  if (args[key] === undefined) usage(`${option} requires a value`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) usage();
ensureValue(args, "repo", "--repo");
ensureValue(args, "pr", "--pr");
if (process.argv.includes("--base")) ensureValue(args, "base", "--base");
if (process.argv.includes("--out")) ensureValue(args, "out", "--out");
if (process.argv.includes("--diff-out")) ensureValue(args, "diffOut", "--diff-out");

try {
  const context = collectPrContext(args, run);
  for (const diagnostic of context.collectionDiagnostics || []) {
    console.warn(`${diagnostic.level.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
  }
  if (!context.validation.valid) {
    for (const diagnostic of context.validation.diagnostics) {
      console.error(`${diagnostic.level.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
    }
    process.exit(2);
  }

  const outputPath = path.resolve(
    args.out || path.join(context.repository.root, ".review", "context.json"),
  );
  const diffPath = path.resolve(
    args.diffOut || path.join(path.dirname(outputPath), "context.patch"),
  );
  fs.mkdirSync(path.dirname(diffPath), { recursive: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(diffPath, context.diff, "utf8");

  const persisted = {
    ...context,
    diff: {
      path: path.relative(path.dirname(outputPath), diffPath).replaceAll("\\", "/"),
      source: context.source,
      bytes: context.preflight.totals.bytes,
    },
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outputPath}`);
  console.log(`Wrote ${diffPath}`);
} catch (error) {
  const missingGh =
    args.pr !== "auto" && args.pr !== "none" && /Could not run 'gh'/.test(error.message);
  const hint = missingGh
    ? " Install the GitHub CLI for explicit PR selection, or use --no-remote for a local review."
    : "";
  console.error(`Error: ${error.message}${hint}`);
  process.exit(1);
}
