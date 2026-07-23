# html-review

A [Claude Code](https://claude.com/claude-code) skill that turns a git diff —
your working tree, a branch range, or one/many pull requests — into a single
**self-contained, interactive HTML review document**.

The heavy lifting lives in a template + build script, so generating a review
costs almost no model tokens: diffs are read from files on disk (never echoed
into the conversation), and the agent only authors a short JSON spec.

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
- Elsyca-branded, light/dark (follows the OS), fully offline except diagrams,
  fonts, and highlighting which load from a CDN (all degrade gracefully).

## Install

Clone into your Claude Code skills directory:

```bash
git clone git@github.com:kmarchais/html-review.git ~/.claude/skills/html-review
```

Claude Code auto-discovers it as the `/html-review` skill.

## Requirements

- **Node 18+** (zero npm dependencies)
- **git** and/or the **GitHub CLI (`gh`)** to produce diffs

## Usage

In Claude Code:

- `/html-review` — render the diff with empty comment fields (diff-only).
- `/html-review review` — also generate an AI review (global + line findings).

Or ask in words: *"make an HTML review of this branch"*, *"review PR 123 and add
your findings"*.

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
templates/review.template.html  the static, interactive HTML template
examples/                    example spec + screenshot
```
