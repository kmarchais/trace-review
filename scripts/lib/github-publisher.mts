// The GitHub CLI implementation of GithubPublisher, shared by the publisher
// command and the review server. `gh` keeps the credentials; nothing here
// reads or returns a token.

import { spawn, spawnSync } from "node:child_process";
import type {
  GithubPublicationContext,
  GithubPublisher,
  GithubReviewRequest,
} from "./github-review.mjs";

export interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Runs `gh` with an argument array (no shell) and optional standard input. */
export type GhRunner = (args: readonly string[], input?: string) => GhResult | Promise<GhResult>;

export const defaultGhRunner: GhRunner = (args, input) => {
  const result = spawnSync("gh", [...args], {
    encoding: "utf8",
    input,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    ...(result.error ? { error: result.error } : {}),
  };
};

/**
 * An asynchronous runner for long-lived processes such as the review server:
 * it never blocks the event loop and kills `gh` once `timeoutMs` has passed.
 */
export function asyncGhRunner(
  options: { timeoutMs?: number; command?: string; prefixArgs?: readonly string[] } = {},
): GhRunner {
  const { timeoutMs = 120_000, command = "gh", prefixArgs = [] } = options;
  return (args, input) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: GhResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const child = spawn(command, [...prefixArgs, ...args], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        child.kill();
        finish({
          status: null,
          stdout,
          stderr,
          error: new Error(`gh did not finish within ${Math.round(timeoutMs / 1000)} s.`),
        });
      }, timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (error) => finish({ status: null, stdout, stderr, error }));
      child.on("close", (status) => finish({ status, stdout, stderr }));
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
    });
}

export function createGhPublisher(run: GhRunner = defaultGhRunner): GithubPublisher {
  const gh = async (args: readonly string[], input?: string): Promise<string> => {
    const result = await run(args, input);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `gh exited ${result.status}`).trim());
    }
    return result.stdout.trim();
  };
  return {
    async isAuthenticated(): Promise<boolean> {
      const result = await run(["auth", "status", "--hostname", "github.com"]);
      return !result.error && result.status === 0;
    },
    async currentHead(target: GithubPublicationContext): Promise<string> {
      return gh([
        "api",
        `repos/${target.repository}/pulls/${target.pullRequest}`,
        "--jq",
        ".head.sha",
      ]);
    },
    async createReview(
      target: GithubPublicationContext,
      request: GithubReviewRequest,
    ): Promise<{ url?: string }> {
      const url = await gh(
        [
          "api",
          "--method",
          "POST",
          `repos/${target.repository}/pulls/${target.pullRequest}/reviews`,
          "--input",
          "-",
          "--jq",
          ".html_url",
        ],
        JSON.stringify(request),
      );
      return url ? { url } : {};
    },
  };
}
