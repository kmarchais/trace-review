# Trace Review

> **Review more code with fewer LM tokens.**

Trace Review turns a working-tree diff, branch range, or pull request into a
self-contained interactive HTML review.

Its goal is simple: keep large diffs out of the conversation, give the language
model compact evidence, and preserve a polished review interface in every mode.

The product and skill identifier are `trace-review`. The GitHub repository is
still named `html-review` until its remote is renamed.

## How it saves tokens

Collection, validation, diff parsing, syntax rendering, comment persistence,
and HTML generation happen in local scripts. The LM does not need to reproduce
the patch or author the interface.

```text
git / GitHub
    ↓ deterministic collection
context.json + context.patch
    ↓ compact facts and bounded candidate groups
LM grouping or analysis result
    ↓ deterministic validation
groups.json + review-spec.json
    ↓ local HTML builder
review.html
```

The patch stays in files on disk. The LM writes only the small semantic result
needed by the selected mode, while the same template renders the full diff and
review controls.

Use `--metrics-out .review/metrics.json` to record patch size, estimated spec
tokens, estimated avoided-patch tokens, generation time, and manual quality
measurements.

See [real pull request measurement](docs/REAL-PR-METRICS.md) for the measurement
contract and its limits.

## Proof: an LM result becomes a full review

The checked-in [C++ reference review](examples/cpp-reference/README.md) is a
reproducible example, not a hand-written mock-up.

The LM produces
[`grouping-result.json`](examples/cpp-reference/grouping-result.json). One group
looks like this:

```json
{
  "title": "Capped exponential backoff behavior",
  "kind": "feature",
  "intent": "Review the exponential delay calculation and its 30-second ceiling as one behavioral decision.",
  "risk": "medium",
  "confidence": 0.96,
  "evidence": [
    "The implementation doubles the base delay by attempt and caps the result at 30 seconds."
  ],
  "changeIds": [
    "src/retry_policy.cpp#h0",
    "src/retry_policy.cpp#h1",
    "src/retry_policy.cpp#h2",
    "src/retry_policy.cpp#h3"
  ]
}
```

The finalizer checks coverage, evidence, titles, and dependencies before writing
[`groups.json`](examples/cpp-reference/groups.json).

The compact
[`review-spec.json`](examples/cpp-reference/review-spec.json) adds the summary
and one actionable LM finding.

The local builder combines those small files with
[`changes.patch`](examples/cpp-reference/changes.patch) to render the complete
interface below.

## One interface, three review modes

| Mode | LM work | Result |
|------|---------|--------|
| `workspace` | No automatic findings | Diff, context, groups, and reviewer-authored comments |
| `lm-analysis` | Sparse, budgeted findings from compact facts | Global assessment plus high-confidence line findings |
| `deep-audit` | Broader analysis for explicit or high-risk reviews | Dependency, failure-mode, and test analysis |

Every mode uses the same GitHub-inspired light/dark interface, unified and split
diffs, file navigation, progress tracking, comments, and Markdown export.

![Current Trace Review interface](examples/screenshot.png)

## What the interface provides

- **PR context** with prose, stats, tables, callouts, and SVG or Mermaid
  diagrams in a resizable panel.
- **Readable diffs** with syntax highlighting, unified or split mode, word-level
  context, file comments, line comments, viewed state, and fullscreen mode.
- **Decision-oriented groups** with intent, evidence, risk, confidence,
  reviewer checks, dependencies, and a validated reading order.
- **Focused LM findings** with confidence, rationale, and
  Accept/Dismiss/Reply controls.
- **Stable review state** with diff fingerprints, orphan recovery, and browser
  localStorage persistence.
- **Clean export** of reviewer comments and LM decisions as Markdown.
- **Large-review controls** with bounded word comparison and progressive
  rendering.

The interface uses system fonts and works offline. Mermaid diagrams and hosted
syntax colors need network access but degrade gracefully.

## Install

Clone the repository into the skills directory used by your agent host:

```bash
# Codex
git clone git@github.com:kmarchais/html-review.git ~/.codex/skills/trace-review

# Claude Code
git clone git@github.com:kmarchais/html-review.git ~/.claude/skills/trace-review
```

Both hosts discover the skill as `trace-review`. Claude Code exposes it as
`/trace-review`.

## Requirements

- **Node 18+** for the dependency-free collection and build scripts.
- **Git** for repository facts and local diffs.
- **GitHub CLI (`gh`)** for pull-request context. Automatic mode falls back to a
  local diff when GitHub is unavailable.
