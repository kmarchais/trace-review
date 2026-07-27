# Release criteria

A Trace Review release candidate is ready only when every automated gate passes
and a person completes the interface checks below.

## Automated gates

Run from the repository root:

```bash
bun run check:release-tag -- v0.1.0
bun run check
bun run bundle:skill
bun run validate:example
bun run validate -- \
  --spec examples/cpp-reference/review-spec.json
bun run review -- \
  --spec examples/cpp-reference/review-spec.json \
  --out examples/cpp-reference/review.html \
  --metrics-out examples/cpp-reference/metrics.json
```

Required results:

- the release tag matches the version in `package.json`;
- the complete test suite passes;
- `dist/trace-review-skill.zip` builds and its isolated smoke test passes;
- the general example and C++ reference spec pass schema validation;
- malicious-content, comment-orphan, grouping, and LM finding tests remain
  green;
- the 300-file fixture generates in under 5 seconds on the test machine; and
- the reference review builds without missing assets or diagnostics.

Do not commit the generated reference HTML or metrics sidecar.

## Accessibility and manual interface review

Check the reference review in current Chromium and Firefox at desktop and
narrow viewport sizes:

- keyboard focus is always visible and stage, group, diff, comment, theme, and
  export controls are reachable;
- headings and landmarks give the page a sensible reading order;
- light, dark, and high-contrast/forced-color presentation remain legible;
- the context column collapses, Focus mode exits, and unified/split plus
  grouped/Git order retain state;
- findings navigate to the correct changed line;
- line and file comments survive reload, and a deliberately changed patch
  exposes an orphan rather than dropping it;
- progressive rendering reaches the final file and progress totals are exact;
  and
- the page remains useful with network access disabled.

Record the browser versions, operating system, reviewer, date, and any accepted
exceptions in the release PR.

Use [releases/v0.1.0.md](releases/v0.1.0.md) as the release body and
record the manual-review evidence beneath its validation section.

## Distribution check

Run the **Release skill bundle** workflow with the version tag from
`package.json`. It builds a tag-only distribution commit, so compiled runtime
files remain absent from `main`.

Before publishing the release, the workflow installs the generated tag through
both supported installers:

```bash
gh skill install kmarchais/trace-review trace-review@v0.1.0 --dir <temporary-directory>
npx skills add \
  https://github.com/kmarchais/trace-review/tree/v0.1.0/skills/trace-review \
  --agent codex --yes
```

The workflow runs the installed example validator with Node 22 before it
publishes the release and attaches `trace-review-skill.zip`. Afterward, run one
workspace review plus one LM-analysis review in a disposable repository.
Confirm that the documented Node, Git, and optional GitHub CLI requirements are
sufficient and that no repository contents are written outside `.review/`
unless the user chooses another output path.
