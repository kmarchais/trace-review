#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { errorMessage, parseJson } from "./lib/cli.mjs";
import { detectChangeGroups } from "./lib/change-groups.mjs";
import { parseDetectorRuleSet } from "./lib/repeated-changes.mjs";

type ReviewMode = "workspace" | "lm-analysis" | "deep-audit";

interface Args {
  command?: "quick" | "prepare" | "refine" | "finish";
  repo: string;
  pr: string;
  mode: ReviewMode;
  base?: string;
  revisions?: string[];
  dir?: string;
  input?: string;
  result?: string;
  rules?: string;
  out?: string;
  explicit: boolean;
  open: boolean;
  help?: boolean;
}

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
    preflight: {
      totals: { files: number; additions: number; deletions: number; bytes: number };
    };
    changeGroups: {
      inventory: Array<{ id: string }>;
    };
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
  review?: {
    verdict?: string;
    global?: string;
    findings?: unknown[];
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = (name: string): string => path.join(__dirname, `${name}.mjs`);

function usage(message?: string): never {
  if (message) console.error(`Error: ${message}`);
  console.error(`Usage:
  node trace-review.mjs [quick] [<revision> [<revision>]] [--repo <path>]
    [--base <ref>] [--dir <path>] [--out <review.html>] [--no-open]

  node trace-review.mjs prepare [--repo <path>] [--pr auto|none|<number|url>]
    [--mode workspace|lm-analysis|deep-audit] [--base <ref>] [--dir <path>]
    [--explicit]

  node trace-review.mjs refine --input <analysis-input.json>
    --rules <detector-rules.json>

  node trace-review.mjs finish --input <analysis-input.json>
    --result <review-result.json> [--out <review.html>] [--open]`);
  process.exit(message ? 1 : 0);
}

function normalizeMode(value: string): ReviewMode {
  if (value === "lm" || value === "ai") return "lm-analysis";
  if (value === "workspace" || value === "lm-analysis" || value === "deep-audit") return value;
  usage("--mode must be workspace, lm-analysis, or deep-audit");
}

function parseArgs(argv: readonly string[]): Args {
  const first = argv[0];
  const command =
    first === "quick" || first === "prepare" || first === "refine" || first === "finish"
      ? first
      : "quick";
  const args: Args = {
    command,
    repo: process.cwd(),
    pr: command === "quick" ? "none" : "auto",
    mode: "workspace",
    ...(command === "quick" ? { revisions: [] } : {}),
    explicit: false,
    open: command === "quick",
  };
  const optionStart =
    first === "quick" || first === "prepare" || first === "refine" || first === "finish" ? 1 : 0;
  for (let index = optionStart; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--repo") args.repo = argv[++index];
    else if (arg === "--pr") args.pr = argv[++index];
    else if (arg === "--mode") args.mode = normalizeMode(argv[++index]);
    else if (arg === "--base") args.base = argv[++index];
    else if (arg === "--dir") args.dir = argv[++index];
    else if (arg === "--input") args.input = argv[++index];
    else if (arg === "--result") args.result = argv[++index];
    else if (arg === "--rules") args.rules = argv[++index];
    else if (arg === "--out") args.out = argv[++index];
    else if (arg === "--explicit") args.explicit = true;
    else if (arg === "--open") args.open = true;
    else if (arg === "--no-open") args.open = false;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (args.command === "quick" && !arg.startsWith("-")) args.revisions?.push(arg);
    else usage(`Unknown option: ${arg}`);
  }
  return args;
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

function relative(fromFile: string, target: string): string {
  return path.relative(path.dirname(fromFile), target).replaceAll("\\", "/");
}

function ensureReviewExcluded(repositoryRoot: string, outputDir: string): void {
  if (path.resolve(outputDir) !== path.join(path.resolve(repositoryRoot), ".review")) return;
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

function prepare(args: Args, announceNext = true): void {
  const started = performance.now();
  const repository = path.resolve(args.repo);
  const outputDir = path.resolve(args.dir || path.join(repository, ".review"));
  const contextPath = path.join(outputDir, "context.json");
  const patchPath = path.join(outputDir, "context.patch");
  const filesPath = path.join(outputDir, "context.files.json");
  const inputPath = path.join(outputDir, "analysis-input.json");
  const candidatesPath = path.join(outputDir, "candidates.json");
  const resultPath = path.join(outputDir, "review-result.json");
  const groupsPath = path.join(outputDir, "groups.json");
  const reviewPath = path.join(outputDir, "review.json");
  const specPath = path.join(outputDir, "spec.json");
  const htmlPath = path.join(outputDir, "review.html");
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
  ];
  runScript("collect-pr-context", collectArgs, repository);
  const context = parseJson(fs.readFileSync(contextPath, "utf8")) as {
    repository?: { root?: string };
    changeGroups?: unknown;
  };
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
  const input = parseJson(fs.readFileSync(inputPath, "utf8")) as Record<string, unknown>;
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
      "changeIds",
      "readAfter",
    ],
    guidance:
      "Preserve detector-authored repeated-change units as dedicated mechanical groups. Assign every candidate change ID exactly once. Use change-specific titles grounded in titleEvidence; never reuse classifier labels.",
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
    groups: relative(inputPath, groupsPath),
    review: relative(inputPath, reviewPath),
    spec: relative(inputPath, specPath),
    html: relative(inputPath, htmlPath),
    metrics: relative(inputPath, metricsPath),
  };
  if (args.mode === "workspace") delete input.findingContract;
  writeJson(inputPath, input);

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
  });
  console.log(`Prepared ${prepared.target.title}`);
  console.log(
    `Read ${inputPath} and ${path.resolve(path.dirname(inputPath), prepared.diff.path || "")}`,
  );
  if (announceNext) {
    console.log(`Write one combined result to ${resultPath}`);
    console.log(
      `Then run: node "${path.join(__dirname, "trace-review.mjs")}" finish --input "${inputPath}" --result "${resultPath}" --open`,
    );
  }
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

