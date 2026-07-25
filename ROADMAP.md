# HTML Review Roadmap

## Phase 0 — Contract and Quality Foundation ✅ Complete

- [x] Define user modes: a default review workspace, explicit LM analysis, and an optional deep audit.
- [x] Write a versioned specification schema and a validator with actionable diagnostics.
- [x] Build a fixture suite: small and large diffs, C++, CMake, renames, binaries, generated files, groups, and comments.
- [x] Automate generation, HTML structure, performance, and visual-regression tests.

**Delivered:** a dependency-free schema and validation layer, representative fixtures, structural and visual regression coverage, and a large-diff performance budget.

## Phase 1 — Deterministic Collection and Pull Request Context ✅ Complete

- [x] Create `review-preflight`: diff inventory, Git patch checks, size, file types, whitespace errors, binaries, and generated files.
- [x] Create `collect-pr-context`: detect the current branch's pull request, fall back to a local diff, and support explicit selection by number or URL.
- [x] Collect the title, description, branches, labels, checks, reviews, and GitHub comments into validated local context.
- [x] Add usage options for automatic PR detection, explicit PR selection, and intentional disabling of remote context.

**Delivered:** validated local context and patch artifacts with explicit diagnostics and safe local fallbacks.

## Phase 2 — Reliable Change-Grouping Intelligence ✅ Complete

- [x] Create `detect-mechanical-groups` for renames, formatting, lockfiles, imports, and repeated includes.
- [x] Evolve candidate groups to work at hunk or line-range granularity.
- [x] Add intent, evidence, risk, confidence, and reviewer checks to every group.
- [x] Add “Needs inspection” and “Unclassified” candidate areas; reject silent overlaps.
- [x] Use deterministic classification as candidate evidence, then let the LM generate change-specific final groups.
- [x] Validate LM grouping for complete, non-overlapping change-unit coverage, grounded titles, rationale, and dependency references.
- [x] Keep final groups read-only for the reviewer.
- [x] Build a change-dependency graph linking definitions, usages, configuration or build changes, and associated tests.
- [x] Compute and validate a dependency-aware reading order.

**Delivered:** LM-authored decision groups grounded in deterministic facts. Within a group, each file renders once with that decision's hunks; a file may participate in multiple groups when separate hunks belong to separate decisions.

## Phase 3 — Focused LM Analysis ✅ Complete

- [x] Separate workspace, LM-analysis, and deep-audit modes.
- [x] Give the LM the scripts' fact pack and candidate groups instead of the raw diff as its only input.
- [x] Require sparse, verifiable, line-anchored findings with confidence and a brief rationale.
- [x] Reserve deep-audit mode for high-risk pull requests or explicit requests.
- [x] Enforce a fact-derived finding budget and validate anchors against changed ranges.

**Delivered:** focused, attributable LM findings with explicit evidence, bounded volume, and validated diff anchors.

## Phase 4 — Review Experience and Design System ✅ Complete

- [x] Define the design system: typography, neutral palette, semantic colors, spacing, surfaces, shadows, accessible focus, and light/dark tokens.
- [x] Rebuild the journey into three stages: understand the pull request, validate groups, and inspect evidence.
- [x] Open directly on Inspect evidence so the code diff is visible on landing.
- [x] Replace the fixed 50/50 layout with an adaptive, collapsible context column and focus mode.
- [x] Simplify findings, the overall-review bar, and progress so the diff remains the main surface.
- [x] Make LM-generated groups the center of the interface with compact intent cards and progressive evidence disclosure.
- [x] Add “Read first” and “Dependent changes” relationships with source-accurate definition previews.
- [x] Keep an explicit switch back to raw Git order.
- [x] Consolidate a file's hunks once per group while allowing the file across distinct semantic groups.
- [x] Scope Viewed state and grouped progress to each file-within-decision item; aggregate those states deliberately in raw Git order.
- [x] Preserve and migrate existing saved review state.

**Delivered:** a calm, diff-first review workspace with change-specific semantic groups, independent decision progress, raw-order verification, and 58 passing tests.

## Phase 5 — Robustness on Real Pull Requests ✅ Complete

- [x] Anchor comments to a diff fingerprint and display orphaned comments.
- [x] Sanitize links and SVG, then test untrusted pull-request content.
- [x] Add progressive rendering, word-level-diff limits, and tests on very large pull requests.
- [x] Measure on real pull requests: tokens, generation time, review time, grouping quality, and finding relevance.

**Expected outcome:** a secure tool that remains trustworthy on large repositories.

**Delivered:** fingerprint-backed comments with explicit orphan recovery,
allowlisted links and SVG, strict Mermaid rendering, bounded word-level
comparison, progressive diff mounting, and privacy-preserving real-PR metrics.

## Phase 6 — Finish and Distribution ✅ Complete

- [x] Update documentation, examples, and screenshots for the new workflow.
- [x] Add per-repository configuration guidance: risk rules, test conventions, and generated-file detection.
- [x] Document known limitations and offline behavior.
- [x] Prepare a reference demo using a C++ pull request with includes, CMake, tests, and a behavioral change.
- [x] Define release criteria: schema validation, passing tests, accessibility, performance target, and manual interface review.

**Expected outcome:** a skill ready for installation, team adoption, and regular use.

**Delivered:** refreshed workflow documentation and imagery, honest
repository-policy and offline guidance, a reproducible C++/CMake reference
review with semantic groups and an LM finding, and measurable automated plus
manual release gates.
