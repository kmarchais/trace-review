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

**Do NOT hand-write HTML.** Always go through `build-review.mjs`.

## Three explicit modes

| Mode | What you do | Result |
|------|-------------|--------|
| **Workspace** (default) | Set top-level `"mode": "workspace"` and omit every `review` object. | The reviewer reads the facts and diff and writes their own comments. |
| **LM analysis** (on request) | Set `"mode": "lm-analysis"` and emit a `review` object for every PR. | Adds sparse language-model findings: a global assessment plus severity-tagged, line-anchored comments. |
| **Deep audit** (explicit/high-risk only) | Set `"mode": "deep-audit"` after the user requests or accepts deeper analysis. | Uses the same finding contract after broader dependency, failure-mode, and test analysis. |

Default is **workspace**. Add LM analysis when the user invokes
`/trace-review lm-analysis`, or asks for it in words ("review this and add your
findings").
Invoking `/trace-review` (or `… no-review`) stays in workspace mode
— don't spend tokens analysing the diff unless asked. Deep audit is never
silently selected. See [REVIEW-SPEC.md](REVIEW-SPEC.md) for the versioned
contract.

Paths below are relative to the skill directory
(`.claude/skills/trace-review/`). Run commands from any working directory; pass
absolute paths for `--spec`/`--out` when in doubt.

## Prerequisites

- **Node 18+** (`node --version`) — required; no npm install, zero dependencies.
- **Git** — required for repository facts and local diffs.
- **`gh`** — optional in automatic/local mode and required for explicit PR
  selection. If it is missing, unauthenticated, or unavailable, automatic mode
  emits a warning and falls back to a local diff.
- The skill workflow needs a compatible agent host (Claude Code or Codex), but
  the scripts and generated HTML do not. They can be run or opened standalone.
- The doc pulls three things from CDNs when opened (so ideally online, but each
  degrades gracefully offline): **syntax highlighting** (highlight.js — falls
  back to plain, still diff-colored), **Mermaid** diagrams (SVG diagrams need
  nothing), and the **fonts** (system fallback). The diff, comments, viewed
  state, and export are fully offline.

## Workflow (the agent path)

### 1. Collect facts and the diff — never dump the diff into chat

Run the context collector first. It writes a validated, compact fact pack to
`.review/context.json` and the heavy patch to `.review/context.patch`.

```bash
# Default: detect the current branch's PR, then fall back to a local diff
node <skill-dir>/scripts/collect-pr-context.mjs

# Explicit PR selection by number or URL
node <skill-dir>/scripts/collect-pr-context.mjs --pr 123
node <skill-dir>/scripts/collect-pr-context.mjs --pr https://github.com/org/repo/pull/123

# Intentionally disable remote context
node <skill-dir>/scripts/collect-pr-context.mjs --no-remote --base main
```

Use `--repo <path>` when the command is not run inside the target repository,
and `--out` / `--diff-out` to choose other output locations. In automatic mode,
an unavailable `gh` command or a branch with no PR falls back to a local diff.
Remote failures produce a visible warning and a `remote-context-unavailable`
diagnostic; a confirmed no-PR response uses `current-branch-pr-not-found`.
Explicit PR selection fails with an installation/local-mode hint instead of
silently reviewing something else.

For an already-created patch, run the standalone deterministic inventory:

```bash
node <skill-dir>/scripts/review-preflight.mjs --diff .review/context.patch \
  --out .review/preflight.json
```

Preflight reports patch validity, byte and line counts, file types, whitespace
errors, binaries, and likely generated files. Read `context.json` before the
patch: it already contains the title, description, branches, labels, checks,
reviews, conversation comments, inline GitHub review comments, and candidate
change groups.

Multiple PRs → run the collector once per explicit PR with distinct output
paths.

### 2. Generate and validate semantic change groups

The collector includes deterministic **candidate facts** in its context. For an
existing patch, write those candidates separately:

```bash
node <skill-dir>/scripts/detect-mechanical-groups.mjs \
  --diff .review/context.patch --out .review/candidates.json
```

The detector inventories changes at hunk/line-range granularity. It recognizes pure
renames, formatting-only changes, lockfiles, import/include changes, and
repeated includes. Every group carries intent, evidence, risk, confidence, and
reviewer checks. Binary/generated uncertainty is placed in **Needs inspection**;
anything unmatched stays visible in **Unclassified**.

Those fixed classifier labels are evidence for the LM, never the final group
names shown to a reviewer. In every mode, read the candidate facts and patch,
then produce `.review/grouping-result.json`:

```json
{
  "groups": [
    {
      "title": "Session lifecycle contract",
      "intent": "Review opening and timeout behavior as one source-file decision.",
      "risk": "medium",
      "confidence": 0.91,
      "evidence": ["The source file owns both lifecycle hunks."],
      "reviewerChecks": ["Check lifecycle compatibility and timeout behavior."],
      "titleEvidence": {
        "changeIds": ["src/session.js#h0"],
        "rationale": "This hunk introduces the session lifecycle entry point."
      },
      "changeIds": ["src/session.js#h0", "src/session.js#h1"],
      "readAfter": []
    }
  ]
}
```

Group titles must be generated from the actual change. Do not expose recurring
classifier names such as **Definitions**, **Consumers**, or **Associated
tests**. Assign every change unit exactly once. Within a group, collect all of
that group's hunks for a file into one file block. The same file may appear in
another group when separate hunks belong to a genuinely different review
decision; use change-specific group titles and intents to make that split
explicit.

Finalize and validate the LM result:

```bash
node <skill-dir>/scripts/finalize-lm-groups.mjs \
  --candidates .review/candidates.json \
  --result .review/grouping-result.json \
  --out .review/groups.json
```

Treat any validation failure as a hard stop. The finalizer rejects generic
titles, unknown/missing/overlapping change units, incomplete rationales, and
invalid dependency references. Group generation is required
even in workspace mode; workspace mode omits LM *findings*, not LM-organized
review structure.

### 3. Prepare focused LM input when requested

For `lm-analysis`, prepare a compact analyzer input from the collected context:

```bash
node <skill-dir>/scripts/prepare-lm-analysis.mjs \
  --context .review/context.json --out .review/analysis-input.json
```

Read `analysis-input.json` first. It carries PR context, deterministic preflight
facts, candidate groups, dependency order, a risk assessment, the diff path,
and a fact-derived finding budget. The raw patch remains separately available
for verifying candidate findings; it is not the analyzer's only input.

Use `--mode deep-audit` only when the fact pack is high risk. When the user
explicitly requests a deep audit, also pass `--explicit`. The command otherwise
refuses to escalate a low- or medium-risk review.

Produce `analysis-result.json` with `verdict`, `global`, and `findings`, then
validate and convert it:

```bash
node <skill-dir>/scripts/finalize-lm-analysis.mjs \
  --input .review/analysis-input.json \
  --result .review/analysis-result.json \
  --out .review/review.json
```

Do not bypass a finding-budget or contract failure. Reduce noise or fix missing
evidence before copying the resulting review object into the review spec.

### 4. Read the facts and write a short spec

Read the collected context and patches to understand the change, then write
`.review/spec.json`.
Keep the summary tight — say *what changed and why*, not a line-by-line
retelling. Copy the shape from [examples/review-spec.json](examples/review-spec.json).

Minimum viable spec:

```json
{
  "schemaVersion": 1,
  "mode": "workspace",
  "title": "Review: harden auth flow",
  "reviewId": "harden-auth",
  "prs": [
    { "title": "Add credential validation", "summary": "Rejects empty creds; timestamps tokens.", "diffFile": "context.patch", "groupFile": "groups.json" }
  ]
}
```

- `diffFile` is resolved **relative to the spec file**. (Or inline the diff as
  a `"diff"` string for tiny changes.)
- Run `node <skill-dir>/scripts/validate-review-spec.mjs --spec
  .review/spec.json` to inspect contract diagnostics without generating HTML.
  The build command runs the same validation and refuses invalid specs.
- `groupFile` is resolved relative to the spec and revalidated against the
  current patch at build time. It should point to the finalized LM grouping.
  `autoGroups: true` remains a low-level deterministic fallback for tests and
  diagnostics; do not use it for a reviewer-facing document.
- `reviewId` keys the reviewer's saved comments — **keep it stable** across
  rebuilds so comments survive a regenerate.

The page is a two-column workspace: **left = the PR** (the summary you compose),
**right = the review** (global comment on top, diff below). The left panel is
shown only when there's PR context; a bare diff gets no left panel. You have
two ways to fill the PR summary:

- **Simple:** set `summary` (markdown) and optionally `diagrams` (an array).
  They lay out as one prose block + the diagrams. Good default.
- **Free-form:** set a `blocks` array and compose the panel yourself — prose,
  stat tiles, a risk table, a callout, diagrams, in whatever order fits.
  `blocks` **replaces** `summary`/`diagrams` when present.

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
Skip it entirely in workspace mode. The review is attributed to a neutral
**"LM"** by default — set the top-level `reviewer` (e.g. `"Claude"`, `"GPT-5"`,
a person's name) to relabel the card, pills, findings, and export.

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
Generated groups work at hunk granularity, display their rationale and
dependencies, and follow the suggested reading order. Within each group, a file
appears once even when several of its hunks are assigned there. A file may
appear in multiple groups when its hunks implement separate decisions. The
groups are read-only review context: the reviewer evaluates the proposed
decisions rather than defining or repairing the grouping model.

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

### 5. Build and open

```bash
node .claude/skills/trace-review/scripts/build-review.mjs --spec .review/spec.json --out .review/review.html --open
```

`--open` launches the default browser (Windows `start` / macOS `open` /
Linux `xdg-open`). Drop it and just tell the user the path if you prefer.

### 6. Re-import the reviewer's comments

In the doc the reviewer hovers a line and clicks the **+** in its gutter to
comment (works in both unified and split view — comments follow the line, not
the layout), types an overall note, and — in an LM mode — **Accepts / Dismisses
/ Replies** to Claude's findings. Then they hit **Export comments**, which gives
markdown two ways:

- **Copy to clipboard** → they paste it back into this chat.
- **Download .md** → saves `review-comments-<reviewId>.md` to their Downloads
  folder. Read it with:

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
| `reviewer` | top | Display name for the LM reviewer (default `LM`) — labels the review card, pills, findings, export. |
| `generated` | top | Free-text date/context line (default: today). |
| `prs[].title` | per PR | Tab label + summary heading. |
| `prs[].url` | per PR | Optional link to the PR/branch, shown in the summary head. |
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

See [examples/screenshot.png](examples/screenshot.png). The workspace follows
three explicit stages: **Understand** the pull request, **Validate groups** and
their relationships, then **Inspect evidence** in the diff. It opens on
**Inspect evidence**, so the reviewer sees the code immediately; the other
stages remain available for focused context and group rationale.

- **Left — the PR** (only when there's context: `url`, `summary`, `diagrams`,
  or `blocks`): a sticky panel with the title, `+/-` stats, PR link, and your
  free-form summary blocks. Omitted for a bare diff.
- **Right — the review:**
  - **Top** — in LM-analysis and deep-audit modes, a compact **"&lt;reviewer&gt; review"** card whose
    header is **coloured by verdict** (green approve / red request-changes /
    blue comment), then a collapsed-on-demand **findings** panel where each item
    is **accent-coloured by severity**, then a live list of the reviewer's
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
chrome. On narrow screens the context panel stacks on top. The design system
uses Inter for interface text, JetBrains Mono for code, quiet neutral surfaces,
semantic state colors, a shared spacing scale, and visible keyboard focus.

Viewer controls:
- **File tree** — a **🗂 Files** button on the "Changes" bar opens a slide-in
  tree of the changed files (directory chains compacted, per-file `+/-`, viewed
  files struck through). Click a file to jump to it — it expands its group if
  needed and scrolls it under the sticky header. Built for big diffs.
- **Progress dock** (right edge) — two rings, review items viewed and (in
  review mode) findings reviewed, scoped to the **active PR** so they match its
  header. Grouped mode counts file-within-decision items; raw Git order counts
  files. The centre shows a compact **%** (a ✓ when complete) with the exact
  count below, so it stays legible even at hundreds of items.
- **Unified / Split** toggle — lives on the **"Changes"** bar; switches inline
  vs side-by-side (persists; comments follow the line in both).
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
- **Rebuilding after the diff changed:** comments anchored to lines that no
  longer exist stay in storage but silently won't re-attach. Expected.
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

## Build & test the driver itself

Run the dependency-free test suite, then reproduce the generator smoke test:

```bash
npm test
node scripts/build-review.mjs --spec examples/review-spec.json --out review-smoke.html
```

The suite covers collection, preflight, schema diagnostics, representative
patches, HTML structure, a checked-in visual contract, and a 300-file
performance fixture.
