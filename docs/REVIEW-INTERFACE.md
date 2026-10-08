# Review interface reference

This page describes the generated review page, hand-authored spec features,
and the export paths. The skill instructions link here instead of repeating it.

## Summary blocks

Each block is `{ type, width?, ... }`. Only add what helps: a tiny change may
need a single `prose` block. Blocks render in the left PR panel; `width`
(`full`, `two-thirds`, `half`, `third`) is a layout hint.

| `type` | Fields | Use for |
|--------|--------|---------|
| `prose` | `md` | Markdown text. |
| `diagram` | `svgFile` \| `svg` \| `mermaid`, `title?`, `surface?` | A picture. Prefer SVG (crisp, offline); Mermaid needs internet. `surface` is `light` by default or `dark` for a dark-canvas SVG. |
| `stats` | `items: [{label, value, accent?}]` | Metric tiles. `accent`: `green`, `red`, or `orange`. |
| `table` | `headers?`, `rows: [[...]]` | Component, risk, or impact tables (plain text cells). |
| `callout` | `md`, `variant?` (`info`/`warn`/`success`), `title?` | A note not to miss. |
| `heading` | `text`, `level?` | A sub-heading. |

## Change groups

Reviewer-facing output uses a finalized `groupFile` (or embedded
`changeGroups`). Generated groups work at changed-row granularity and show
their rationale. Repeated rows are projected out of mixed hunks so they appear
only in their pattern group, while Git order keeps the complete patch. In
LM-analysis and deep-audit modes they also show dependencies and a suggested
reading order. Deterministic quick reviews preserve classifier order without
presenting it as a recommendation. A file appears once per group and may
appear in several groups when its hunks implement separate decisions.

When a model result leaves changes unassigned, `finish` places them in their
deterministic candidate group and records each placement under
`placement.autoPlaced` in `groups.json` and as `autoPlacedChanges` in
`run-metrics.json`.

### Legacy file-level groups

Hand-authored specs may use a `groups` array instead:

```json
"groups": [
  { "id": "inc", "kind": "mechanical", "title": "Add #include \"logging.h\"",
    "note": "Identical include at the top of each unit.",
    "files": ["src/a.cpp", "src/b.cpp", "src/c.cpp"] },
  { "id": "core", "kind": "feature", "title": "Wire up the logger",
    "files": ["src/logger.cpp"] }
]
```

- Each group renders as a labelled band with its files and one **Reviewed**
  checkbox that marks every file viewed after a confirmation naming the group,
  file count, and paths.
- `kind`: `mechanical`, `refactor`, `feature`, `fix`, `test`, `docs`, `other`.
  `mechanical` groups collapse their files by default; override with
  `collapsed`.
- Unlisted files fall into an **Other changes** group.
- Put a file with a repeated change and a distinct change in the substantive
  group only.
- Pure renames are grouped automatically into a collapsed **Renamed (no
  content change)** group.

## Re-importing the reviewer's comments

The reviewer clicks the **+** in a line gutter to comment (unified or split
view), writes an overall note, and in an LM mode accepts, dismisses, or replies
to findings. Then:

- **Copy comments** copies the Markdown report to the clipboard.
- **Share review → Markdown report** previews the report with copy and
  **Download .md** (`review-comments-<reviewId>.md` in Downloads).
- **Share review → GitHub review** appears only when the spec has validated
  GitHub context. Download the publication plan, then run:

  ```bash
  node <skill-dir>/scripts/publish-github-review.mjs \
    --plan "$HOME/Downloads/github-review-owner-repository-123.json"
  ```

  The publisher requires authenticated `gh`, rejects a changed PR head,
  repeats the preview, and asks for confirmation before submitting one
  review. Pass `--confirm` only after the user approved that exact preview.

The export lists each finding as `[accepted]`, `[dismissed]`, or `[open]`,
then the reviewer's own overall, per-file, and per-line comments. Act on
accepted findings and the reviewer's comments; leave dismissed ones alone.

## Serve mode

