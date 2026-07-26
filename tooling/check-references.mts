import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([
  ".git",
  ".playwright-cli",
  ".review",
  "dist",
  "node_modules",
  "output",
  "skills",
]);
const ignoredFiles = new Set(["review-smoke.html", "review.html"]);
const referenceExtensions = new Set([".html", ".md"]);
const errors: string[] = [];

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) return [];
    if (entry.isFile() && ignoredFiles.has(entry.name)) return [];
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

function relative(file: string): string {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function localTarget(rawTarget: string): string | null {
  const target = rawTarget.trim().split(/\s+/u)[0];
  if (
    !target ||
    target.startsWith("#") ||
    target.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/iu.test(target)
  ) {
    return null;
  }
  const withoutFragment = target.split("#", 1)[0]?.split("?", 1)[0];
  if (!withoutFragment) return null;
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

function checkReference(source: string, rawTarget: string): void {
  const target = localTarget(rawTarget);
  if (!target) return;
  const resolved = target.startsWith("/")
    ? path.join(root, target.slice(1))
    : path.resolve(path.dirname(source), target);
  if (!fs.existsSync(resolved)) {
    errors.push(`${relative(source)} references missing path '${target}'`);
  }
}

const files = walk(root);
for (const file of files.filter((candidate) => referenceExtensions.has(path.extname(candidate)))) {
  const content = fs.readFileSync(file, "utf8");
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    if (match[1]) checkReference(file, match[1]);
  }
  for (const match of content.matchAll(/\b(?:href|src|srcset)="([^"]+)"/gu)) {
    if (match[1]) checkReference(file, match[1]);
  }
  const installedSkillContract =
    path.basename(file) === "SKILL.md" || relative(file) === "SKILL.source.md";
  if (!installedSkillContract && /\bnode\s+scripts\/\S+\.mjs\b/u.test(content)) {
    errors.push(`${relative(file)} invokes a removed JavaScript source path`);
  }
  if (!installedSkillContract && /\bnpm\s+(?:install|run|test)\b/u.test(content)) {
    errors.push(`${relative(file)} still documents npm instead of Bun`);
  }
}

const imageHashes = new Map<string, string>();
for (const file of files.filter((candidate) => path.extname(candidate).toLowerCase() === ".png")) {
  const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const duplicate = imageHashes.get(hash);
  if (duplicate) {
    errors.push(`${relative(file)} duplicates ${relative(duplicate)}`);
  } else {
    imageHashes.set(hash, file);
  }
}

if (errors.length > 0) {
  console.error(`Reference check failed:\n- ${errors.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("Repository links, commands, and image assets are consistent.");
}
