#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkillBundle } from "./lib/skill-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, process.argv[2] || "dist");

try {
  const result = buildSkillBundle({ root, outDir });
  console.log(`Wrote ${result.archive} (${result.entries.length} files)`);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
