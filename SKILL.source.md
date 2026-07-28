---
name: trace-review
description: Generate an interactive HTML code-review document from a git diff or one or more pull requests. Use when asked to review changes, do a code review, produce a review doc, review a diff/branch/PR, or collect review comments. Renders a concise summary, optional diagrams, a readable word-level diff, and per-line comment fields that export back into the conversation.
---

# Trace Review

Turns a diff (working tree, a branch range, or one/many PRs) into a single
**self-contained interactive HTML file**: a free-form PR summary, optional
diagrams, a comprehensible word-level diff (unified/split), and comment boxes
on every line + an overall box. The reviewer's comments export as clean
markdown that gets pasted (or read from a file) back into this conversation.

The heavy lifting lives in a **template + build script** so you spend almost no
tokens: diffs are read from files on disk (never echoed into chat), and you
only author a short JSON spec.

**Do NOT hand-write HTML.** Always build it through `trace-review.mjs finish`.

## Three explicit modes

| Mode | What you do | Result |
|------|-------------|--------|
| **Workspace** (default) | Set top-level `"mode": "workspace"` and omit every `review` object. | The reviewer reads the facts and diff and writes their own comments. |
| **LM analysis** (on request) | Set `"mode": "lm-analysis"` and emit a `review` object for every PR. | Adds sparse language-model findings: a global assessment plus severity-tagged, line-anchored comments. |
| **Deep audit** (explicit/high-risk only) | Set `"mode": "deep-audit"` after the user requests or accepts deeper analysis. | Uses the same finding contract after broader dependency, failure-mode, and test analysis. |

Default is **workspace**. Normalize invocation shortcuts before starting:

- `lm`, `ai`, and `lm-analysis` select LM analysis.
- `pr <number>` and `pr #<number>` select that pull request in the current
  repository.
- Shortcuts compose in any order: `lm pr 8`, `pr 8 ai`, and `pr #8 lm` all
  select PR 8 with LM analysis.

Keep canonical values internally: write `"mode": "lm-analysis"` and pass only
the number to `--pr`. A PR shortcut without `lm` or `ai` stays in workspace
mode. Invoking `/trace-review` (or `… no-review`) also stays in workspace mode.
Deep audit is never silently selected. See
[REVIEW-SPEC.md](REVIEW-SPEC.md) for the versioned contract.

Paths below are relative to the installed `trace-review/` skill directory. Run
commands from any working directory; pass absolute paths for
`--spec`/`--out` when in doubt.

## Prerequisites

- **Node 22+** (`node --version`) — required; no npm install, zero dependencies.
- **Git** — required for repository facts and local diffs.
- **`gh`** — optional in automatic/local mode and required for explicit PR
  selection. If it is missing, unauthenticated, or unavailable, automatic mode
  emits a warning and falls back to a local diff.
- The skill workflow needs a compatible coding-agent host, but the scripts and
  generated HTML do not. They can be run or opened standalone.
- The doc pulls two things from CDNs when opened (so ideally online, but each
  degrades gracefully offline): **syntax highlighting** (highlight.js — falls
  back to plain, still diff-colored) and **Mermaid** diagrams (SVG diagrams need
  nothing). System fonts, the diff, comments, viewed state, and export are fully
  offline.

Before grouping, read repository-local agent instructions for risk rules, test
conventions, generated outputs, and regeneration commands. Apply those rules
only when the current patch supplies supporting evidence. See
[docs/REPOSITORY-CONFIGURATION.md](docs/REPOSITORY-CONFIGURATION.md) for a
recommended policy block and the deterministic conventions schema v1 detects.

## Workflow (the agent path)

The full workflow has two commands and one model-authored result. The
orchestrator owns collection, validation, spec generation, metrics, and HTML
building; the language model never generates HTML. A deterministic quick path
is available when no model-authored grouping or findings are needed.

### Quick workspace review

For a standalone review without model-authored grouping or findings, run this
from the repository under review:

```bash
bun <skill-dir>/scripts/trace-review.mjs
```

With no revisions this follows bare `git diff` semantics. Common comparisons
use the same positional revision forms:

```bash
bun <skill-dir>/scripts/trace-review.mjs main
bun <skill-dir>/scripts/trace-review.mjs main feature
bun <skill-dir>/scripts/trace-review.mjs abc123 def456
bun <skill-dir>/scripts/trace-review.mjs main..feature
bun <skill-dir>/scripts/trace-review.mjs main...feature
```

