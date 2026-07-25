#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { prepareAnalysisInput } from "./lib/lm-analysis.mjs";

function usage(message) {
  if (message) console.error(`Error: ${message}`);
  console.error(`Usage:
  node prepare-lm-analysis.mjs --context <context.json>
    [--mode lm-analysis|deep-audit] [--explicit] [--out <analysis-input.json>]

Options:
  --mode lm-analysis  Prepare focused language-model analysis (default).
  --mode deep-audit   Prepare a deep audit for a high-risk fact pack.
  --explicit          Confirm the user explicitly requested deep audit.`);
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const args = { mode: "lm-analysis", explicit: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--context") args.context = argv[++index];
    else if (arg === "--mode") args.mode = argv[++index];
    else if (arg === "--out") args.out = argv[++index];
    else if (arg === "--explicit") args.explicit = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else usage(`Unknown option: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) usage();
if (!args.context) usage("--context requires a value");
if (!args.mode) usage("--mode requires a value");
if (process.argv.includes("--out") && !args.out) usage("--out requires a value");

try {
  const contextPath = path.resolve(args.context);
  const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
  if (context.validation?.valid === false) {
    throw new Error("The collected context is invalid; fix its diagnostics before analysis.");
  }
  const outputPath = path.resolve(
    args.out || path.join(path.dirname(contextPath), "analysis-input.json"),
  );
  const diffPath =
    context.diff && typeof context.diff === "object" && context.diff.path
      ? path
          .relative(
            path.dirname(outputPath),
            path.resolve(path.dirname(contextPath), context.diff.path),
          )
          .replaceAll("\\", "/")
      : undefined;
  const input = prepareAnalysisInput(context, {
    mode: args.mode,
    explicitDeepAudit: args.explicit,
    diffPath,
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outputPath}`);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
