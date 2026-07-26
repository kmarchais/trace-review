import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  version?: unknown;
};
const version = packageJson.version;
const tag = process.argv[2];

if (typeof version !== "string" || !version) {
  console.error("package.json must contain a non-empty version.");
  process.exitCode = 1;
} else if (tag !== `v${version}`) {
  console.error(`Release tag must be v${version}; received ${tag || "(none)"}.`);
  process.exitCode = 1;
} else {
  console.log(`Release tag ${tag} matches package version ${version}.`);
}
