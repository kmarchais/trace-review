#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { formatReviewSpecDiagnostics, validateReviewSpec } from "./lib/review-spec.mjs";

function usage() {
  console.error("Usage: node validate-review-spec.mjs --spec <spec.json> [--json]");
}

const args = process.argv.slice(2);
const specIndex = args.indexOf("--spec");
if (specIndex === -1 || !args[specIndex + 1]) {
  usage();
  process.exit(1);
}

const specPath = path.resolve(args[specIndex + 1]);
let spec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
} catch (error) {
  const result = {
    valid: false,
    schemaVersion: null,
    diagnostics: [{
      level: "error",
      code: "invalid-json",
      path: "$",
      message: `Could not read review specification: ${error.message}`,
    }],
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(2);
}

const validation = validateReviewSpec(spec, {
  baseDir: path.dirname(specPath),
  checkFiles: true,
});
if (args.includes("--json") || validation.valid) {
  console.log(JSON.stringify(validation, null, 2));
} else {
  console.error(formatReviewSpecDiagnostics(validation));
}
process.exit(validation.valid ? 0 : 2);
