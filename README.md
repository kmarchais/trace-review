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
- **Decision-oriented groups**: deterministic hunk facts feed LM-generated,
  change-specific decisions with intent, evidence, risk, confidence, reviewer
  checks, dependencies, and a validated reading order.
- **File-cohesive grouping**: every file appears once with all of its relevant
  hunks; groups are read-only context so the reviewer evaluates the decisions
  instead of repairing the grouping model.
- **Focused LM analysis**: candidate groups and deterministic facts feed a
  sparse, budgeted set of line findings with confidence and rationale, each
  with Accept / Dismiss / Reply. Attribution is neutral ("LM") by default and
  configurable via `reviewer`.
- **Export**: all comments and review decisions export as clean Markdown to
  paste back into the conversation (or download and have the agent read).
- Elsyca-branded, light/dark (follows the OS), fully offline except diagrams,
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
  generate language-model (LM) analysis. The scripts can be run manually without either agent,
  and a generated review works as a standalone HTML file in a modern browser.

## Usage

In Claude Code:

- `/trace-review` — open the default review workspace without LM findings.
- `/trace-review lm-analysis` — add focused LM analysis (global + line findings).
- Ask for a **deep audit** when a high-risk change warrants broader dependency,
  failure-mode, and test analysis.

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
contains validated repository/PR facts, a deterministic preflight inventory,
and candidate change groups; see [CONTEXT-SCHEMA.md](CONTEXT-SCHEMA.md). Run
group detection directly for any existing patch with:

```bash
node scripts/detect-mechanical-groups.mjs \
  --diff changes.patch --out .review/candidates.json
```

Every textual hunk or metadata-only change must appear exactly once. The
detector rejects overlaps and leaves uncertain work visible as candidate facts.
The skill then asks the LM for change-specific group titles and finalizes them:

```bash
node scripts/finalize-lm-groups.mjs \
  --candidates .review/candidates.json \
  --result .review/grouping-result.json \
  --out .review/groups.json
```

The finalizer rejects generic classifier titles, split files, incomplete
coverage, unsupported title evidence, and invalid prerequisites. Run preflight
directly with:

```bash
node scripts/review-preflight.mjs --diff changes.patch
```

For LM analysis, turn the collected context into the compact analyzer input
instead of handing an agent the raw diff alone:

```bash
node scripts/prepare-lm-analysis.mjs \
  --context .review/context.json --out .review/analysis-input.json

# Deep audit is admitted only for high-risk facts or an explicit request
node scripts/prepare-lm-analysis.mjs \
  --context .review/context.json --mode deep-audit --explicit

# Validate the sparse result and convert it to a review-spec review object
node scripts/finalize-lm-analysis.mjs \
  --input .review/analysis-input.json \
  --result .review/analysis-result.json \
  --out .review/review.json
```

When automatic GitHub collection fails because `gh` is missing, unauthenticated,
or unavailable, the command prints a warning and records
`remote-context-unavailable` in the JSON before continuing locally. It does not
silently claim that the branch has no pull request.

### Under the hood

The agent dumps diffs to `.patch` files, writes a small `spec.json`, and runs:

```bash
node scripts/validate-review-spec.mjs --spec spec.json
node scripts/build-review.mjs --spec spec.json --out review.html --open
```

Every spec declares `schemaVersion: 1` and one of `workspace`, `lm-analysis`,
or `deep-audit`. Generation reports invalid fields with JSON paths and
corrective hints before writing HTML. See [REVIEW-SPEC.md](REVIEW-SPEC.md),
[SKILL.md](SKILL.md), and
[examples/review-spec.json](examples/review-spec.json) for a starting template.

## Quality checks

```bash
npm test
```

The dependency-free suite covers collection and preflight, review-spec
validation, small and large generation, HTML landmarks, the checked-in visual
contract, C++, CMake, renames, binaries, generated files, groups, and LM
comments.

## Layout

```
SKILL.md                     agent-facing instructions + spec reference
scripts/build-review.mjs     the build script (spec + diffs -> review.html)
scripts/collect-pr-context.mjs  PR detection + validated local fact pack
scripts/review-preflight.mjs deterministic patch inventory and checks
scripts/validate-review-spec.mjs  versioned review-spec validation
scripts/detect-mechanical-groups.mjs  hunk groups, dependencies, and reading order
scripts/prepare-lm-analysis.mjs  compact facts, risk gate, and finding budget
scripts/finalize-lm-analysis.mjs  validate findings and emit review-spec content
templates/review.template.html  the static, interactive HTML template
examples/                    example spec + screenshot
test/fixtures/               patch, spec, and visual-contract fixtures
```