The command creates the deterministic workspace result and supporting files in
`.review/`, builds `.review/review.html`, and opens it. Pass `--no-open` to
build without launching a browser. Quick mode accepts zero, one, or two
revisions; Git flags such as `--cached` and pathspec filtering are not
currently supported. From a source checkout, replace the executable prefix
with the package shortcut `bun trace-review`.

### 1. Prepare once

Run from the repository under review:

```bash
node <skill-dir>/scripts/trace-review.mjs prepare --repo <repo> \
  --pr auto --mode workspace
```

Use `--pr 8` for `pr 8`, `--mode lm-analysis` for `lm` or `ai`, and both for
`lm pr 8`. For a local-only review use `--pr none --base <ref>`. Deep audit
requires `--mode deep-audit --explicit`. Use a distinct `--dir` for each review
when processing multiple PRs.

If `prepare` succeeds, do not call the low-level scripts, `git`, or `gh`.
Read `.review/analysis-input.json`, then read `.review/context.patch` once.
The input contains compact repository and PR facts, candidate change units,
contracts, and paths to bounded whole-file content. Read a full file only to
verify a concrete candidate finding.

### 2. Write one result

Write only `.review/review-result.json`:

```json
{
  "summary": "The change hardens session lifecycle handling.",
  "groups": [
    {
      "title": "Session lifecycle contract",
      "intent": "Review opening and timeout behavior as one decision.",
      "risk": "medium",
      "confidence": 0.91,
      "evidence": ["The source file owns both lifecycle hunks."],
      "reviewerChecks": ["Check compatibility and timeout behavior."],
      "titleEvidence": {
        "changeIds": ["src/session.js#h0"],
        "rationale": "This hunk introduces the lifecycle entry point."
      },
      "changeIds": ["src/session.js#h0", "src/session.js#h1"],
      "readAfter": []
    }
  ],
  "review": {
    "verdict": "comment",
    "global": "The implementation is focused; one edge case needs attention.",
    "findings": []
  }
}
```

Workspace mode omits `review`. LM analysis and deep audit require it. Assign
every candidate change ID exactly once. Generate titles from the actual change,
not classifier labels such as **Definitions**, **Consumers**, or **Associated
tests**. Keep findings sparse and evidence-backed.

### 3. Finish once

```bash
node <skill-dir>/scripts/trace-review.mjs finish \
  --input .review/analysis-input.json \
  --result .review/review-result.json --open
```

`finish` validates the result, finalizes groups and findings, creates the spec,
builds the HTML, and writes `.review/run-metrics.json`. The default `.review/`
directory is added to the repository's local Git exclude file, so generated
review artifacts do not enter commits.

Treat validation failures as hard stops and correct the one result file. The
lower-level scripts are diagnostic interfaces only; use them when the
orchestrator itself reports an error, not as extra workflow steps.

### Summary blocks

Each block is `{ type, width?, ... }`. **Only put here what helps** — a tiny
change may need just one `prose` block. Blocks render in the left PR panel and
stack for readability; `width` (`full`/`two-thirds`/`half`/`third`) is a hint
used when the summary has room.

| `type` | Fields | Use for |
|--------|--------|---------|
| `prose` | `md` | Markdown text — the description. |
| `diagram` | `svgFile` \| `svg` \| `mermaid`, `title?`, `surface?` | A picture. **Prefer SVG** (crisp, offline); Mermaid needs internet. `surface` is `light` by default or `dark` when the diagram was designed for a dark canvas. |
| `stats` | `items: [{label, value, accent?}]` | A row of metric tiles. `accent`: `green`/`red`/`orange`. |
| `table` | `headers?`, `rows: [[...]]` | Component/risk/impact tables. Cells are plain text. |
| `callout` | `md`, `variant?` (`info`/`warn`/`success`), `title?` | A note to not miss. |
| `heading` | `text`, `level?` | A sub-heading. |

### Automatic LM findings (`lm-analysis` and `deep-audit` only)

Only when the user asked for LM analysis, add a `review` object to every PR.
Skip it entirely in workspace mode. The review is always attributed to the
neutral label **"LM"**. Do not ask the model to identify itself, infer a model
variant or reasoning effort, or add provider-specific attribution to the spec.

```json
"review": {
  "verdict": "approve | comment | request-changes",
  "global": "markdown — overall assessment",
  "comments": [
    { "file": "auth.js", "line": 3, "severity": "concern", "body": "markdown", "confidence": 0.94, "rationale": "brief, verifiable evidence" }
  ]
}
```

