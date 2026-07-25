# Real pull request measurement

Phase 5 adds a sidecar measurement file so review quality and performance can
be compared across real pull requests without putting repository contents into
telemetry.

Generate the review and its measurement together:

```bash
node scripts/build-review.mjs \
  --spec .review/spec.json \
  --out .review/review.html \
  --metrics-out .review/metrics.json
```

The generated record contains:

- patch size, file count, changed-line count, approximate spec tokens, and the
  patch-token volume kept out of the model context;
- HTML size and generation time;
- word-level diffs applied and skipped by the complexity guard;
- empty manual fields for review time, grouping quality, finding relevance,
  and notes.

After the review, fill in the manual fields:

- `reviewMinutes`: elapsed human review time;
- `lmInputTokens` and `lmOutputTokens`: actual model usage reported by the
  review run, when available;
- `groupingQuality`: 1–5, where 1 obscured the change and 5 made the decision
  structure immediately clear;
- `findingRelevance`: 1–5, where 1 was mostly noise and 5 meant every LM
  finding was worth acting on;
- `notes`: unusual repository characteristics, failure modes, or qualitative
  observations.

Keep measurement files local unless the pull request contains no sensitive
metadata and the project explicitly chooses to publish them. The sidecar does
not contain patch text, comments, or file contents.
