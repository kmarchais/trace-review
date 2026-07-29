# Adaptive repeated-change detectors

Trace Review discovers repeated changed lines and parameterized token patterns
automatically. It extracts matched rows from mixed hunks, assigns each changed
row once, and leaves the residual rows available for semantic grouping.

When a repeated transformation has a shared purpose that cannot be inferred
safely from token structure, an agent can author a bounded detector rule. Rules
are declarative data: they cannot access the filesystem, start processes, or
execute repository content.

## Rule format

```json
{
  "schemaVersion": 1,
  "rules": [
    {
      "id": "header-guard-migration",
      "title": "Replace header guards with pragma once",
      "minimumFiles": 3,
      "operations": [
        { "side": "add", "pattern": "# pragma once", "location": "start" },
        { "side": "delete", "pattern": "# ifndef $guard", "location": "start" },
        { "side": "delete", "pattern": "# define $guard", "location": "start" },
        { "side": "delete", "pattern": "# endif // $guard", "location": "end" }
      ]
    }
  ]
}
```

Patterns are whitespace-insensitive token sequences. A token beginning with
`$` binds a value; reusing the name requires the same value within one file.
`location` is optional and accepts `start`, `end`, or `any`.

`start` means the changed line is within the first twelve lines. `end` means it
appears in the file's last changed hunk. Rules match modified files by default,
so boilerplate inside an entirely new or deleted file stays with that artifact.

## Optional refinement workflow

After `prepare`, inspect the candidate facts and patch. If a repeated
transformation is still mixed into semantic changes:

1. Write `.review/detector-rules.json`.
2. Run:

   ```bash
   node <skill-dir>/scripts/trace-review.mjs refine \
     --input .review/analysis-input.json \
     --rules .review/detector-rules.json
   ```

3. Read the updated `analysis-input.json`, then write the normal combined
   result and run `finish`.

Refinement records the rule count and SHA-256 hash in the analysis input and
metrics. Invalid rule sets stop before matching. The generated review still
provides raw Git order as the authoritative complete patch.
Final grouping validation rejects repeated-pattern units that are mixed with
residual units or split across multiple semantic groups.

## Automatic discovery

The automatic pass uses indexed signatures rather than all-pairs comparisons:

- exact non-empty changed lines;
- parameterized token shapes with stable identifiers;
- compatible repeated deletion/addition pairs as replacements.

Low-information punctuation-only lines require at least three matching files.
Exact matches take precedence over parameterized matches, and every claimed
changed row has one pattern assignment.

Automatic replacement pairing requires matching token shapes, file support,
and hunk placement. Use an adaptive rule when the old and new syntax have
different structures or when several co-occurring edits form one purpose.