- `line` = the **new-file** line number as shown in the diff. For a comment on a
  **removed** line, use `"o"` + the old line number (e.g. `"o7"`).
- `severity` ∈ `nit` · `suggestion` · `concern` · `question` · `praise`
  (color-coded badges). Default `comment`.
- `confidence` is required from 0 to 1, and `rationale` is a required concise
  statement of the evidence that makes the finding credible.
- `global`/`verdict` render as a read-only **"&lt;reviewer&gt; review"** card;
  each `comments` entry renders inline at its line (Accept / Dismiss / Reply)
  and in a **findings** list. The reviewer's Accept/Dismiss/reply decisions ride
  along in the export, so you know what to act on.

**Be sparing — this is the important part.** Comment only where there is
genuinely something to say: a likely **bug**, a **missing** case (error
handling, validation, a test), a real **risk**, or a genuine **question**. Do
**not**:

- comment on every changed line, or add a finding just because a line changed;
- narrate or restate what the code does;
- pad with `praise` or trivial `nit`s.

One finding per issue, anchored to the single most relevant line (or the block's
first line) — not one per line. Keep each `body` to 1–2 sentences. Most PRs
deserve a small handful of findings; a clean change deserves **none** — return
an empty `comments` array (the global card still summarises). Signal over volume:
a reviewer should be able to act on every finding you leave.

### Change groups

Prefer a finalized LM-generated `groupFile` (or embed it as `changeGroups`).
Generated groups work at hunk granularity and display their rationale. In
LM-analysis and deep-audit modes they also show dependencies and a suggested
reading order. Deterministic quick workspace reviews preserve classifier order
without presenting it as a recommendation. Within each group, a file appears
once even when several of its hunks are assigned there. A file may appear in
multiple groups when its hunks implement separate decisions. The groups are
read-only review context: the reviewer evaluates the proposed decisions rather
than defining or repairing the grouping model.

The legacy file-level `groups` array remains available for hand-authored specs:

For a PR that touches many files, group them by theme so the reviewer isn't
slogging file-by-file — especially when **the same change repeats across many
files** (a rename, an added `#include`, a signature tweak). Add a `groups` array:

```json
"groups": [
  { "id": "inc", "kind": "mechanical", "title": "Add #include \"logging.h\"",
    "note": "Identical include at the top of each unit — review one, tick the group.",
    "files": ["src/a.cpp", "src/b.cpp", "src/c.cpp"] },
  { "id": "core", "kind": "feature", "title": "Wire up the logger",
    "files": ["src/logger.cpp"] }
]
```

- Each group renders as a labelled band (colour-coded `kind` badge + note +
  summed `+/-`) with its files beneath, and **one "Reviewed" checkbox that marks
  every file in the group viewed at once** after a confirmation that names the
  group, file count, and affected paths — the fix for a repeated mechanical
  change without an accidental bulk action.
- `kind`: `mechanical` · `refactor` · `feature` · `fix` · `test` · `docs` ·
  `other`. `mechanical` groups **collapse their files by default** (expand one to
  see the pattern); override per group with `collapsed: true|false`.
- Files you don't list fall into an **"Other changes"** group at the end, so you
  can group just the noisy repetitive files and leave the rest.
- **Mixed file?** If a file has the repeated change *and* a distinct change, put
  it in the *substantive* group (its full diff shows there) — don't also list it
  in the mechanical group. The mechanical group is only for files whose entire
  change is the pattern.
- **Pure renames are grouped automatically.** Files that were only moved/renamed
  (no textual change) are collected into a collapsed **"Renamed (no content
  change)"** group with no work from you — so a big rename doesn't bury the real
  changes. A rename that *also* edits the file is a normal reviewable file (and
  you can put it in a group). You rarely need to list renames in `groups`.

### Re-import the reviewer's comments

In the doc the reviewer hovers a line and clicks the **+** in its gutter to
comment (works in both unified and split view — comments follow the line, not
the layout), types an overall note, and — in an LM mode — **Accepts / Dismisses
/ Replies** to the LM findings. Then either:

- **Copy comments** in the header → copies the current Markdown report directly
  to the clipboard, with no modal.
- **Share review → Markdown report** opens the report preview with another copy action and a
  **Download .md** option that saves `review-comments-<reviewId>.md` to the
  Downloads folder.
