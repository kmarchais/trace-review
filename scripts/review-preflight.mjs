#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { preflightPatch } from "./lib/preflight.mjs";

function usage(message) {
  if (message) console.error(`Error: ${message}`);
  console.error("Usage: node review-preflight.mjs --diff <patch> [--out <json>]");
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--diff") args.diff = argv[++index];
    else if (arg === "--out") args.out = argv[++index];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else usage(`Unknown option: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) usage();
if (!args.diff) usage("--diff is required");

const diffPath = path.resolve(args.diff);
function run(command, commandArgs, options = {}) {
  const check = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    windowsHide: true,
  });
  if (check.error) throw new Error(`Could not run Git patch check: ${check.error.message}`);
  if (check.status !== 0) {
    throw new Error(
      (check.stderr || "").trim() || `Git rejected the patch with exit code ${check.status}.`,
    );
  }
  return check.stdout;
}
const result = preflightPatch(fs.readFileSync(diffPath, "utf8"), run, process.cwd());
const json = `${JSON.stringify(result, null, 2)}\n`;

if (args.out) {
  const outputPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, json);
} else {
  process.stdout.write(json);
}

if (!result.patch.valid) process.exitCode = 2;
