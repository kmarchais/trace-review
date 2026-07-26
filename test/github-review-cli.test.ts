import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const publisher = path.join(root, "dist", "runtime", "scripts", "publish-github-review.mjs");

test("publisher command previews and submits one confirmed GitHub review", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-publish-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const planPath = path.join(tempDir, "review.json");
  const logPath = path.join(tempDir, "request.json");
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      schemaVersion: 1,
      target: {
        repository: "acme/widgets",
        pullRequest: 42,
        headSha: "abc123",
        url: "https://github.com/acme/widgets/pull/42",
      },
      summary: "Overall review.",
      nativeComments: [
        {
          path: "src/widget.ts",
          body: "Handle the empty case.",
          side: "RIGHT",
          line: 18,
        },
      ],
      fallbackComments: [
        {
          kind: "file",
          path: "src/widget.ts",
          location: "src/widget.ts",
          body: "Use a smaller interface.",
          reason: "file comments do not have a diff anchor",
        },
      ],
    }),
  );
  const fake = path.join(tempDir, "fake-gh.mjs");
  fs.writeFileSync(
    fake,
    `import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "auth") process.exit(0);
if (args.includes("--method") && args.includes("POST")) {
  fs.writeFileSync(process.env.FAKE_GH_LOG, fs.readFileSync(0, "utf8"));
  console.log("https://github.com/acme/widgets/pull/42#pullrequestreview-1");
  process.exit(0);
}
if (args[0] === "api" && args.includes("--jq")) {
  console.log("abc123");
  process.exit(0);
}
console.error("unexpected gh args", args);
process.exit(1);
`,
  );
  const unixLauncher = path.join(tempDir, "gh");
  fs.writeFileSync(unixLauncher, `#!/bin/sh\nexec node "$(dirname "$0")/fake-gh.mjs" "$@"\n`);
  fs.chmodSync(unixLauncher, 0o755);
  fs.writeFileSync(path.join(tempDir, "gh.cmd"), '@echo off\r\nnode "%~dp0fake-gh.mjs" %*\r\n');

  const result = spawnSync(process.execPath, [publisher, "--plan", planPath, "--confirm"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH || ""}`,
      FAKE_GH_LOG: logPath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Native threads: 1/);
  assert.match(result.stdout, /Summary fallbacks: 1/);
  assert.match(result.stdout, /Published 1 native thread with 1 summary fallback/);
  const request = JSON.parse(fs.readFileSync(logPath, "utf8"));
  assert.equal(request.commit_id, "abc123");
  assert.equal(request.event, "COMMENT");
  assert.equal(request.comments[0].path, "src/widget.ts");
  assert.match(request.body, /Use a smaller interface/);
  assert.doesNotMatch(request.body, /Handle the empty case/);
});