- **GitHub review** appears in the Share review dialog only when the spec
  contains validated GitHub publication context. It previews which comments
  will become native threads and which will remain in the summary. Download
  the publication plan, then run:

  ```bash
  node <skill-dir>/scripts/publish-github-review.mjs \
    --plan "$HOME/Downloads/github-review-owner-repository-123.json"
  ```

  The command requires an authenticated `gh`, rejects a changed PR head,
  repeats the native/fallback preview, and asks for explicit confirmation
  before submitting one GitHub review. Do not pass `--confirm` unless the user
  explicitly approved that exact preview. A rejected or cancelled publication
  leaves the plan intact.

Read a downloaded Markdown report with:

  ```bash
  cat "$USERPROFILE/Downloads/review-comments-<reviewId>.md"
  ```

The export has two parts per PR: **On the &lt;reviewer&gt; review** — each
finding tagged `[accepted]` / `[dismissed]` / `[open]` — and the reviewer's own
comments (overall, per-file as `**File:**`, and per-line). Work through the
accepted findings and their own comments; leave dismissed ones alone.

## Spec reference

| Field | Where | Meaning |
|-------|-------|---------|
| `schemaVersion` | top | Required. Always `1`; unknown versions are rejected. |
| `mode` | top | Required. `workspace`, `lm-analysis`, or `deep-audit`. |
| `title` | top | Document title (default `Code Review`). |
| `reviewId` | top | localStorage key for comments (default: slug of title). Keep stable. |
| `generated` | top | Free-text date/context line (default: today). |
| `prs[].title` | per PR | Tab label + summary heading. |
| `prs[].url` | per PR | Optional link to the PR/branch, shown in the summary head. |
| `prs[].github` | per PR | Optional native-publication target: `{ repository, pullRequest, headSha }`. Include only from validated GitHub context. |
| `prs[].summary` | per PR | Markdown (simple path). Ignored if `blocks` is set. |
| `prs[].diagrams[]` | per PR | Simple path: `{ title?, svgFile\|svg\|mermaid }`. Ignored if `blocks` is set. |
| `prs[].blocks[]` | per PR | Free-form summary blocks (see *Summary blocks*). Replaces `summary`/`diagrams`. |
| `prs[].diffFile` | per PR | Path to a unified-diff file (relative to spec). |
| `prs[].diff` | per PR | Inline unified-diff string (alternative to `diffFile`). |
| `prs[].groupFile` | per PR | Validated Phase 2 grouping fact pack (relative to the spec). |
| `prs[].changeGroups` | per PR | Inline Phase 2 grouping fact pack. |
| `prs[].autoGroups` | per PR | Detect and validate Phase 2 groups while building. |
| `prs[].groups` | per PR | Legacy file-level groups — `[{ id, title, kind?, note?, collapsed?, files[] }]`. |
| `prs[].review` | per PR | Required in `lm-analysis` and `deep-audit`: `{ verdict?, global?, comments[] }`. Forbidden in `workspace`. |

One PR → no tabs, section shown directly. Two+ → a tab bar with per-PR comment
counts.

## What the output looks like

The workspace opens on **Review changes**, with the diff, findings, comments,
and pull-request context visible immediately. **Review groups** is an optional
second view for checking change intent, dependencies, and reading order.

- **Left — the PR** (only when there's context: `url`, `summary`, `diagrams`,
  or `blocks`): a sticky panel with the title, `+/-` stats, PR link, and your
  free-form summary blocks. Omitted for a bare diff.
- **Right — the review:**
  - **Top** — in LM-analysis and deep-audit modes, a compact **"&lt;reviewer&gt; review"** card whose
    header is **coloured by verdict** (green approve / red request-changes /
    blue comment), then an expanded **findings** panel where each item is
    **accent-coloured by severity**, then a live list of the reviewer's
    line comments (click any to jump to that line).
  - **Bottom** — the self-contained **"Changes"** block: collapsible per-file
    diffs with **language-aware syntax highlighting** (by file extension,
    highlighted per-hunk so multi-line strings/comments colour correctly),
    dual old/new line numbers and green/red backgrounds. Each **file header is
    sticky** — it stays pinned under the "Changes" bar while you scroll a long
    file, then hands off to the next file. The reviewer clicks the **+** gutter
    to comment on a line, the **💬** on a file header to comment on the whole
    file, ticks **Viewed** to mark a file done (it collapses, GitHub-style, is
    remembered, and the view scrolls to bring the next file up so reading order
    is preserved), and hits **⛶** to read the diff fullscreen. LM findings
    appear inline, severity-coloured, with Accept / Dismiss / Reply.
