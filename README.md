# Trace Review

> **Review more code with fewer LM tokens.**

Trace Review turns a working-tree diff, branch range, or pull request into a self-contained
interactive HTML review.

Local scripts collect facts, parse diffs, validate LM output, and build the interface. The LM
receives compact evidence and writes only the semantic result needed by the selected review mode.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="examples/screenshot-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="examples/screenshot.png">
  <img alt="Trace Review showing pull-request context, LM findings, and a code diff" src="examples/screenshot.png">
</picture>

## How it works

```text
git diff
  → deterministic context and candidate groups
  → compact LM grouping or analysis result
  → validated groups and review spec
  → local review.html
```

The patch stays on disk instead of being reproduced in the conversation. Every mode uses the same
GitHub-inspired light/dark interface, diff controls, comments, review progress, and Markdown export.

| Mode          | LM usage                                           |
| ------------- | -------------------------------------------------- |
| `workspace`   | No automatic findings                              |
| `lm-analysis` | Sparse, budgeted findings from compact facts       |
| `deep-audit`  | Broader analysis for explicit or high-risk reviews |

## Proof

The reproducible [C++ reference review](examples/cpp-reference/README.md) includes the patch,
deterministic candidates, LM output, validated groups, and final review spec.

For example, the LM-generated [`grouping-result.json`](examples/cpp-reference/grouping-result.json)
contains:

```json
{
  "title": "Capped exponential backoff behavior",
  "intent": "Review the exponential delay calculation and its 30-second ceiling as one behavioral decision.",
  "confidence": 0.96,
  "changeIds": [
    "src/retry_policy.cpp#h0",
    "src/retry_policy.cpp#h1",
    "src/retry_policy.cpp#h2",
    "src/retry_policy.cpp#h3"
  ]
}
```

Use `--metrics-out .review/metrics.json` to estimate spec tokens and avoided patch tokens. See
[the metrics contract](docs/REAL-PR-METRICS.md).

## Install

Requires Node 18+, Git, and optionally GitHub CLI for pull-request context.

Download
[`trace-review-skill.zip`](https://github.com/kmarchais/trace-review/releases/latest/download/trace-review-skill.zip)
and extract it directly into one of these skill directories:

```bash
# Codex:       ~/.codex/skills/
# Claude Code: ~/.claude/skills/
```

The archive creates the `trace-review/` directory and contains only runtime scripts, the template,
schema, operational references, and a compact example.

## Use

- `/trace-review` opens the workspace without automatic LM findings.
- `/trace-review lm-analysis` adds focused LM findings.
- Ask for a **deep audit** when broader high-risk analysis is warranted.
- Or ask your agent to review a branch or pull request with Trace Review.

The release scripts also run directly:

```bash
node scripts/collect-pr-context.mjs
node scripts/validate-review-spec.mjs --spec spec.json
node scripts/build-review.mjs --spec spec.json --out review.html --open
```

See [SKILL.md](SKILL.md) for the workflow, [REVIEW-SPEC.md](REVIEW-SPEC.md) for the schema, and
[docs/LIMITATIONS.md](docs/LIMITATIONS.md) for operational boundaries.

## Develop

The repository uses strict TypeScript, Bun, ESLint, and Prettier. The release bundle contains
compiled, Node 18-compatible JavaScript, so installing the skill does not require Bun.

```bash
bun install
bun run check
bun run bundle:skill
```
