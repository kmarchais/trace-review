# Review specification schema v1

Every generated review is driven by a validated JSON specification. Version 1
uses two required top-level fields:

- `schemaVersion`: always `1`.
- `mode`: one of `workspace`, `ai-analysis`, or `deep-audit`.

The portable JSON Schema is
[`schemas/review-spec.v1.schema.json`](schemas/review-spec.v1.schema.json).
The dependency-free runtime validator adds repository-aware checks and
human-oriented diagnostics.

## Modes

| Mode | When to use it | AI contract |
|---|---|---|
| `workspace` | Default. The reviewer inspects the facts and writes their own comments. | `prs[].review` is forbidden. |
| `ai-analysis` | The user explicitly asks for AI findings. | Every PR has a `review` object; `comments` may be empty. |
| `deep-audit` | The user explicitly requests a deep audit, or accepts it for a high-risk change. | Same rendered contract as AI analysis, but the producing agent performs broader dependency, failure-mode, and test analysis. |

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
      "diffFile": "changes.patch"
    }
  ]
}
```

`prs` must be non-empty. Each entry requires `title` and exactly one of
`diffFile` or `diff`. Relative files are resolved from the specification file.
Phase 2 grouping uses at most one of `groupFile`, embedded `changeGroups`,
`autoGroups: true`, or the legacy file-level `groups` array. Group files are
resolved relative to the specification and revalidated against the patch when
the review is built.
PR ids and group ids must be unique.

Workspace specs cannot contain `review`. AI-analysis and deep-audit specs
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
      "body": "The null path reaches this dereference."
    }
  ]
}
```

Removed-line anchors use `o` plus the old line number, such as `"o7"`.
Severity is `nit`, `suggestion`, `concern`, `question`, `praise`, or `comment`.
An optional numeric `confidence` is between 0 and 1.

## Validation

Validate without generating HTML:

```bash
node scripts/validate-review-spec.mjs --spec .review/spec.json
```

Add `--json` for machine-readable diagnostics. Generation runs the same
validator and stops before writing output when the specification is invalid.
Each diagnostic includes a stable code, JSON path, explanation, and—where
useful—a corrective hint. Unknown schema versions are rejected.
