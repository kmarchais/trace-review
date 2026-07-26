# Known limitations and offline behavior

## Known limitations

- Schema v1 has no parsed per-repository configuration file. Repository policy
  is agent guidance; final groups and findings are still validated only against
  the collected patch and fact pack.
- Syntax-aware presentation is language-aware highlighting, not compilation or
  semantic program analysis. A review does not replace project builds, tests,
  linters, security tooling, or domain expertise.
- Automatic GitHub context needs an installed, authenticated `gh`. Automatic
  mode falls back visibly to a local diff; explicit PR selection fails instead
  of silently reviewing different content.
- Diff fingerprints relocate comments only when context or content identifies a
  unique line. Ambiguous or changed anchors are preserved as orphaned comments
  for manual placement.
- Binary files are inventoried but their contents are not rendered. Generated
  files are heuristic unless they use a documented detectable convention.
- Very large diffs render progressively and may skip word-level highlighting
  for pathological lines or token counts. The complete line diff remains
  available.
- A self-contained review stores comments and viewed state in browser
  `localStorage`. Those decisions are not embedded into the HTML and do not
  travel with a copied file; export them as Markdown.
- Native GitHub review publishing is not implemented yet; it is tracked in
  [issue #13](https://github.com/kmarchais/trace-review/issues/13). Copying and
  downloading Markdown remain the supported handoff paths.

## Offline behavior

The generated HTML, diff, summaries, comments, groups, progress, export, system
fonts, and inline SVG work offline. Plain code rendering is used when CDN
resources are unavailable.

The following enhancements need network access:

- highlight.js syntax colors; and
- Mermaid rendering.

Prefer sanitized inline SVG for diagrams that must work offline. If Mermaid is
unavailable, its source remains visible rather than blocking the review.

Opening the document directly with `file://` works in a normal browser. Some
embedded preview panes disable local JavaScript outside the project; serve the
file over a local HTTP server or open it in the system browser to test the full
interactive experience.
