#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { analysisResultToReview } from "./lib/lm-analysis.mjs";

function usage(message) {
  if (message) console.error(`Error: ${message}`);
  console.error(`Usage:
  node finalize-lm-analysis.mjs --input <analysis-input.json>
    --result <analysis-result.json> [--out <review.json>]`);
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--input") args.input = argv[++index];
    else if (arg === "--result") args.result = argv[++index];
    else if (arg === "--out") args.out = argv[++index];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else usage(`Unknown option: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) usage();
if (!args.input) usage("--input requires a value");
if (!args.result) usage("--result requires a value");
if (process.argv.includes("--out") && !args.out) usage("--out requires a value");

try {
  const inputPath = path.resolve(args.input);
  const resultPath = path.resolve(args.result);
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const review = analysisResultToReview(result, input);
  const outputPath = path.resolve(
    args.out || path.join(path.dirname(resultPath), "review.json"),
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outputPath}`);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(2);
}
