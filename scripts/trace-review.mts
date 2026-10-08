#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { errorMessage, parseJson } from "./lib/cli.mjs";
import { parseCliArgs, UsageError, type CliArgs } from "./lib/cli-args.mjs";
import { detectChangeGroups, type ChangeGrouping } from "./lib/change-groups.mjs";
import { DiagnosticError } from "./lib/diagnostics.mjs";
import { loadSchema, stripNulls, validateJsonSchema } from "./lib/json-schema.mjs";
import { analysisResultToReview, type AnalysisInput } from "./lib/lm-analysis.mjs";
import { composeProviderPrompt, writeLmBundle, type LmBundle } from "./lib/lm-bundle.mjs";
import { finalizeLmGrouping } from "./lib/lm-groups.mjs";
import { runReviewLoop, type AttemptRecord } from "./lib/lm-loop.mjs";
import {
  createProvider,
  detectProvider,
  ProviderError,
  resolveExecutable,
  type Provider,
  type ProviderName,
} from "./lib/llm.mjs";
import type { PatchAnalysis } from "./lib/preflight.mjs";
import { parseDetectorRuleSet } from "./lib/repeated-changes.mjs";
import {
  DETECTOR_RULES_SCHEMA,
  validateReviewResult,
  type ReviewMode,
} from "./lib/review-result.mjs";
import { feedbackReport, locateStateDocument, ReviewStateStore } from "./lib/review-state.mjs";
import { openUrlInBrowser, startReviewServer } from "./lib/serve.mjs";
import { AskRunner, createFakeAskProvider } from "./lib/serve-ask.mjs";

interface WorkflowInput {
  schemaVersion: 1;
  mode: ReviewMode;
  target: {
    repository: string;
    branch: string;
    headSha: string;
    number: number | null;
    url: string;
    title: string;
    description: string;
  };
  diff: { path?: string; source?: string; bytes: number };
  facts: {
    preflight: PatchAnalysis;
    changeGroups: ChangeGrouping;
  };
  findingContract?: { maxFindings: number };
  groupingContract: {
    required: string[];
    guidance: string;
  };
  resultContract: {
    path: string;
    reviewRequired: boolean;
    guidance: string;
  };
  workflow: {
    context: string;
    patch: string;
    fileContents: string;
    candidates: string;
    groups: string;
    review: string;
    spec: string;
    html: string;
    metrics: string;
    lm?: string;
  };
  adaptiveDetection?: {
    rules: string;
    ruleHash: string;
    ruleCount: number;
  };
}

