#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { analyzePatch } from "./lib/preflight.mjs";
import { detectChangeGroups } from "./lib/change-groups.mjs";
import { parseDetectorRuleSet } from "./lib/repeated-changes.mjs";
import { errorMessage, parseJson } from "./lib/cli.mjs";
function usage(message) {
    if (message)
        console.error(`Error: ${message}`);
    console.error("Usage: node scripts/detect-mechanical-groups.mjs --diff <patch> [--rules <rules.json>] [--out <groups.json>]");
    process.exit(message ? 1 : 0);
}
const args = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--diff")
        args.diff = argv[++index];
    else if (arg === "--out")
        args.out = argv[++index];
    else if (arg === "--rules")
        args.rules = argv[++index];
    else if (arg === "--help" || arg === "-h")
        args.help = true;
    else
        usage(`Unknown option: ${arg}`);
}
if (args.help)
    usage();
if (!args.diff)
    usage("--diff requires a value");
try {
    const diffPath = path.resolve(args.diff);
    const patch = fs.readFileSync(diffPath, "utf8");
    const detectorRules = args.rules
        ? parseDetectorRuleSet(parseJson(fs.readFileSync(path.resolve(args.rules), "utf8"))).rules
        : [];
    const grouping = detectChangeGroups(patch, analyzePatch(patch), { detectorRules });
    const output = `${JSON.stringify(grouping, null, 2)}\n`;
    if (args.out) {
        const outputPath = path.resolve(args.out);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, output, "utf8");
        console.log(`Wrote ${outputPath}`);
    }
    else {
        process.stdout.write(output);
    }
    if (!grouping.validation.valid)
        process.exitCode = 2;
}
catch (error) {
    console.error(`Error: ${errorMessage(error)}`);
    process.exit(1);
}
