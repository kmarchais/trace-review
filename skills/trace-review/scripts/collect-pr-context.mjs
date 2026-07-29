#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { collectFileContents, collectPrContext } from "./lib/pr-context.mjs";
import { errorMessage } from "./lib/cli.mjs";
function usage(message) {
    if (message)
        console.error(`Error: ${message}`);
    console.error(`Usage:
  node collect-pr-context.mjs [--repo <path>] [--pr auto|none|<number|url>]
    [--base <ref>] [--out <context.json>] [--diff-out <context.patch>]
    [--files-out <context.files.json>] [--git-diff] [--revision <ref>]

Options:
  --pr auto        Detect the current branch's pull request; fall back locally (default).
  --pr <number|url> Collect an explicitly selected pull request.
  --pr none        Intentionally disable remote context and collect a local diff.
  --no-remote      Alias for --pr none.
  --base <ref>     Local diff base (default: origin's default branch, or HEAD).
  --git-diff       Use exact git-diff revision semantics; repeat --revision for refs.`);
    process.exit(message ? 1 : 0);
}
function parseArgs(argv) {
    const args = { pr: "auto", repo: process.cwd() };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--repo")
            args.repo = argv[++index];
        else if (arg === "--pr")
            args.pr = argv[++index];
        else if (arg === "--base")
            args.base = argv[++index];
        else if (arg === "--out")
            args.out = argv[++index];
        else if (arg === "--diff-out")
            args.diffOut = argv[++index];
        else if (arg === "--files-out")
            args.filesOut = argv[++index];
        else if (arg === "--git-diff")
            args.revisions = [];
        else if (arg === "--revision") {
            args.revisions ??= [];
            args.revisions.push(argv[++index]);
        }
        else if (arg === "--no-remote")
            args.pr = "none";
        else if (arg === "--help" || arg === "-h")
            args.help = true;
        else
            usage(`Unknown option: ${arg}`);
    }
    return args;
}
const run = (command, commandArgs, options = {}) => {
    const result = spawnSync(command, commandArgs, {
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
        throw new Error(`'${command} ${commandArgs.join(" ")}' failed${detail ? `: ${detail}` : ` with exit code ${result.status}`}`);
    }
    return result.stdout;
};
function ensureValue(args, key, option) {
    if (args[key] === undefined)
        usage(`${option} requires a value`);
}
const args = parseArgs(process.argv.slice(2));
if (args.help)
    usage();
ensureValue(args, "repo", "--repo");
ensureValue(args, "pr", "--pr");
if (process.argv.includes("--base"))
    ensureValue(args, "base", "--base");
if (process.argv.includes("--out"))
    ensureValue(args, "out", "--out");
if (process.argv.includes("--diff-out"))
    ensureValue(args, "diffOut", "--diff-out");
if (process.argv.includes("--files-out"))
    ensureValue(args, "filesOut", "--files-out");
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
    const outputPath = path.resolve(args.out || path.join(context.repository.root, ".review", "context.json"));
    const diffPath = path.resolve(args.diffOut || path.join(path.dirname(outputPath), "context.patch"));
    const filesPath = path.resolve(args.filesOut || path.join(path.dirname(outputPath), "context.files.json"));
    fs.mkdirSync(path.dirname(diffPath), { recursive: true });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(diffPath, context.diff, "utf8");
    const fileContents = collectFileContents(context, run);
    fs.writeFileSync(filesPath, `${JSON.stringify(fileContents, null, 2)}\n`, "utf8");
    const persisted = {
        ...context,
        diff: {
            path: path.relative(path.dirname(outputPath), diffPath).replaceAll("\\", "/"),
            source: context.source,
            bytes: context.preflight.totals.bytes,
        },
        fileContents: {
            path: path.relative(path.dirname(outputPath), filesPath).replaceAll("\\", "/"),
        },
    };
    fs.writeFileSync(outputPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    console.log(`Wrote ${outputPath}`);
    console.log(`Wrote ${diffPath}`);
    console.log(`Wrote ${filesPath}`);
}
catch (error) {
    const message = errorMessage(error);
    const missingGh = args.pr !== "auto" && args.pr !== "none" && /Could not run 'gh'/.test(message);
    const hint = missingGh
        ? " Install the GitHub CLI for explicit PR selection, or use --no-remote for a local review."
        : "";
    console.error(`Error: ${message}${hint}`);
    process.exit(1);
}
