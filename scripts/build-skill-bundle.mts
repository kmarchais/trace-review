#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkillBundle } from "./lib/skill-bundle.mjs";
import { errorMessage } from "./lib/cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, process.argv[2] || "dist");

try {
  const result = buildSkillBundle({ root, outDir });
  console.log(`Wrote ${result.archive} (${result.entries.length} files)`);
} catch (error: unknown) {
  console.error(`Error: ${errorMessage(error)}`);
  process.exitCode = 1;
}
