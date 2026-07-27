#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageSkillDistribution } from "./lib/skill-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.resolve(process.argv[2] || path.join(root, "skills", "trace-review"));
const files = stageSkillDistribution({ root, skillRoot });
console.log(`Staged ${files.length} release files in ${skillRoot}.`);