function quick(args: Args): void {
  if (args.mode !== "workspace") {
    throw new Error(
      "Quick mode supports workspace reviews only; use prepare and finish for LM analysis.",
    );
  }
  prepare(args, false);

  const repository = path.resolve(args.repo);
  const outputDir = path.resolve(args.dir || path.join(repository, ".review"));
  const inputPath = path.join(outputDir, "analysis-input.json");
  const resultPath = path.join(outputDir, "review-result.json");
  const input = parseJson(fs.readFileSync(inputPath, "utf8")) as WorkflowInput;
  const candidatesPath = path.resolve(path.dirname(inputPath), input.workflow.candidates);
  const candidates = parseJson(fs.readFileSync(candidatesPath, "utf8")) as QuickCandidates;
  writeJson(resultPath, quickResult(input, candidates));

  finish({
    ...args,
    command: "finish",
    input: inputPath,
    result: resultPath,
  });
}

function refine(args: Args): void {
  if (!args.input) usage("refine requires --input");
  if (!args.rules) usage("refine requires --rules");
  const inputPath = path.resolve(args.input);
  const rulesPath = path.resolve(args.rules);
  const input = parseJson(fs.readFileSync(inputPath, "utf8")) as WorkflowInput;
  const baseDir = path.dirname(inputPath);
  const resolveArtifact = (artifact: keyof WorkflowInput["workflow"]): string =>
    path.resolve(baseDir, input.workflow[artifact]);
  const ruleSource = fs.readFileSync(rulesPath, "utf8");
  const ruleSet = parseDetectorRuleSet(parseJson(ruleSource));
  const patch = fs.readFileSync(resolveArtifact("patch"), "utf8");
  const contextPath = resolveArtifact("context");
  const context = parseJson(fs.readFileSync(contextPath, "utf8")) as {
    preflight?: Parameters<typeof detectChangeGroups>[1];
    changeGroups?: unknown;
  };
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
  input.groupingContract.guidance =
    "Preserve detector-authored repeated-change units as dedicated mechanical groups. Assign every candidate change ID exactly once and use change-specific titles grounded in titleEvidence.";
  writeJson(inputPath, input);

  const metricsPath = resolveArtifact("metrics");
  let metrics: Record<string, unknown> = {};
  try {
    metrics = parseJson(fs.readFileSync(metricsPath, "utf8")) as Record<string, unknown>;
  } catch {}
  writeJson(metricsPath, {
    ...metrics,
    expectedAgentActions: 7,
    adaptiveDetection: {
      ruleCount: ruleSet.rules.length,
      ruleHash: input.adaptiveDetection.ruleHash,
    },
  });
  console.log(`Refined candidates with ${ruleSet.rules.length} adaptive detector rule(s)`);
  console.log(`Updated ${inputPath}`);
}

