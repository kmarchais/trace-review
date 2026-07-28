# Next Work

## 1. Large-review navigation

Improve navigation for reviews containing many files and findings.

Status: implemented by the large-review navigation change.

Virtualization decision: retain the existing progressive renderer. Navigation
indexes only the active review view when the Files drawer is open, and its
300-file search-and-filter benchmark must complete within 250 ms. Reconsider
viewport virtualization if that budget or the existing large-diff generation
budget begins to fail.

- Add combinable filters for:
  - unread files;
  - open findings;
  - finding severity;
  - tests;
  - generated files;
  - risk or decision group.
- Add full-text search across file paths, diff content, and findings.
- Keep filter, search, progress, and navigation state consistent between
  grouped and Git order.
- Evaluate true viewport virtualization if progressive rendering is no longer
  sufficient for very large diffs.

### Completion criteria

- Filters can be combined and cleared without losing review decisions.
- Search results navigate to the correct file and line.
- Keyboard navigation and narrow-screen behavior remain usable.
- Existing large-diff performance budgets continue to pass.

## 2. External review evidence

Attach test, lint, coverage, and CI results to the review without giving the
generated HTML access to credentials or arbitrary commands.

- Define a versioned JSON evidence format.
- Support explicit states such as `passed`, `failed`, `not-run`, and `unknown`.
- Link evidence to repositories, commits, files, and lines when those anchors
  are available.
- Distinguish verified facts from model inferences in findings.
- Render evidence summaries and provide access to bounded diagnostic details.
- Keep evidence optional so local diff reviews remain lightweight.

### Completion criteria

- Invalid or stale evidence is rejected with actionable diagnostics.
- Evidence for a different commit is never presented as current.
- The review clearly labels verified, failed, and unverified claims.
- Sensitive logs and credentials are not embedded automatically.

## 3. Fully offline reviews

Remove the remaining CDN dependencies while preserving the self-contained
review document.

- Bundle only the syntax-highlighting languages required by the reviewed diff.
- Pre-render Mermaid diagrams to sanitized SVG during review generation.
- Preserve readable plain-code and source fallbacks when preprocessing fails.
- Measure and limit the resulting HTML size increase.
- Test direct `file://` use with network access disabled.

### Completion criteria

- Generated reviews make no network requests.
- Syntax highlighting and diagrams remain available offline.
- Unknown languages and invalid diagrams fail safely.
- Offline behavior passes the desktop, narrow-viewport, dark-mode, and
  high-contrast interface checks.

## 4. GitHub publication validation and later expansion

Do not expand the GitHub integration until the existing publication flow has
been tested manually in a disposable repository.

### Validate the current flow

- Publish a review containing:
  - a single-line comment;
  - a range comment;
  - a suggested change;
  - a summary fallback.
- Verify cancellation and authentication failures.
- Verify that a changed pull-request head blocks stale publication.
- Confirm that a failed publication does not lose the generated plan.
- Record the tested operating system, GitHub CLI version, browser, and result.

### Consider only after validation

- Import existing review threads.
- Track resolved and unresolved conversations.
- Prepare replies without duplicating existing comments.
- Reconcile imported threads after the pull-request head changes.

### Completion criteria

- The current publication workflow has documented manual evidence.
- Any discovered publication defects are fixed before adding new capabilities.
- Later thread synchronization has an explicit, idempotent data model.

## Recommended delivery order

1. Large-review navigation.
2. External review evidence.
3. Fully offline reviews.
4. GitHub validation, followed by a separate decision on thread integration.

Keep these changes in separate delivery slices: navigation, evidence,
offline packaging, and GitHub synchronization have different risks and should
remain independently reviewable.
