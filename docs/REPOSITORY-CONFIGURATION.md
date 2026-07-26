# Repository guidance

Trace Review combines deterministic repository facts with an LM's
change-specific grouping and analysis. Repository-specific policy should live
beside the code so the agent can apply it before writing groups or findings.

There is no hidden Trace Review configuration file in schema v1. Put concise
review policy in the repository's normal agent instructions (`AGENTS.md`,
`CLAUDE.md`, or the equivalent used by the team), and keep machine-detectable
conventions in paths, file names, and generated-file banners.

## Recommended instruction block

Adapt this example rather than copying it blindly:

```markdown
## Trace Review policy

- Treat authentication, authorization, migrations, public API changes, money,
  and concurrency as high risk.
- Require tests for behavior changes. Unit tests live in `test/`; integration
  tests live in `integration/`; `bun run test` runs the supported suite.
- Treat `src/generated/`, `vendor/`, `*.generated.ts`, and files containing
  `@generated` or `DO NOT EDIT` as generated. Review their source definition
  before the generated output.
- For high-risk changes, propose deep audit; do not select it silently.
```

The producing agent should use this policy when it writes the LM grouping
result: risk, reviewer checks, dependencies, and titles must still be grounded
in the current patch. Policy never overrides a validation failure or creates
evidence that is absent from the diff.

## Risk rules

Name the domains that deserve elevated attention and the evidence that triggers
them. Good rules are specific enough to verify:

| Rule | Useful trigger | Expected review response |
|---|---|---|
| Public compatibility | exported headers, schemas, CLI flags | medium/high risk; inspect consumers |
| Sensitive control | auth, permissions, secrets, payments | high risk; propose deep audit |
| State transition | migrations, queues, retries, concurrency | inspect rollback, ordering, and failure paths |
| Operational surface | deployment, CMake, packaging, feature flags | connect build/config changes to implementation |

Avoid declaring an entire repository high risk. That removes the distinction
used by the finding budget and deep-audit gate.

## Test conventions

Document where each test layer lives, how it is named, and the command that
runs it. Trace Review deterministically recognizes common `test`, `tests`,
`__tests__`, `spec`, and `*.test.*` / `*.spec.*` paths. If the repository uses
unusual names, the instructions should tell the LM which changes are tests and
which implementation groups they verify.

Also record intentional exceptions, such as generated snapshots or platform
tests that cannot run locally. The review should expose those gaps rather than
inventing a passing check.

## Generated files

Preflight detects common generated directories (`dist`, `build`, `coverage`,
`vendor`, `generated`, and `gen`), names such as `*.generated.*` and
`*.min.js`, and added-line banners including `@generated`, `DO NOT EDIT`, and
`automatically generated`.

For repository-specific outputs:

1. Prefer a standard generated directory or suffix.
2. Add a stable generated-file banner when the format allows comments.
3. Document the source-of-truth file and regeneration command in repository
   instructions.
4. Group the generator/source decision before its output and mark uncertain
   binary or generated content as needing inspection.

GitHub Linguist attributes can improve GitHub's display, but schema v1 does not
read `.gitattributes`; use one of the detectable conventions above when Trace
Review must classify the file deterministically.
