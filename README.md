# Trace Review

> **A review organized by decisions, not files.**

A Codex and [Claude Code](https://claude.com/claude-code) skill that turns a git
diff — your working tree, a branch range, or one/many pull requests — into a
single **self-contained, interactive HTML review document**.

Trace Review follows a change through its definition, usages, configuration,
dependent changes, and tests. The product and skill identifier are
`trace-review`. The GitHub repository is still named `html-review` until its
remote is renamed.

The heavy lifting lives in a template + build script, so generating a review
costs almost no model tokens: diffs are read from files on disk (never echoed
into the conversation), and the agent only authors a short JSON spec.

## Landing page

The static GitHub Pages site lives in [`docs/`](docs/). Configure Pages to
publish from the `main` branch and `/docs` folder.

## What you get

- **Free-form PR summary** (left): description, diagrams (SVG or Mermaid), stat
  tiles, risk tables, callouts — arranged in a resizable panel.
- **Readable diff** (right): language-aware **syntax highlighting** (C/C++/CUDA,
  Python, CMake, TOML, Markdown, JS/TS, Rust, Go, …), unified **or** split view,
  word-level context, per-line and per-file comments, "Viewed" checkboxes, and a
  **fullscreen** mode for focused reading.
- **Optional AI review**: a global assessment plus severity-tagged findings
  anchored to lines, each with Accept / Dismiss / Reply. Attribution is neutral
  ("AI") by default and configurable via `reviewer`.
- **Export**: all comments and review decisions export as clean Markdown to
  paste back into the conversation (or download and have the agent read).
- Light/dark (follows the OS), fully offline except diagrams,
  fonts, and highlighting which load from a CDN (all degrade gracefully).

## Install

Clone into your agent's skills directory:

```bash
# Codex
git clone git@github.com:kmarchais/html-review.git ~/.codex/skills/trace-review

# Claude Code
git clone git@github.com:kmarchais/html-review.git ~/.claude/skills/trace-review
```

Both agents discover the skill as `trace-review`; Claude Code exposes it as
`/trace-review`.

## Requirements

- **Node 18+** — required by the dependency-free collection and build scripts.
- **Git** — required for repository facts and local diffs.
- **GitHub CLI (`gh`)** — optional. Automatic mode warns and falls back to a
  local diff when GitHub context is unavailable. Explicit PR numbers/URLs
  require `gh`.
- **Claude Code or Codex** — needed only to invoke the skill workflow and
  generate AI analysis. The scripts can be run manually without either agent,
  and a generated review works as a standalone HTML file in a modern browser.

## Usage

In Claude Code:

- `/trace-review` — render the diff with empty comment fields (diff-only).
- `/trace-review review` — also generate an AI review (global + line findings).

Or ask in words: *"make an HTML review of this branch"*, *"review PR 123 and add
your findings"*.

Collection is deterministic and happens before review generation:

```bash
# Detect the current branch's PR; fall back to a local diff
node scripts/collect-pr-context.mjs

# Select a PR by number or URL
node scripts/collect-pr-context.mjs --pr 123
node scripts/collect-pr-context.mjs --pr https://github.com/org/repo/pull/123

# Intentionally avoid GitHub and compare against a chosen local base
node scripts/collect-pr-context.mjs --no-remote --base main
```

The command writes `.review/context.json` and `.review/context.patch`. The JSON
contains validated repository/PR facts plus a deterministic preflight
inventory; see [CONTEXT-SCHEMA.md](CONTEXT-SCHEMA.md). Run preflight directly
for any existing patch with:

```bash
node scripts/review-preflight.mjs --diff changes.patch
```

When automatic GitHub collection fails because `gh` is missing, unauthenticated,
or unavailable, the command prints a warning and records
`remote-context-unavailable` in the JSON before continuing locally. It does not
silently claim that the branch has no pull request.

### Under the hood

The agent dumps diffs to `.patch` files, writes a small `spec.json`, and runs:

```bash
node scripts/build-review.mjs --spec spec.json --out review.html --open
```

See [SKILL.md](SKILL.md) for the full spec reference and workflow, and
[examples/review-spec.json](examples/review-spec.json) for a starting template.

## Layout

```
SKILL.md                     agent-facing instructions + spec reference
scripts/build-review.mjs     the build script (spec + diffs -> review.html)
scripts/collect-pr-context.mjs  PR detection + validated local fact pack
scripts/review-preflight.mjs deterministic patch inventory and checks
templates/review.template.html  the static, interactive HTML template
examples/                    example spec + screenshot
```
