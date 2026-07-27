# Review specification schema v1

Every generated review is driven by a validated JSON specification. Version 1
uses two required top-level fields:

- `schemaVersion`: always `1`.
- `mode`: one of `workspace`, `lm-analysis`, or `deep-audit`.

The portable JSON Schema is
[`schemas/review-spec.v1.schema.json`](schemas/review-spec.v1.schema.json).
The dependency-free runtime validator adds repository-aware checks and
human-oriented diagnostics.

## Modes

| Mode | When to use it | LM contract |
|---|---|---|
| `workspace` | Default. The reviewer inspects the facts and writes their own comments. | `prs[].review` is forbidden. |
| `lm-analysis` | The user explicitly asks for language-model findings. | Every PR has a `review` object; `comments` may be empty. |
| `deep-audit` | The user explicitly requests a deep audit, or accepts it for a high-risk change. | Same rendered contract as LM analysis, but the producing agent performs broader dependency, failure-mode, and test analysis. |

Deep audit is deliberately not selected automatically by the generator.
Choosing it changes the analysis workflow, not the meaning of a finding.

## Required structure

```json
{
  "schemaVersion": 1,
  "mode": "workspace",
  "title": "Review: harden authentication",
  "reviewId": "harden-authentication",
  "prs": [
    {
      "title": "Reject incomplete credentials",
      "diffFile": "changes.patch",
      "fileContentsFile": "context.files.json",
      "groupFile": "groups.json"
    }
  ]
}
```

`prs` must be non-empty. Each entry requires `title` and exactly one of
`diffFile` or `diff`. Relative files are resolved from the specification file.
An optional `fileContentsFile` points to the collector's bounded text bundle
and enables the per-file whole-file viewer. Deleted entries contain their base
version; binary, oversized, or unavailable entries carry an explanation
instead of content. SVG entries offer a sanitized Image view alongside their
exact Code view.
Reviewer-facing skill output uses one finalized LM-generated `groupFile` (or
embedded `changeGroups`) whose `provenance` is `"lm"`. Group files are resolved
relative to the specification and revalidated against the patch when the
review is built. `autoGroups: true` and the legacy file-level `groups` array
remain low-level compatibility inputs for direct builder users; they are not
the skill's review-generation workflow and may expose deterministic or
hand-authored labels.
PR ids and group ids must be unique.

## Optional GitHub publication context

A PR collected from GitHub may include the validated publication target:

```json
{
  "github": {
    "repository": "acme/widgets",
    "pullRequest": 42,
    "headSha": "abc123"
  }
}
```

All three fields are required when `github` is present. The generated review
uses them to prepare a structured publication plan. The packaged publisher
checks GitHub CLI authentication and compares `headSha` with the live PR before
showing its confirmation prompt and submitting one review. Local-only reviews
omit this object and retain Markdown copy/download.

Workspace specs cannot contain `review`. LM-analysis and deep-audit specs
require one per PR:

```json
{
  "verdict": "comment",
  "global": "The change is coherent, with one edge case to resolve.",
  "comments": [
    {
      "file": "src/auth.js",
      "line": 42,
      "severity": "concern",
      "body": "The null path reaches this dereference.",
      "confidence": 0.94,
      "rationale": "The preceding branch permits null and this line dereferences it."
    }
  ]
}
```

Removed-line anchors use `o` plus the old line number, such as `"o7"`.
Severity is `nit`, `suggestion`, `concern`, `question`, `praise`, or `comment`.
Every finding requires numeric `confidence` between 0 and 1 and a concise,
verifiable `rationale`. Focused analysis also enforces the fact-derived budget
written by the `prepare-lm-analysis` CLI.

## Validation

Validate without generating HTML:

```bash
bun run validate -- --spec .review/spec.json
```

Add `--json` for machine-readable diagnostics. Generation runs the same
validator and stops before writing output when the specification is invalid.
Each diagnostic includes a stable code, JSON path, explanation, and—where
useful—a corrective hint. Unknown schema versions are rejected.
