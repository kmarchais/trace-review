// Argument parsing for trace-review. The default command reviews one target:
// the working tree, staged changes, revisions or ranges, or a pull request.
// `serve` (or --serve) runs the same review behind a local server, and
// `feedback` prints the reviewer's saved comments for the agent.

import type { ReviewMode } from "./review-result.mjs";

export type Command = "review" | "prepare" | "refine" | "finish" | "feedback";
export type LlmChoice = "auto" | "claude" | "codex" | "none";

export interface CliArgs {
  command: Command;
  repo: string;
  /** PR selector: a number or URL for the review command; auto|none|<n|url> for prepare. */
  pr: string;
  revisions?: string[];
  cached: boolean;
  pathspecs: string[];
  mode: ReviewMode;
  explicit: boolean;
  llm: LlmChoice;
  model?: string;
  maxRetries: number;
  timeoutMs: number;
  language?: string;
  base?: string;
  dir?: string;
  input?: string;
  result?: string;
  rules?: string;
  out?: string;
  open: boolean;
  help: boolean;
  /** Serve the review over a loopback HTTP server instead of only writing HTML. */
  serve: boolean;
  host: string;
  port?: number;
  /** finish: replace --out instead of reserving a new file name (used by serve rebuilds). */
  overwrite: boolean;
  /** feedback: the review ID to print; the most recent review when omitted. */
  reviewId?: string;
  json: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const COMMANDS = new Set(["quick", "review", "serve", "prepare", "refine", "finish", "feedback"]);
const PR_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?:[/?#].*)?$/;

function normalizeMode(value: string): ReviewMode {
  if (value === "lm" || value === "ai") return "lm-analysis";
  if (value === "workspace" || value === "lm-analysis" || value === "deep-audit") return value;
  throw new UsageError("--mode must be workspace, lm-analysis, or deep-audit");
}

function prSelector(value: string): string {
  const selector = value.replace(/^#/, "");
  if (/^[1-9]\d*$/.test(selector) || PR_URL_RE.test(value)) return selector;
  throw new UsageError(`'${value}' is not a pull-request number or GitHub pull-request URL.`);
}

export function parseCliArgs(argv: readonly string[], cwd = process.cwd()): CliArgs {
  const first = argv[0];
  const named = first !== undefined && COMMANDS.has(first);
  const command: Command =
    !named || first === "quick" || first === "serve" ? "review" : (first as Command);
  const args: CliArgs = {
    command,
    repo: cwd,
    pr: command === "prepare" ? "auto" : "none",
    cached: false,
    pathspecs: [],
    mode: "workspace",
    explicit: false,
    llm: "auto",
    maxRetries: 2,
    timeoutMs: 15 * 60 * 1000,
    open: command === "review",
    help: false,
    serve: first === "serve",
    host: "127.0.0.1",
    overwrite: false,
    json: false,
  };
  const positionals: string[] = [];
  const value = (index: number, option: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--"))
      throw new UsageError(`${option} requires a value`);
    return next;
  };
  for (let index = named ? 1 : 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      args.pathspecs.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--repo") args.repo = value(index++, arg);
    else if (arg === "--pr") args.pr = value(index++, arg);
    else if (arg === "--mode") args.mode = normalizeMode(value(index++, arg));
    else if (arg === "--lm" || arg === "--ai") args.mode = "lm-analysis";
    else if (arg === "--deep-audit") {
      args.mode = "deep-audit";
      args.explicit = true;
    } else if (arg === "--llm") {
      const choice = value(index++, arg);
      if (!["auto", "claude", "codex", "none"].includes(choice)) {
        throw new UsageError("--llm must be claude, codex, none, or auto");
      }
      args.llm = choice as LlmChoice;
    } else if (arg === "--model") args.model = value(index++, arg);
    else if (arg === "--max-retries") {
      const retries = Number(value(index++, arg));
      if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
        throw new UsageError("--max-retries must be an integer from 0 to 10");
      }
      args.maxRetries = retries;
    } else if (arg === "--timeout") {
      const seconds = Number(value(index++, arg));
      if (!Number.isFinite(seconds) || seconds <= 0)
        throw new UsageError("--timeout must be positive seconds");
      args.timeoutMs = Math.round(seconds * 1000);
    } else if (arg === "--language") args.language = value(index++, arg);
    else if (arg === "--cached" || arg === "--staged") args.cached = true;
    else if (arg === "--base") args.base = value(index++, arg);
    else if (arg === "--dir") args.dir = value(index++, arg);
    else if (arg === "--input") args.input = value(index++, arg);
    else if (arg === "--result") args.result = value(index++, arg);
    else if (arg === "--rules") args.rules = value(index++, arg);
    else if (arg === "--out") args.out = value(index++, arg);
    else if (arg === "--explicit") args.explicit = true;
    else if (arg === "--open") args.open = true;
    else if (arg === "--no-open") args.open = false;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--serve") args.serve = true;
    else if (arg === "--host") args.host = value(index++, arg);
    else if (arg === "--port") {
      const port = Number(value(index++, arg));
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new UsageError("--port must be an integer from 0 to 65535");
      }
      args.port = port;
    } else if (arg === "--overwrite") args.overwrite = true;
    else if (arg === "--latest") args.reviewId = undefined;
    else if (arg === "--json") args.json = true;
    else if ((command === "review" || command === "feedback") && !arg.startsWith("-"))
      positionals.push(arg);
    else throw new UsageError(`Unknown option: ${arg}`);
  }

  if (command === "feedback") {
    if (positionals.length > 1) throw new UsageError("feedback accepts at most one review ID");
    if (positionals.length && argv.includes("--latest")) {
      throw new UsageError("Use either a review ID or --latest");
    }
    args.reviewId = positionals[0];
    return args;
  }
  if (args.serve && command !== "review") {
    throw new UsageError("--serve applies to the review command only");
  }

  if (command !== "review") {
    if (args.cached || args.pathspecs.length) {
      throw new UsageError("--cached and pathspecs apply to the review command only");
    }
    return args;
  }

  const revisions: string[] = [];
  for (let index = 0; index < positionals.length; index++) {
    const token = positionals[index];
    if (token === "pr") {
      const selector = positionals[index + 1];
      if (selector === undefined) throw new UsageError("pr requires a number or URL");
      args.pr = prSelector(selector);
      index++;
    } else if (/^#\d+$/.test(token) || PR_URL_RE.test(token)) {
      args.pr = prSelector(token);
    } else {
      revisions.push(token);
    }
  }
  const pullRequest = args.pr !== "none";
  if (pullRequest) {
    if (revisions.length || args.cached || args.pathspecs.length) {
      throw new UsageError(
        "A pull-request target cannot be combined with revisions, --cached, or pathspecs",
      );
    }
    if (args.base) throw new UsageError("--base does not apply to a pull-request target");
  } else {
    if (revisions.length > 2) throw new UsageError("At most two revisions can be compared");
    if (args.cached && (revisions.length > 1 || revisions.some((rev) => rev.includes("..")))) {
      throw new UsageError("--cached accepts at most one revision and no range");
    }
    if (revisions.length === 2 && revisions.some((rev) => rev.includes(".."))) {
      throw new UsageError("Use either a range or two revisions, not both");
    }
    args.revisions = revisions;
  }
  return args;
}