`trace-review serve [<target>]` (or `--serve`) builds the review, then serves
it from `127.0.0.1` on a random port (`--port` picks one; `--host` accepts only
`127.0.0.1`, `localhost`, or `::1`) and opens `http://127.0.0.1:<port>/#token=…`.
The page reads the token from the fragment, keeps it in this tab's session
storage, and sends it in a header on every API call. The server rejects any
other `Host`, any mutating request from another `Origin`, and bodies that are
not JSON.

- State lives in `.review/state/<reviewId>.json` with a revision number. The
  page sends the revision it started from; the server answers `409` on a
  conflict and the page merges its own edits over the newer copy. Images are
  files under `.review/state/<reviewId>/attachments/`.
- The server keeps `.review/state/<reviewId>.feedback.md` equal to the
  Markdown export and serves it as JSON at `GET /api/feedback`. The agent reads
  the same content with `trace-review.mjs feedback --latest` (add `--json` for
  structured items, or pass a review ID).
- Writing `.review/lm/result.json` re-runs `finish`; writing `.review/spec.json`
  rebuilds the page. The browser then reloads, and comments follow their
  fingerprints. A failed rebuild shows its error on the page.
- **Ask**, **Explain**, and **Propose fix** appear on a selected range and on
  each finding. The server sends the file path, numbered rows, finding, and
  question to the `--llm` CLI with the same read-only restrictions as the
  review run. Answers are saved as a thread under the lines; a fix answer
  offers **Add as suggested change**. The buttons stay disabled when no CLI is
  available.
- With GitHub context, the GitHub tab adds a verdict choice and **Publish to
  GitHub…**, which shows the exact preview before the server publishes.

## Page layout

The page opens on **Review changes** with the diff, findings, comments, and
PR context visible. **Review groups** is an optional view for intent,
dependencies, and reading order.

- **Left, the PR** (only with `url`, `summary`, `diagrams`, or `blocks`): a
  sticky panel with title, `+/-` stats, link, and summary blocks.
- **Right, the review**: in LM modes a verdict-coloured review card, then the
  severity-coloured findings, then the reviewer's line comments; below that,
  the **Changes** block with collapsible per-file diffs, syntax highlighting,
  dual line numbers, sticky file headers, file comments, **Viewed** toggles,
  and fullscreen.
- **Bottom right**: a collapsible **Your overall review** drawer.

The context column is resizable (default 34/66; double-click resets) and
collapsible; **Focus** hides surrounding chrome. Viewer controls:

- **Files** drawer: a compact tree with per-file `+/-` and viewed state;
  searches paths, diff content, and findings, with filters for unread files,
  open findings, tests, generated files, severities, risks, and groups.
- **Progress dock**: rings for items viewed and findings reviewed in the
  active PR, with Previous/Next finding controls in review mode.
- **Unified / Split** toggle on the Changes bar (persisted).
- **Range selection**: drag across gutters within one hunk and side to add a
  block comment, a GitHub suggested change (new side only), or a
  syntax-coloured before/after export (PowerPoint table, HTML, SVG, PNG).
- **Git order / Grouped order**: return to the raw patch sequence at any time.
- **Theme**: follows the OS by default; the button cycles a session override.
- **Clear review**: after confirmation, removes comments, images, viewed
  state, finding decisions, and grouping choices for this review.

## Gotchas

- From `file://`, comments persist in the reviewer's browser (localStorage),
  not in the HTML file, and survive rebuilds only while `reviewId` is
  unchanged. Serve mode stores them on disk instead.
- After a rebuild, line comments follow a contextual fingerprint; ambiguous
  ones move to an **Orphaned comments** tray.
- Markdown links accept only HTTP(S), `mailto:`, or fragments; inline SVG is
  sanitized and Mermaid runs in strict mode.
- Very large diffs render progressively; word-level highlighting is skipped for
  pathological lines.
- Mermaid needs internet; SVG diagrams do not. A missing `svgFile` degrades to
  a warning box.
- Claude Code's Browser pane renders `file://` outside the project as a static
  snapshot; serve over HTTP or open in a real browser.
- Git line-ending warnings on Windows are harmless.
