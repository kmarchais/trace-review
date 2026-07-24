# Review export design

## Goal

Let a reviewer hand a useful, actionable review to a pull-request author without
forcing them to reconstruct the context of every comment.

## Two export levels

### Shareable Markdown report (first release)

The default **Share review** action creates a paste-ready Markdown report with:

- the pull request title and URL;
- the overall verdict;
- accepted, dismissed, and open AI findings;
- each file and line comment, including its path, side, line number, and short
  code excerpt;
- a GitHub permalink for every anchor when pull-request context is available.

It works in a PR conversation, issue, chat, email, or a local file. It cannot
create native GitHub inline threads, but the author can immediately locate each
comment from the path, line, excerpt, and link.

### Native GitHub review (optional publish action)

Provide a separate **Publish to GitHub** action only when a pull request has
been detected or selected and GitHub authentication is available. It submits one
GitHub review with a summary body and one native inline comment for each eligible
line or block comment, using the correct path, diff side, line range, and head
commit.

Before publishing, show a preview and require explicit confirmation. Clearly
list comments that cannot be anchored—such as removed, stale, or rejected diff
locations. Keep those in the Markdown body rather than silently dropping them.

## Stable review anchors

Store more than a display line number for every comment: the file path, old/new
side, line number or range, pull-request head SHA, and a compact surrounding-code
fingerprint. After regeneration, comments should either reattach confidently,
be flagged as stale, or remain visible as unanchored notes.

## Suggested interface

Rename **Export comments** to **Share review**. Its dialog has two tabs:

1. **Markdown report** — copy or download; always available.
2. **GitHub review** — only with valid PR context; preview native comments and
   the unanchored fallback section before the final publish button.

Ship the improved Markdown report and stable anchors first. Add native publishing
after PR-context collection and anchor validation are in place.