function finish(args: Args): void {
  if (!args.input) usage("finish requires --input");
  if (!args.result) usage("finish requires --result");
  const started = performance.now();
  const inputPath = path.resolve(args.input);
  const resultPath = path.resolve(args.result);
  const input = parseJson(fs.readFileSync(inputPath, "utf8")) as WorkflowInput;
  const result = parseJson(fs.readFileSync(resultPath, "utf8")) as CombinedResult;
  if (typeof result.summary !== "string" || !result.summary.trim()) {
    throw new Error("The combined result requires a non-empty summary.");
  }
  if (!Array.isArray(result.groups) || !result.groups.length) {
    throw new Error("The combined result requires semantic groups.");
  }
  const baseDir = path.dirname(inputPath);
  const resolveArtifact = (artifact: keyof WorkflowInput["workflow"]): string =>
    path.resolve(baseDir, input.workflow[artifact]);
  const groupingResultPath = path.join(baseDir, "grouping-result.json");
  writeJson(groupingResultPath, { groups: result.groups });
  runScript(
    "finalize-lm-groups",
    [
      "--candidates",
      resolveArtifact("candidates"),
      "--result",
      groupingResultPath,
      "--out",
      resolveArtifact("groups"),
    ],
    baseDir,
  );
  if (result.groupingProvenance === "deterministic") {
    if (input.mode !== "workspace") {
      throw new Error("Deterministic grouping provenance is valid only in workspace mode.");
    }
    const grouping = parseJson(fs.readFileSync(resolveArtifact("groups"), "utf8")) as Record<
      string,
      unknown
    >;
    grouping.provenance = "deterministic";
    writeJson(resolveArtifact("groups"), grouping);
  }

  let review: unknown;
  let internalCommands = 2;
  if (input.mode !== "workspace") {
    if (!result.review) throw new Error(`${input.mode} requires a review result.`);
    const analysisResultPath = path.join(baseDir, "analysis-result.json");
    writeJson(analysisResultPath, result.review);
    runScript(
      "finalize-lm-analysis",
      ["--input", inputPath, "--result", analysisResultPath, "--out", resolveArtifact("review")],
      baseDir,
    );
    review = parseJson(fs.readFileSync(resolveArtifact("review"), "utf8"));
    internalCommands++;
  } else if (result.review !== undefined) {
    throw new Error("Workspace results must omit review.");
  }

  const target = input.target;
  const prId = target.number ? `pr-${target.number}` : "local";
  const reviewIdentity = (target.repository || "local").replaceAll("/", "-");
  const spec = {
    schemaVersion: 1,
    mode: input.mode,
    title: `Review: ${target.title}`,
    reviewId: target.number
      ? `${reviewIdentity}-pr-${target.number}`
      : `${reviewIdentity}-${target.branch || "local"}`,
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
  const htmlPath = path.resolve(args.out || resolveArtifact("html"));
  let preparedMetrics: Record<string, unknown> = {};
  try {
    preparedMetrics = parseJson(fs.readFileSync(resolveArtifact("metrics"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {}
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

  const buildMetrics = parseJson(fs.readFileSync(resolveArtifact("metrics"), "utf8")) as Record<
    string,
    unknown
  >;
  writeJson(resolveArtifact("metrics"), {
    ...preparedMetrics,
    ...buildMetrics,
    expectedAgentActions: input.adaptiveDetection ? 7 : 5,
    finish: {
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      internalCommands,
    },
  });
  console.log(`Built ${htmlPath}`);
  console.log(`Metrics ${resolveArtifact("metrics")}`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.command) usage();
try {
  if (args.command === "quick") quick(args);
  else if (args.command === "prepare") prepare(args);
  else if (args.command === "refine") refine(args);
  else finish(args);
} catch (error: unknown) {
  console.error(`Error: ${errorMessage(error)}`);
  process.exit(2);
}
