#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSkillDistribution, syncSkillDistribution } from "./lib/skill-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

if (check) {
  const diff = inspectSkillDistribution({ root });
  const problems = [
    ...diff.missing.map((file) => `missing: ${file}`),
    ...diff.changed.map((file) => `changed: ${file}`),
    ...diff.unexpected.map((file) => `unexpected: ${file}`),
  ];
  if (problems.length > 0) {
    console.error(
      `Installable skill distribution is stale. Run 'bun run sync:skill'.\n- ${problems.join("\n- ")}`,
    );
    process.exitCode = 1;
  } else {
    console.log("Installable skill distribution matches its source and compiled runtime.");
  }
} else {
  const files = syncSkillDistribution({ root });
  console.log(`Synchronized skills/trace-review (${files.length} files).`);
}
