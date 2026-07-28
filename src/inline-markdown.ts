function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderText(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");
}

function normalizeCodeSpan(value: string): string {
  const normalized = value.replace(/\n/g, " ");
  if (
    normalized.length >= 2 &&
    normalized.startsWith(" ") &&
    normalized.endsWith(" ") &&
    /\S/.test(normalized)
  ) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

/**
 * Render the inline Markdown subset accepted in findings. Code spans are
 * tokenized before emphasis so their contents always remain literal.
 */
export function renderInlineMarkdown(value: unknown): string {
  const source = String(value ?? "");
  const codeSpan = /(`+)([\s\S]*?)\1/g;
  let html = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = codeSpan.exec(source))) {
    html += renderText(source.slice(cursor, match.index));
    html += `<code>${escapeHtml(normalizeCodeSpan(match[2]))}</code>`;
    cursor = match.index + match[0].length;
  }

  return html + renderText(source.slice(cursor));
}