- **Pinned at the bottom-right** — a compact **📝 Your overall review** drawer
  stays available without covering the width of the diff. It starts collapsed
  and expands for the reviewer's own verdict after reading everything.

The context column is **adaptive, resizable, and collapsible** — drag the divider
between it and the evidence surface (default **34/66**, double-click resets),
use **Context** to collapse it, or use **Focus** to remove surrounding review
chrome. On narrow screens the context panel stacks on top. The Primer-inspired
design system uses native system and monospace fonts, functional light/dark
tokens, compact controls, familiar diff states, and visible keyboard focus.

Viewer controls:
- **File tree** — a **Files** button on the "Files changed" bar opens a slide-in
  tree of the changed files (directory chains compacted, per-file `+/-`, viewed
  files struck through). Click a file to jump to it — it expands its group if
  needed and scrolls it under the sticky header. Built for big diffs.
- **Progress dock** (right edge) — two rings, review items viewed and (in
  review mode) findings reviewed, scoped to the **active PR** so they match its
  header. Grouped mode counts file-within-decision items; raw Git order counts
  files. The centre shows a compact **%** (a ✓ when complete) with the exact
  count below, so it stays legible even at hundreds of items. In review mode,
  fixed **Previous / Next finding** controls remain beside the rings after a
  finding jumps into the diff.
- **Unified / Split** toggle — lives on the **"Changes"** bar; switches inline
  vs side-by-side (persists; comments follow the line in both).
- **Range selection** — drag across contiguous diff gutters within one hunk and
  side to add a block comment, create a GitHub-compatible suggested change, or
  export a syntax-colored before/after diff. The export preview is selectable
  and supports rich-text copy plus HTML, SVG, and PNG downloads. Suggested
  changes are offered only on the new-file side.
- **Git order / Grouped order** — every grouped review can return to the raw
  patch sequence for verification. Viewed state, navigation, and progress share
  the same file identity in both representations.
- **Click any diagram** to view it fullscreen (click again / Esc to close).
- **Theme** button (header) — the doc **follows the OS light/dark setting by
  default**; the button cycles a session-only override (system → light → dark),
  not persisted, so a fresh open honours the system setting again.

## Gotchas

- **Comments persist in the reviewer's browser (localStorage), not in the HTML
  file.** Sending someone the `.html` sends an empty doc — send it and let them
  export their comments back. Comments survive a page reload and a rebuild
  **only if `reviewId` is unchanged**.
- **Rebuilding after the diff changed:** line comments first follow an exact
  contextual fingerprint, then a unique file/type/content fingerprint when the
  line moves. Comments whose source changed or is ambiguous are shown in an
  **Orphaned comments** tray and included in export until deleted.
- **Untrusted pull-request content:** Markdown links accept only HTTP(S),
  `mailto:`, or local fragments. Inline SVG is reduced to a safe SVG allowlist,
  and Mermaid runs in strict security mode.
- **Very large diffs:** diff mounts render progressively. Word-level
  highlighting is skipped for pathological line or token sizes; the ordinary
  line diff remains complete.
- **Mermaid needs internet; SVG does not.** Prefer `svg`/`svgFile` diagrams —
  they render offline and scale crisply. Each SVG is placed on an explicit light
  canvas by default, including in dark mode, so generated diagrams remain legible.
  Set `surface: "dark"` only when the SVG was designed for a dark canvas. A spec
  with no Mermaid = no CDN call.
  A missing `svgFile` degrades to a warning box; the rest of the doc is fine.
- **Previewing inside Claude Code's Browser pane:** local `file://` outside the
  project renders as a static snapshot (no JS). To exercise the interactivity,
  serve over HTTP and use `preview_start`, or just open in a real browser with
  `--open`.
- **Line-ending warnings** from git (`LF will be replaced by CRLF`) on Windows
  are harmless; the patch is still valid.

The complete operational boundary—including binary files, heuristic generated
file detection, localStorage portability, GitHub CLI fallback, and offline CDN
degradation—is documented in
[docs/LIMITATIONS.md](docs/LIMITATIONS.md). Do not represent a generated review
as a substitute for the repository's compiler, tests, linters, or security
tooling.
