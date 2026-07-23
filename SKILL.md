---
name: html-review
description: Generate an interactive HTML code-review document from a git diff or one or more pull requests. Use when asked to review changes, do a code review, produce a review doc, review a diff/branch/PR, or collect review comments. Renders a concise summary, optional diagrams, a readable word-level diff, and per-line comment fields that export back into the conversation.
---

# html-review

Turns a diff (working tree, a branch range, or one/many PRs) into a single
**self-contained interactive HTML file**: a free-form PR summary, optional
diagrams, a comprehensible word-level diff (unified/split), and comment boxes
on every line + an overall box. The reviewer's comments export as clean
markdown that gets pasted (or read from a file) back into this conversation.

The heavy lifting lives in a **template + build script** so you spend almost no
tokens: diffs are read from files on disk (never echoed into chat), and you
only author a short JSON spec.

**Do NOT hand-write HTML.** Always go through `build-review.mjs`.

## Two modes

| Mode | What you do | Result |
|------|-------------|--------|
| **Diff** (default) | Just render the diff + empty comment fields. | The reviewer reads the diff and writes their own comments. |
| **Review** (on request) | Also analyse the diff and emit a `review` object. | Adds **an AI review**: a global assessment + severity-tagged findings anchored to lines, each with Accept/Dismiss/Reply — shown alongside the reviewer's own fields. |