- **Claude Code or Codex** only when invoking the skill or requesting LM
  grouping and analysis.

The scripts can run manually without an agent host. A generated review is a
standalone HTML file that opens in a modern browser.

Before team adoption, record repository-specific
[risk rules, test conventions, and generated-file guidance](docs/REPOSITORY-CONFIGURATION.md).

## Usage

In Claude Code:

- `/trace-review` opens a workspace without automatic LM findings.
- `/trace-review lm-analysis` adds a focused assessment and line findings.
- Ask for a **deep audit** when a high-risk change warrants broader analysis.

You can also ask in words: *“make an HTML review of this branch”* or
*“review PR 123 and add findings.”*

### Collect deterministic context

```bash
# Detect the current branch's PR; fall back to a local diff
node scripts/collect-pr-context.mjs

# Select a PR by number or URL
node scripts/collect-pr-context.mjs --pr 123
node scripts/collect-pr-context.mjs --pr https://github.com/org/repo/pull/123

# Stay local and compare against a chosen base
node scripts/collect-pr-context.mjs --no-remote --base main
```

Collection writes `.review/context.json` and `.review/context.patch`. See
[CONTEXT-SCHEMA.md](CONTEXT-SCHEMA.md) for the validated fact-pack contract.

### Produce and validate semantic groups

```bash
node scripts/detect-mechanical-groups.mjs \
  --diff changes.patch \
  --out .review/candidates.json

node scripts/finalize-lm-groups.mjs \
  --candidates .review/candidates.json \
  --result .review/grouping-result.json \
  --out .review/groups.json
```

Every textual hunk or metadata-only change must appear exactly once. The
finalizer rejects overlaps, incomplete coverage, generic titles, unsupported
evidence, and invalid prerequisites.

Run deterministic preflight directly with:

```bash
node scripts/review-preflight.mjs --diff changes.patch
```

### Add focused LM analysis

```bash
node scripts/prepare-lm-analysis.mjs \
  --context .review/context.json \
  --out .review/analysis-input.json

# Deep audit requires high-risk facts or an explicit request
node scripts/prepare-lm-analysis.mjs \
  --context .review/context.json \
  --mode deep-audit \
  --explicit

node scripts/finalize-lm-analysis.mjs \
  --input .review/analysis-input.json \
  --result .review/analysis-result.json \
  --out .review/review.json
```

The preparation step gives the LM compact deterministic facts and a
fact-derived finding budget instead of treating the raw diff as an unbounded
prompt.

### Build the HTML review

```bash
node scripts/validate-review-spec.mjs --spec spec.json
node scripts/build-review.mjs --spec spec.json --out review.html --open
```

Every spec declares `schemaVersion: 1` and one of `workspace`, `lm-analysis`, or
`deep-audit`.

Invalid fields are reported with JSON paths and corrective hints before any HTML
is written. See [REVIEW-SPEC.md](REVIEW-SPEC.md), [SKILL.md](SKILL.md), and the
[starter spec](examples/review-spec.json).

When GitHub collection fails, the collector records
`remote-context-unavailable` and continues locally. It never silently claims
that the branch has no pull request.

## Operational boundaries

Read [known limitations and offline behavior](docs/LIMITATIONS.md) before
distribution.

Generated reviews keep the diff, groups, comments, progress, and export
available offline. Hosted syntax colors and Mermaid diagrams degrade
gracefully when the network is unavailable.

## Quality checks

```bash
npm test
npm run validate:example
npm run validate:reference
npm run build:reference
```

The dependency-free suite covers collection, preflight, schema validation,
large diffs, malicious content, comment recovery, progressive rendering,
accessibility tokens, C++, CMake, renames, binaries, groups, and LM findings.

Release candidates must also pass the
[automated, accessibility, performance, and manual interface criteria](docs/RELEASE-CHECKLIST.md).

## Repository layout

```text
SKILL.md                         agent workflow and spec reference
scripts/collect-pr-context.mjs   deterministic repository and PR facts
scripts/prepare-lm-analysis.mjs  compact facts, risk gate, finding budget
scripts/finalize-lm-analysis.mjs validate LM findings
scripts/build-review.mjs         spec + patch → review.html
templates/review.template.html   self-contained interactive interface
examples/cpp-reference/          reproducible proof fixture
docs/                            adoption, limitations, and metrics
test/                            deterministic and visual-contract tests
```