interface CombinedResult {
  summary?: string;
  groups?: unknown[];
  groupingProvenance?: "deterministic";
  review?: unknown;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = (name: string): string => path.join(__dirname, `${name}.mjs`);
const SELF = path.join(__dirname, "trace-review.mjs");

const USAGE = `Usage:
  trace-review [<target>] [--lm | --deep-audit] [--llm claude|codex|none]
    [--model <id>] [--max-retries <n>] [--timeout <seconds>] [--language <name>]
    [--repo <path>] [--dir <path>] [--out <review.html>] [--no-open]
    [--serve [--port <n>] [--host 127.0.0.1|localhost|::1]] [-- <pathspec>...]
  trace-review serve [<target>] [same options]

  Targets:  (none)           working tree versus the index
            --cached         staged changes (alias --staged), optionally versus <rev>
            <rev> [<rev>]    one or two revisions
            <a>..<b>, <a>...<b>  two-dot or merge-base range
            pr <n>, #<n>, <GitHub PR URL>  a pull request

  Without --lm the review is deterministic and needs no model. With --lm or
  --deep-audit, the selected CLI writes the review result (default: claude,
  then codex, from PATH); --llm none prepares .review/lm/ for an agent.

  serve keeps reviewer state in .review/state/, rebuilds the page when
  .review/lm/result.json or .review/spec.json changes, and answers questions
  about selected lines with the --llm provider. Stop it with Ctrl+C.

  trace-review feedback [<reviewId> | --latest] [--json] [--dir <path>]
    prints the reviewer's saved comments for the agent to act on.

  trace-review prepare [--repo <path>] [--pr auto|none|<number|url>]
    [--mode workspace|lm-analysis|deep-audit] [--base <ref>] [--dir <path>] [--explicit]
  trace-review refine --input <analysis-input.json> --rules <detector-rules.json>
  trace-review finish --input <analysis-input.json> --result <result.json> [--out <file>]
    [--overwrite] [--open]`;

function usage(message?: string): never {
  if (message) console.error(`Error: ${message}`);
  console.error(USAGE);
  process.exit(message ? 1 : 0);
}

function runScript(name: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(process.execPath, [SCRIPT(name), ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 100 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${name} failed${detail ? `: ${detail}` : ""}`);
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(file: string): T {
  return parseJson(fs.readFileSync(file, "utf8")) as T;
}

function relative(fromFile: string, target: string): string {
  return path.relative(path.dirname(fromFile), target).replaceAll("\\", "/");
}

function reviewFileName(input: Pick<WorkflowInput, "mode" | "target">): string {
  const target = input.target.number
    ? `pr-${input.target.number}-${input.target.title}`
    : input.target.title || input.target.branch || "local-changes";
  const slug =
    target
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/g, "") || "local-changes";
  const mode = input.mode === "workspace" ? "" : `${input.mode}-`;
  return `review-${mode}${slug}.html`;
}

function existingReviewFiles(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".html"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function reserveUniqueReviewPath(preferredPath: string): {
  path: string;
  existing: string[];
} {
  const directory = path.dirname(preferredPath);
  const extension = path.extname(preferredPath) || ".html";
  const stem = path.basename(preferredPath, path.extname(preferredPath));
  fs.mkdirSync(directory, { recursive: true });
  const existing = existingReviewFiles(directory);
  for (let suffix = 1; ; suffix++) {
    const candidate = path.join(
      directory,
      suffix === 1 ? `${stem}${extension}` : `${stem}-${suffix}${extension}`,
    );
    try {
      const descriptor = fs.openSync(candidate, "wx");
      fs.closeSync(descriptor);
      return { path: candidate, existing };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

// git reports the canonical root while outputDir follows --repo, so compare real
// paths (macOS /private/var, Windows 8.3 names, symlinked checkouts).
function samePath(left: string, right: string): boolean {
  const canonical = (value: string): string => {
    const resolved = path.resolve(value);
    let real = resolved;
    try {
      real = fs.realpathSync.native(resolved);
    } catch {
      try {
        real = path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
      } catch {}
    }
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return canonical(left) === canonical(right);
}

function ensureReviewExcluded(repositoryRoot: string, outputDir: string): void {
  if (!samePath(outputDir, path.join(repositoryRoot, ".review"))) return;
  // Leave the exclude file alone when .gitignore (or anything else) already ignores it.
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--", ".review/"], {
    cwd: repositoryRoot,
    windowsHide: true,
  });
  if (ignored.status === 0) return;
  const result = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return;
  const reported = String(result.stdout || "").trim();
  if (!reported) return;
  const excludePath = path.isAbsolute(reported) ? reported : path.resolve(repositoryRoot, reported);
  let current = "";
  try {
    current = fs.readFileSync(excludePath, "utf8");
  } catch {}
  if (current.split(/\r?\n/).some((line) => line.trim() === ".review/")) return;
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(excludePath, `${prefix}.review/\n`, "utf8");
}

function artifactResolver(inputPath: string, input: WorkflowInput) {
  const baseDir = path.dirname(inputPath);
  return (artifact: keyof WorkflowInput["workflow"]): string =>
    path.resolve(baseDir, input.workflow[artifact] || "");
}

function readMetrics(file: string): Record<string, unknown> {
  try {
    return readJson<Record<string, unknown>>(file);
  } catch {
    return {};
  }
}

/** Write .review/lm/ for model-authored modes; returns null in workspace mode. */
function writeBundle(inputPath: string, language?: string, reuseLanguage = false): LmBundle | null {
  const input = readJson<WorkflowInput>(inputPath);
  if (input.mode === "workspace" || !input.findingContract) return null;
  const resolve = artifactResolver(inputPath, input);
  const context = readJson<{ preflight: PatchAnalysis; pullRequest?: unknown }>(resolve("context"));
  // Keep the prepare-time --language so refine regenerates the same prompt.
  const languagePath = path.join(resolve("lm"), "language.txt");
  if (language?.trim()) {
    fs.mkdirSync(path.dirname(languagePath), { recursive: true });
    fs.writeFileSync(languagePath, `${language.trim()}\n`, "utf8");
  } else if (reuseLanguage) {
    try {
      language = fs.readFileSync(languagePath, "utf8").trim() || undefined;
    } catch {}
  } else {
    fs.rmSync(languagePath, { force: true });
  }
  return writeLmBundle({
    dir: resolve("lm"),
    mode: input.mode,
    input: input as unknown as AnalysisInput,
    candidates: readJson<ChangeGrouping>(resolve("candidates")),
    patch: fs.readFileSync(resolve("patch"), "utf8"),
    preflight: context.preflight,
    pullRequest: (context.pullRequest || null) as Parameters<
      typeof writeLmBundle
    >[0]["pullRequest"],
    language,
  });
}

function prepare(args: CliArgs, announceNext = true): string {
  const started = performance.now();
  const repository = path.resolve(args.repo);
  const outputDir = path.resolve(args.dir || path.join(repository, ".review"));
  const contextPath = path.join(outputDir, "context.json");
  const patchPath = path.join(outputDir, "context.patch");
  const filesPath = path.join(outputDir, "context.files.json");
  const inputPath = path.join(outputDir, "analysis-input.json");
  const candidatesPath = path.join(outputDir, "candidates.json");
  const resultPath = path.join(outputDir, "review-result.json");
  const metricsPath = path.join(outputDir, "run-metrics.json");

  const collectArgs = [
    "--repo",
    repository,
    "--pr",
    args.pr,
    "--out",
    contextPath,
    "--diff-out",
    patchPath,
    "--files-out",
    filesPath,
    ...(args.base ? ["--base", args.base] : []),
    ...(args.revisions !== undefined
      ? ["--git-diff", ...args.revisions.flatMap((revision) => ["--revision", revision])]
      : []),
    ...(args.cached ? ["--cached"] : []),
    ...(args.pathspecs.length ? ["--", ...args.pathspecs] : []),
  ];
  runScript("collect-pr-context", collectArgs, repository);
  const context = readJson<{ repository?: { root?: string }; changeGroups?: unknown }>(contextPath);
  writeJson(candidatesPath, context.changeGroups);
  ensureReviewExcluded(context.repository?.root || repository, outputDir);

  runScript(
    "prepare-lm-analysis",
    [
      "--context",
      contextPath,
      "--mode",
      args.mode === "deep-audit" ? "deep-audit" : "lm-analysis",
      "--out",
      inputPath,
      ...(args.explicit ? ["--explicit"] : []),
    ],
    repository,
  );
  const input = readJson<Record<string, unknown>>(inputPath);
  input.mode = args.mode;
  input.groupingContract = {
    required: [
      "title",
      "intent",
      "risk",
      "confidence",
      "evidence",
      "reviewerChecks",
      "titleEvidence",
      "from or changeIds",
    ],
    guidance:
      "Reference candidate groups with from and move single changes with changeIds; unassigned changes are auto-placed in their candidate group. Keep repeated-change units in dedicated groups. Use change-specific titles grounded in titleEvidence.",
  };
  input.resultContract = {
    path: relative(inputPath, resultPath),
    reviewRequired: args.mode !== "workspace",
    guidance:
      args.mode === "workspace"
        ? "Write summary and groups. Omit review."
        : "Write summary, groups, and one review object with verdict, global, and findings.",
  };
  input.workflow = {
    context: relative(inputPath, contextPath),
    patch: relative(inputPath, patchPath),
    fileContents: relative(inputPath, filesPath),
    candidates: relative(inputPath, candidatesPath),
    groups: relative(inputPath, path.join(outputDir, "groups.json")),
    review: relative(inputPath, path.join(outputDir, "review.json")),
    spec: relative(inputPath, path.join(outputDir, "spec.json")),
    html: relative(
      inputPath,
      path.join(outputDir, reviewFileName(input as unknown as WorkflowInput)),
    ),
    metrics: relative(inputPath, metricsPath),
    lm: relative(inputPath, path.join(outputDir, "lm")),
  };
  if (args.mode === "workspace") delete input.findingContract;
  writeJson(inputPath, input);
  const bundle = writeBundle(inputPath, args.language);

  const prepared = input as unknown as WorkflowInput;
  writeJson(metricsPath, {
    schemaVersion: 1,
    mode: args.mode,
    expectedAgentActions: 5,
    prepare: {
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      internalCommands: 3,
    },
    facts: prepared.facts.preflight.totals,
    ...(bundle ? { bundle: bundleSizes(bundle) } : {}),
  });
  console.log(`Prepared ${prepared.target.title}`);
  if (announceNext) {
    if (bundle) {
      console.log(`Read ${bundle.prompt}, ${bundle.input}, and ${bundle.patch}`);
      console.log(`Write one result matching ${bundle.schema} to ${bundle.result}`);
      console.log(
        `Then run: node "${SELF}" finish --input "${inputPath}" --result "${bundle.result}" --open`,
      );
    } else {
      console.log(`Read ${inputPath} and ${patchPath}`);
      console.log(`Write one combined result to ${resultPath}`);
      console.log(
        `Then run: node "${SELF}" finish --input "${inputPath}" --result "${resultPath}" --open`,
      );
    }
  }
  return inputPath;
}

function bundleSizes(bundle: LmBundle): Record<string, number> {
  const size = (file: string): number => fs.statSync(file).size;
  return {
    inputBytes: size(bundle.input),
    patchBytes: size(bundle.patch),
    promptBytes: size(bundle.prompt),
    schemaBytes: size(bundle.schema),
  };
}

interface QuickCandidateGroup {
  title?: string;
  kind?: string;
  intent?: string;
  risk?: string;
  confidence?: number;
  evidence?: string[];
  reviewerChecks?: string[];
  changes?: Array<{ id: string; file: string }>;
}

interface QuickCandidates {
  groups?: QuickCandidateGroup[];
  inventory?: Array<{ id: string; file: string }>;
}

function quickResult(input: WorkflowInput, candidates: QuickCandidates): CombinedResult {
  const inventory = candidates.inventory || [];
  if (!inventory.length) {
    throw new Error("No tracked changes were found relative to the selected base.");
  }

  const groups = (candidates.groups || [])
    .map((group) => {
      const changes = group.changes || [];
      const changeIds = changes.map((change) => change.id);
      if (!changeIds.length) return undefined;
      const files = [...new Set(changes.map((change) => change.file))];
      const scope =
        files.length === 1 ? files[0] : `${files[0]} and ${files.length - 1} other files`;
      const classification = String(group.title || "changes").toLowerCase();
      return {
        title: `${scope}: ${classification}`,
        kind: group.kind || "other",
        intent: group.intent || "Review these related working-tree changes together.",
        risk: group.risk || "medium",
        confidence: group.confidence ?? 1,
        evidence:
          group.evidence && group.evidence.length > 0
            ? group.evidence
            : [`The deterministic classifier grouped ${changeIds.length} change units.`],
        reviewerChecks:
          group.reviewerChecks && group.reviewerChecks.length > 0
            ? group.reviewerChecks
            : ["Confirm the changes have the intended behavior."],
        titleEvidence: {
          changeIds: [changeIds[0]],
          rationale: `The cited change grounds this group in ${scope}.`,
        },
        changeIds,
        readAfter: [],
      };
    })
    .filter((group): group is NonNullable<typeof group> => group !== undefined);

  const totals = input.facts.preflight.totals;
  return {
    summary:
      `Automatically prepared workspace review of ${totals.files} changed ` +
      `file${totals.files === 1 ? "" : "s"} (+${totals.additions}/-${totals.deletions}).`,
    groups,
    groupingProvenance: "deterministic",
  };
}

interface ReviewOutcome {
  inputPath: string;
  /** The built page; null while an agent still has to write the result. */
  htmlPath: string | null;
}

function quick(args: CliArgs): ReviewOutcome {
  const inputPath = prepare(args, false);
  const input = readJson<WorkflowInput>(inputPath);
  const resultPath = path.join(path.dirname(inputPath), "review-result.json");
  const candidates = readJson<QuickCandidates>(artifactResolver(inputPath, input)("candidates"));
  writeJson(resultPath, quickResult(input, candidates));
  const htmlPath = finish({ ...args, command: "finish", input: inputPath, result: resultPath });
  return { inputPath, htmlPath };
}

async function review(args: CliArgs): Promise<ReviewOutcome> {
  if (args.mode === "workspace") return quick(args);
  const provider: ProviderName | null =
    args.llm === "none" ? null : args.llm === "auto" ? detectProvider() : args.llm;
  if (args.llm === "auto" && !provider) {
    console.warn("No claude or codex CLI was found on PATH; preparing the bundle for an agent.");
  }
  const inputPath = prepare(args, !provider);
  if (!provider) return { inputPath, htmlPath: null };

  const input = readJson<WorkflowInput>(inputPath);
  const resolve = artifactResolver(inputPath, input);
  const bundle = writeBundle(inputPath, args.language);
  if (!bundle) throw new Error("The LM bundle was not prepared.");
  const repository = readJson<{ repository?: { root?: string } }>(resolve("context")).repository
    ?.root;
  const cwd = repository || path.resolve(args.repo);
  if (input.target.number != null && input.target.headSha) {
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    if (String(head.stdout || "").trim() !== input.target.headSha) {
      console.warn(
        `The checkout at ${cwd} is not the PR head (${input.target.headSha.slice(0, 12)}); the model may read stale surrounding code.`,
      );
    }
  }
  const candidates = readJson<ChangeGrouping>(resolve("candidates"));
  const patch = fs.readFileSync(resolve("patch"), "utf8");
  const started = performance.now();
  let loop: Awaited<ReturnType<typeof runReviewLoop>>;
  try {
    loop = await runReviewLoop({
      provider: createProvider(provider),
      request: {
        repo: cwd,
        schemaPath: bundle.strictSchema,
        timeoutMs: args.timeoutMs,
        ...(args.model ? { model: args.model } : {}),
      },
      prompt: composeProviderPrompt(bundle, cwd),
      dir: bundle.dir,
      maxRetries: args.maxRetries,
      validate: (value) =>
        validateReviewResult(value, {
          mode: input.mode,
          candidates,
          analysisInput: input as unknown as AnalysisInput,
          patch,
        }),
      log: (message) => console.log(message),
    });
  } catch (error: unknown) {
    if (error instanceof ProviderError) {
      throw new Error(
        `${error.message}\nThe bundle is ready in ${bundle.dir}; write ${bundle.result} yourself and run: node "${SELF}" finish --input "${inputPath}" --result "${bundle.result}"`,
        { cause: error },
      );
    }
    throw error;
  }
  const llmMetrics = summarizeAttempts(provider, args.model, loop.attempts, started);
  const metricsPath = resolve("metrics");
  writeJson(metricsPath, { ...readMetrics(metricsPath), llm: llmMetrics });
  if (!loop.valid) {
    throw new DiagnosticError(
      `${provider} did not produce a valid result after ${loop.attempts.length} attempt(s); attempts are in ${bundle.dir}. Fix ${bundle.result} and run finish:`,
      loop.diagnostics,
    );
  }
  writeJson(bundle.result, stripNulls(loop.value));
  console.log(`Wrote ${bundle.result}`);
  const htmlPath = finish(
    { ...args, command: "finish", input: inputPath, result: bundle.result },
    llmMetrics,
  );
  return { inputPath, htmlPath };
}

function summarizeAttempts(
  provider: string,
  model: string | undefined,
  attempts: readonly AttemptRecord[],
  started: number,
): Record<string, unknown> {
  const sum = (pick: (attempt: AttemptRecord) => number | undefined): number | undefined => {
    const values = attempts.map(pick).filter((value): value is number => value !== undefined);
    return values.length ? values.reduce((left, right) => left + right, 0) : undefined;
  };
  const costUsd = sum((attempt) => attempt.costUsd);
  return {
    provider,
    ...(model ? { model } : {}),
    attempts: attempts.map((attempt) => ({
      attempt: attempt.attempt,
      durationMs: attempt.durationMs,
      valid: attempt.valid,
      diagnostics: attempt.diagnostics.length,
      ...(attempt.usage ? { usage: attempt.usage } : {}),
      ...(attempt.costUsd !== undefined ? { costUsd: attempt.costUsd } : {}),
      ...(attempt.error ? { error: attempt.error } : {}),
    })),
    durationMs: Math.round(performance.now() - started),
    inputTokens: sum((attempt) => attempt.usage?.inputTokens),
    outputTokens: sum((attempt) => attempt.usage?.outputTokens),
    ...(costUsd !== undefined ? { costUsd: Math.round(costUsd * 1e6) / 1e6 } : {}),
  };
}

function refine(args: CliArgs): void {
  if (!args.input) usage("refine requires --input");
  if (!args.rules) usage("refine requires --rules");
  const inputPath = path.resolve(args.input);
  const rulesPath = path.resolve(args.rules);
  const input = readJson<WorkflowInput>(inputPath);
  const resolveArtifact = artifactResolver(inputPath, input);
  const ruleSource = fs.readFileSync(rulesPath, "utf8");
  const rules = parseJson(ruleSource);
  const schemaDiagnostics = validateJsonSchema(loadSchema(DETECTOR_RULES_SCHEMA), rules);
  if (schemaDiagnostics.length) {
    throw new DiagnosticError("Invalid detector rules:", schemaDiagnostics);
  }
  const ruleSet = parseDetectorRuleSet(rules);
  const patch = fs.readFileSync(resolveArtifact("patch"), "utf8");
  const contextPath = resolveArtifact("context");
  const context = readJson<{
    preflight?: Parameters<typeof detectChangeGroups>[1];
    changeGroups?: unknown;
  }>(contextPath);
  const changeGroups = detectChangeGroups(patch, context.preflight, {
    detectorRules: ruleSet.rules,
  });
  context.changeGroups = changeGroups;
  writeJson(contextPath, context);
  writeJson(resolveArtifact("candidates"), changeGroups);
  input.facts.changeGroups = changeGroups;
  input.adaptiveDetection = {
    rules: relative(inputPath, rulesPath),
    ruleHash: createHash("sha256").update(ruleSource).digest("hex"),
    ruleCount: ruleSet.rules.length,
  };
  writeJson(inputPath, input);
  if (input.workflow.lm) writeBundle(inputPath, args.language, true);

  const metricsPath = resolveArtifact("metrics");
  writeJson(metricsPath, {
    ...readMetrics(metricsPath),
    expectedAgentActions: 7,
    adaptiveDetection: {
      ruleCount: ruleSet.rules.length,
      ruleHash: input.adaptiveDetection.ruleHash,
    },
  });
  console.log(`Refined candidates with ${ruleSet.rules.length} adaptive detector rule(s)`);
  console.log(`Updated ${inputPath}`);
}

// Review IDs key browser storage, so they must change whenever the compared
// commits change; working-tree and staged reviews get their own marker.
function reviewContentKey(contextPath: string, fallbackHeadSha: string): string {
  let context: {
    source?: string;
    git?: { baseSha?: string; baseRef?: string; headSha?: string; headRef?: string };
    pullRequest?: { baseSha?: string; headSha?: string } | null;
  } = {};
  try {
    context = readJson<typeof context>(contextPath);
  } catch {}
  const github = context.source === "github";
  // A PR's baseSha is the moving tip of its base branch, so PRs are keyed on the
  // head alone; otherwise each merge into the base would drop draft comments.
  const baseSha = github ? "" : context.git?.baseSha || context.git?.baseRef || "";
  const headSha = github
    ? context.pullRequest?.headSha || fallbackHeadSha
    : context.git?.headSha || fallbackHeadSha;
  const headRef = context.git?.headRef;
  const marker = github
    ? "commit"
    : !headRef || headRef === "WORKTREE"
      ? "worktree"
      : headRef === "INDEX"
        ? "index"
        : "commit";
  return createHash("sha256")
    .update([baseSha, headSha, marker].join("\0"))
    .digest("hex")
    .slice(0, 12);
}

function finish(args: CliArgs, llmMetrics?: Record<string, unknown>): string {
  if (!args.input) usage("finish requires --input");
  if (!args.result) usage("finish requires --result");
  const started = performance.now();
  const inputPath = path.resolve(args.input);
  const resultPath = path.resolve(args.result);
  const input = readJson<WorkflowInput>(inputPath);
  const raw = readJson<unknown>(resultPath);
  const baseDir = path.dirname(inputPath);
  const resolveArtifact = artifactResolver(inputPath, input);
  const candidates = readJson<ChangeGrouping>(resolveArtifact("candidates"));
  const patch = fs.readFileSync(resolveArtifact("patch"), "utf8");
  const analysisInput = input as unknown as AnalysisInput;
  const validation = validateReviewResult(raw, {
    mode: input.mode,
    candidates,
    analysisInput,
    patch,
  });
  if (!validation.valid || !validation.resolved) {
    throw new DiagnosticError(`Invalid result ${resultPath}:`, validation.diagnostics);
  }
  const result = validation.resolved;
  const grouping: Record<string, unknown> = { ...finalizeLmGrouping(result, candidates) };
  if (result.groupingProvenance === "deterministic") grouping.provenance = "deterministic";
  if (result.autoPlaced.length) {
    grouping.placement = { autoPlaced: result.autoPlaced };
    console.warn(
      `Auto-placed ${result.autoPlaced.length} unassigned change(s) into their candidate groups.`,
    );
  }
  writeJson(resolveArtifact("groups"), grouping);

  let review: unknown;
  if (input.mode !== "workspace") {
    if (!result.review) throw new Error(`${input.mode} requires a review result.`);
    review = analysisResultToReview(result.review, analysisInput, { patch });
    writeJson(resolveArtifact("review"), review);
  }

  const target = input.target;
  const prId = target.number ? `pr-${target.number}` : "local";
  const reviewIdentity = (target.repository || "local").replaceAll("/", "-");
  const spec = {
    schemaVersion: 1,
    mode: input.mode,
    title: `Review: ${target.title}`,
    reviewId: `${
      target.number
        ? `${reviewIdentity}-pr-${target.number}`
        : `${reviewIdentity}-${target.branch || "local"}`
    }-${reviewContentKey(resolveArtifact("context"), target.headSha)}`,
    prs: [
      {
        id: prId,
        title: target.title,
        ...(target.url ? { url: target.url } : {}),
        summary: result.summary,
        ...(target.number && target.repository && target.headSha
          ? {
              github: {
                repository: target.repository,
                pullRequest: target.number,
                headSha: target.headSha,
              },
            }
          : {}),
        diffFile: relative(resolveArtifact("spec"), resolveArtifact("patch")),
        fileContentsFile: relative(resolveArtifact("spec"), resolveArtifact("fileContents")),
        groupFile: relative(resolveArtifact("spec"), resolveArtifact("groups")),
        ...(review ? { review } : {}),
      },
    ],
  };
  writeJson(resolveArtifact("spec"), spec);
  const preferredHtmlPath = path.resolve(args.out || path.join(baseDir, reviewFileName(input)));
  let htmlPath = preferredHtmlPath;
  if (args.overwrite) {
    if (!args.out) usage("--overwrite requires --out");
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  } else {
    const reservation = reserveUniqueReviewPath(preferredHtmlPath);
    htmlPath = reservation.path;
    console.log(
      reservation.existing.length
        ? `Existing review files: ${reservation.existing.join(", ")}`
        : "Existing review files: none",
    );
    console.log(`Reserved review output: ${htmlPath}`);
  }
  const preparedMetrics = readMetrics(resolveArtifact("metrics"));
  try {
    runScript(
      "build-review",
      [
        "--spec",
        resolveArtifact("spec"),
        "--out",
        htmlPath,
        "--metrics-out",
        resolveArtifact("metrics"),
        ...(args.open ? ["--open"] : []),
      ],
      baseDir,
    );
  } catch (error: unknown) {
    try {
      if (!args.overwrite && fs.statSync(htmlPath).size === 0) fs.unlinkSync(htmlPath);
    } catch {}
    throw error;
  }

  const buildMetrics = readMetrics(resolveArtifact("metrics"));
  writeJson(resolveArtifact("metrics"), {
    ...preparedMetrics,
    ...buildMetrics,
    expectedAgentActions: input.adaptiveDetection ? 7 : 5,
    ...(llmMetrics ? { llm: llmMetrics } : {}),
    ...(result.autoPlaced.length ? { autoPlacedChanges: result.autoPlaced.length } : {}),
    finish: {
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      internalCommands: 1,
    },
  });
  console.log(`Built ${htmlPath}`);
  console.log(`Metrics ${resolveArtifact("metrics")}`);
  return htmlPath;
}

/** Run one of the packaged scripts without blocking the server's event loop. */
function runScriptAsync(script: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `exit ${status}`).trim()));
    });
  });
}

function askProvider(args: CliArgs): Provider | null {
  if (process.env.TRACE_REVIEW_FAKE_LLM === "1") return createFakeAskProvider();
  if (args.llm === "none") return null;
  const name = args.llm === "auto" ? detectProvider() : args.llm;
  if (!name) return null;
  try {
    if (!resolveExecutable(name)) return null;
  } catch {
    return null;
  }
  return createProvider(name);
}

async function serve(args: CliArgs): Promise<void> {
  const outcome = await review({ ...args, open: false });
  const inputPath = outcome.inputPath;
  const input = readJson<WorkflowInput>(inputPath);
  const resolve = artifactResolver(inputPath, input);
  const reviewDir = path.dirname(inputPath);
  const specPath = resolve("spec");
  const lmResult = path.join(
    input.workflow.lm ? resolve("lm") : path.join(reviewDir, "lm"),
    "result.json",
  );
  const repository =
    readJson<{ repository?: { root?: string } }>(resolve("context")).repository?.root ||
    path.resolve(args.repo);
  let htmlPath = outcome.htmlPath;

  const rebuild = async (changed: string[]): Promise<{ htmlPath?: string }> => {
    if (changed.includes(lmResult)) {
      const finishArgs = ["finish", "--input", inputPath, "--result", lmResult];
      const stdout = await runScriptAsync(
        SELF,
        htmlPath ? [...finishArgs, "--out", htmlPath, "--overwrite"] : finishArgs,
        reviewDir,
      );
      htmlPath = /^Built (.+)$/m.exec(stdout)?.[1]?.trim() || htmlPath;
      return htmlPath ? { htmlPath } : {};
    }
    if (!htmlPath) {
      htmlPath = reserveUniqueReviewPath(path.join(reviewDir, reviewFileName(input))).path;
    }
    await runScriptAsync(
      SCRIPT("build-review"),
      ["--spec", specPath, "--out", htmlPath],
      reviewDir,
    );
    return { htmlPath };
  };

  const provider = askProvider(args);
  const server = await startReviewServer({
    reviewDir,
    specPath,
    htmlPath,
    host: args.host,
    ...(args.port !== undefined ? { port: args.port } : {}),
    ask: new AskRunner({
      provider,
      repo: repository,
      workDir: path.join(reviewDir, "state", "ask"),
      timeoutMs: Math.min(args.timeoutMs, 5 * 60 * 1000),
      ...(args.model ? { model: args.model } : {}),
    }),
    // `finish` rewrites spec.json from the result; that is not a new change.
    watch: { files: [lmResult, specPath], outputs: [specPath], rebuild },
    log: (message) => console.log(message),
  });
  console.log(`Serving ${input.target.title} at ${server.url}`);
  console.log(`Open ${server.openUrl}`);
  console.log(
    provider
      ? `Questions about selected lines use ${provider.name}.`
      : "Questions about selected lines are off (no claude or codex CLI; pass --llm).",
  );
  console.log(`Reviewer feedback: node "${SELF}" feedback --latest`);
  console.log("Press Ctrl+C to stop.");
  if (args.open) openUrlInBrowser(server.openUrl);
  await new Promise<void>((done) => {
    process.once("SIGINT", () => done());
    process.once("SIGTERM", () => done());
  });
  await server.close();
  console.log("Stopped the review server.");
  process.exit(0);
}

function reviewDirectory(args: CliArgs): string {
  if (args.dir) return path.resolve(args.dir);
  const local = path.join(path.resolve(args.repo), ".review");
  if (fs.existsSync(local)) return local;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: path.resolve(args.repo),
    encoding: "utf8",
    windowsHide: true,
  });
  const root = top.status === 0 ? String(top.stdout).trim() : "";
  return root ? path.join(root, ".review") : local;
}

function feedback(args: CliArgs): void {
  const store = new ReviewStateStore(path.join(reviewDirectory(args), "state"));
  const document = locateStateDocument(store, args.reviewId);
  if (!document) {
    throw new Error(
      args.reviewId
        ? `No saved state for review '${args.reviewId}' in ${store.root}.`
        : `No served review state in ${store.root}. Start one with: trace-review serve`,
    );
  }
  const report = feedbackReport(store, document);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `Review ${report.reviewId} · revision ${report.revision}${report.updatedAt ? ` · updated ${report.updatedAt}` : ""}`,
  );
  console.log(`Images: ${report.attachmentsDir}\n`);
  process.stdout.write(report.markdown);
}

let args: CliArgs;
try {
  args = parseCliArgs(process.argv.slice(2));
} catch (error: unknown) {
  if (error instanceof UsageError) usage(error.message);
  throw error;
}
if (args.help) usage();
try {
  if (args.command === "review" && args.serve) await serve(args);
  else if (args.command === "review") await review(args);
  else if (args.command === "feedback") feedback(args);
  else if (args.command === "prepare") prepare(args);
  else if (args.command === "refine") refine(args);
  else finish(args);
} catch (error: unknown) {
  console.error(`Error: ${errorMessage(error)}`);
  process.exit(2);
}