Default is **diff-only**. Add the AI review when the user invokes
`/html-review review`, or asks for it in words ("review this and add your
findings"). Invoking `/html-review` (or `… no-review`) stays diff-only — don't
spend tokens analysing the diff unless asked. Mechanically, "review mode" just
means you also fill in `prs[].review` (see *Automatic (AI) review*).

Paths below are relative to the skill directory
(`.claude/skills/html-review/`). Run commands from any working directory; pass
absolute paths for `--spec`/`--out` when in doubt.

## Prerequisites

- **Node 18+** (`node --version`) — no npm install, zero dependencies.
- **git** and/or **`gh`** to produce the diffs.
- The doc pulls three things from CDNs when opened (so ideally online, but each
  degrades gracefully offline): **syntax highlighting** (highlight.js — falls
  back to plain, still diff-colored), **Mermaid** diagrams (SVG diagrams need
  nothing), and the **fonts** (system fallback). The diff, comments, viewed
  state, and export are fully offline.

## Workflow (the agent path)

### 1. Dump the diff(s) to files — never into chat

Pick what matches the request. Redirect to `.patch` files in a work dir:

```bash
mkdir -p .review
git diff > .review/local.patch                 # uncommitted work
git diff main...HEAD > .review/branch.patch     # a branch vs main
gh pr diff 123 --patch > .review/pr-123.patch   # a specific PR
```

Multiple PRs → one `.patch` per PR.

### 2. Read the diffs and write a short spec

Read the patches to understand the change, then write `.review/spec.json`.
Keep the summary tight — say *what changed and why*, not a line-by-line
retelling. Copy the shape from [examples/review-spec.json](examples/review-spec.json).

Minimum viable spec:

```json
{
  "title": "Review: harden auth flow",
  "reviewId": "harden-auth",
  "prs": [
    { "title": "Add credential validation", "summary": "Rejects empty creds; timestamps tokens.", "diffFile": "local.patch" }
  ]
}
```

- `diffFile` is resolved **relative to the spec file**. (Or inline the diff as
  a `"diff"` string for tiny changes.)
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
| `diagram` | `svgFile` \| `svg` \| `mermaid`, `title?` | A picture. **Prefer SVG** (crisp, offline); Mermaid needs internet. |
| `stats` | `items: [{label, value, accent?}]` | A row of metric tiles. `accent`: `green`/`red`/`orange`. |
| `table` | `headers?`, `rows: [[...]]` | Component/risk/impact tables. Cells are plain text. |
| `callout` | `md`, `variant?` (`info`/`warn`/`success`), `title?` | A note to not miss. |
| `heading` | `text`, `level?` | A sub-heading. |

### Automatic (AI) review (review mode only)

Only when the user asked for a review, add a `review` object to the PR. Skip it
entirely in the default diff-only mode. The review is attributed to a neutral
**"AI"** by default — set the top-level `reviewer` (e.g. `"Claude"`, `"GPT-5"`,
a person's name) to relabel the card, pills, findings, and export.

```json
"review": {
  "verdict": "approve | comment | request-changes",
  "global": "markdown — overall assessment",
  "comments": [
    { "file": "auth.js", "line": 3, "severity": "concern", "body": "markdown" },
    { "file": "auth.js", "line": 11, "severity": "nit", "body": "…" }
  ]
}
```

- `line` = the **new-file** line number as shown in the diff. For a comment on a
  **removed** line, use `"o"` + the old line number (e.g. `"o7"`).
- `severity` ∈ `nit` · `suggestion` · `concern` · `question` · `praise`
  (color-coded badges). Default `comment`.
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

### Change groups (optional)

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
  every file in the group viewed at once** — the fix for a repeated mechanical
  change.
- `kind`: `mechanical` · `refactor` · `feature` · `fix` · `test` · `docs` ·
  `other`. `mechanical` groups **collapse their files by default** (expand one to
  see the pattern); override per group with `collapsed: true|false`.
- Files you don't list fall into an **"Other changes"** group at the end, so you
  can group just the noisy repetitive files and leave the rest.
- **Mixed file?** If a file has the repeated change *and* a distinct change, put
  it in the *substantive* group (its full diff shows there) — don't also list it
  in the mechanical group. The mechanical group is only for files whose entire
  change is the pattern.

### 3. Build and open

```bash
node .claude/skills/html-review/scripts/build-review.mjs --spec .review/spec.json --out .review/review.html --open
```

`--open` launches the default browser (Windows `start` / macOS `open` /
Linux `xdg-open`). Drop it and just tell the user the path if you prefer.

### 4. Re-import the reviewer's comments

In the doc the reviewer hovers a line and clicks the **+** in its gutter to
comment (works in both unified and split view — comments follow the line, not
the layout), types an overall note, and — in review mode — **Accepts / Dismisses
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
| `title` | top | Document title (default `Code Review`). |
| `reviewId` | top | localStorage key for comments (default: slug of title). Keep stable. |
| `reviewer` | top | Display name for the AI reviewer (default `AI`) — labels the review card, pills, findings, export. |
| `generated` | top | Free-text date/context line (default: today). |
| `prs[].title` | per PR | Tab label + summary heading. |
| `prs[].url` | per PR | Optional link to the PR/branch, shown in the summary head. |
| `prs[].summary` | per PR | Markdown (simple path). Ignored if `blocks` is set. |
| `prs[].diagrams[]` | per PR | Simple path: `{ title?, svgFile\|svg\|mermaid }`. Ignored if `blocks` is set. |
| `prs[].blocks[]` | per PR | Free-form summary blocks (see *Summary blocks*). Replaces `summary`/`diagrams`. |
| `prs[].diffFile` | per PR | Path to a unified-diff file (relative to spec). |
| `prs[].diff` | per PR | Inline unified-diff string (alternative to `diffFile`). |
| `prs[].groups` | per PR | Optional: organise files into themed groups — `[{ id, title, kind?, note?, collapsed?, files[] }]` (see *Change groups*). |
| `prs[].review` | per PR | Review mode only: `{ verdict?, global?, comments[] }` (see *Automatic (AI) review*). Omit for diff-only. |

One PR → no tabs, section shown directly. Two+ → a tab bar with per-PR comment
counts.

## What the output looks like

See [examples/screenshot.png](examples/screenshot.png). A two-column workspace:

- **Left — the PR** (only when there's context: `url`, `summary`, `diagrams`,
  or `blocks`): a sticky panel with the title, `+/-` stats, PR link, and your
  free-form summary blocks. Omitted for a bare diff.
- **Right — the review:**
  - **Top** — in review mode, a bold **"&lt;reviewer&gt; review"** card whose
    header is **coloured by verdict** (green approve / red request-changes /
    blue comment) so it's spotted instantly, then a **findings** list where each
    item is **accent-coloured by severity**, then a live list of the reviewer's
    line comments (click any to jump to that line).
  - **Bottom** — the self-contained **"Changes"** block: collapsible per-file
    diffs with **language-aware syntax highlighting** (by file extension,
    highlighted per-hunk so multi-line strings/comments colour correctly),
    dual old/new line numbers and green/red backgrounds. Each **file header is
    sticky** — it stays pinned under the "Changes" bar while you scroll a long
    file, then hands off to the next file. The reviewer clicks the **+** gutter
    to comment on a line, the **💬** on a file header to comment on the whole
    file, ticks **Viewed** to mark a file done (it collapses, GitHub-style, and
    is remembered), and hits **⛶** to read the diff fullscreen. AI findings
    appear inline, severity-coloured, with Accept / Dismiss / Reply.
- **Pinned to the bottom** — a **📝 Your overall review** bar stays visible at
  the bottom of the viewport no matter where you scroll (collapsible), for the
  reviewer's own verdict after reading everything.

The two columns are **resizable** — drag the divider between them (default
**50/50**, double-click resets). On narrow screens the left panel stacks on top.
Styled with the Elsyca palette (Titillium Web / Roboto, JetBrains Mono for code).

Viewer controls:
- **Progress dock** (right edge) — two rings, `files viewed` and (in review
  mode) `findings reviewed`, filling and turning green as the reviewer works.
- **Unified / Split** toggle — lives on the **"Changes"** bar; switches inline
  vs side-by-side (persists; comments follow the line in both).
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
  they render offline and scale crisply. A spec with no Mermaid = no CDN call.
  A missing `svgFile` degrades to a warning box; the rest of the doc is fine.
- **Previewing inside Claude Code's Browser pane:** local `file://` outside the
  project renders as a static snapshot (no JS). To exercise the interactivity,
  serve over HTTP and use `preview_start`, or just open in a real browser with
  `--open`.
- **Line-ending warnings** from git (`LF will be replaced by CRLF`) on Windows
  are harmless; the patch is still valid.

## Build & test the driver itself

To re-verify the script/template after editing them, reproduce the smoke test:

```bash
node scripts/build-review.mjs --spec examples/review-spec.json --out review-smoke.html
```

The example's first PR points at a `pr-1.patch` that doesn't exist — the build
**degrades gracefully** (a "Diff file not found" banner, exit 0) rather than
crashing, and the second PR's inline `diff` still renders. Swap in a real patch
to see a full diff.
