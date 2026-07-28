import assert from "node:assert/strict";
import test from "node:test";

import { renderInlineMarkdown } from "../src/inline-markdown.js";

test("finding Markdown renders every inline code span", () => {
  assert.equal(
    renderInlineMarkdown(
      "`get_inlet` returns `Inlet&`; `rv_policy::reference_internal` keeps it alive.",
    ),
    "<code>get_inlet</code> returns <code>Inlet&amp;</code>; " +
      "<code>rv_policy::reference_internal</code> keeps it alive.",
  );
});

test("finding Markdown keeps formatting outside code spans", () => {
  assert.equal(
    renderInlineMarkdown("Use **care** with `**literal**`.\nThen *verify* it."),
    "Use <strong>care</strong> with <code>**literal**</code>.<br>Then <em>verify</em> it.",
  );
});

test("finding Markdown supports backtick runs and remains HTML-safe", () => {
  assert.equal(
    renderInlineMarkdown("Use `` `quoted` `` and `<img src=x onerror=alert(1)>`."),
    "Use <code>`quoted`</code> and <code>&lt;img src=x onerror=alert(1)&gt;</code>.",
  );
  assert.equal(
    renderInlineMarkdown("<script>alert(1)</script>"),
    "&lt;script&gt;alert(1)&lt;/script&gt;",
  );
});
