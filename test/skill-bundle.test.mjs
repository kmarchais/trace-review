import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildSkillBundle,
  listZipEntries,
  readZipEntries,
  SKILL_BUNDLE_FILES,
} from "../scripts/lib/skill-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("minimal skill bundle is complete, runnable, and excludes repository-only files", (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-bundle-test-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const result = buildSkillBundle({ root, outDir });
  const archive = fs.readFileSync(result.archive);
  const expected = SKILL_BUNDLE_FILES.map((file) => `trace-review/${file}`).sort();
  const entries = readZipEntries(archive);

  assert.deepEqual(listZipEntries(archive).sort(), expected);
  for (const relativePath of SKILL_BUNDLE_FILES) {
    assert.deepEqual(
      entries.get(`trace-review/${relativePath}`),
      fs.readFileSync(path.join(root, relativePath)),
      `${relativePath} should round-trip through the archive`,
    );
  }
  assert.ok(archive.length > 0);
  for (const excluded of [
    "README.md",
    "NEXT-WORK.md",
    "package.json",
    "examples/screenshot.png",
    "test/build-review.test.mjs",
    "scripts/build-skill-bundle.mjs",
    "scripts/lib/skill-bundle.mjs",
  ]) {
    assert.ok(!expected.includes(`trace-review/${excluded}`), `${excluded} must stay out of the bundle`);
  }
});
