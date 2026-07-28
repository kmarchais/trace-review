import assert from "node:assert/strict";
import test from "node:test";

import { renderFindingMarkdown, renderInlineMarkdown } from "../src/inline-markdown.js";

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

test("finding Markdown renders fenced code as one block", () => {
  assert.equal(
    renderFindingMarkdown(
      [
        "Capture the status:",
        "",
        "```bash",
        "py_cov_status=0",
        "... pytest ... --cov-fail-under=90 || py_cov_status=$?",
        "```",
        "",
        "Then gate at the end.",
      ].join("\n"),
    ),
    [
      "Capture the status:<br><br>",
      '<pre class="md-code"><code class="language-bash">py_cov_status=0\n' +
        "... pytest ... --cov-fail-under=90 || py_cov_status=$?</code></pre>",
      "<br>Then gate at the end.",
    ].join(""),
  );
});

test("finding Markdown keeps fenced code and language metadata HTML-safe", () => {
  assert.equal(
    renderFindingMarkdown('```html" onmouseover="alert(1)\n<img src=x onerror=alert(2)>\n```'),
    '<pre class="md-code"><code>&lt;img src=x onerror=alert(2)&gt;</code></pre>',
  );
});
