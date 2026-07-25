# C++ reference review

This fixture models a small but realistic pull request with:

- a public C++ API migration to `std::chrono`;
- added standard-library includes;
- a capped exponential-backoff behavior change;
- CMake integration; and
- baseline, boundary, and cap tests.

It deliberately puts two `main()` functions in one CMake executable. The
checked-in LM review identifies that build defect, which makes the reference
useful for demonstrating findings as well as grouping.

Rebuild the semantic groups and review from the repository root:

```bash
node scripts/detect-mechanical-groups.mjs \
  --diff examples/cpp-reference/changes.patch \
  --out examples/cpp-reference/candidates.json
node scripts/finalize-lm-groups.mjs \
  --candidates examples/cpp-reference/candidates.json \
  --result examples/cpp-reference/grouping-result.json \
  --out examples/cpp-reference/groups.json
node scripts/validate-review-spec.mjs \
  --spec examples/cpp-reference/review-spec.json
node scripts/build-review.mjs \
  --spec examples/cpp-reference/review-spec.json \
  --out examples/cpp-reference/review.html
```

`groups.json` is checked in so the review builds immediately. `review.html` is
generated and intentionally not committed.
