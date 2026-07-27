/**
 * Well-formedness validation for authored HTML documents.
 *
 * Detects structurally mutilated pages (e.g. output truncated mid-token by the
 * authoring model) that would break rendering or execution. Kept conservative
 * to avoid false positives from unusual but valid HTML.
 */

/**
 * Check if an HTML document is structurally well-formed.
 *
 * Returns a validation error message (falsy if well-formed) when the document is
 * mutilated (e.g. truncated mid-token, missing closing tags, or ending inside
 * an element/attribute/script). Designed to catch output that the authoring model
 * truncated at its token budget, where a document ends prematurely with
 * unbalanced tags or dangling quotes.
 *
 * Conservative checks only: this validates "is the document broken" not "is it
 * valid HTML." The check is cheap and deterministic.
 */
export function validateHtmlWellFormed(html: string): string | null {
  // Check 1: Every <script ...> opener must have a matching </script> closer.
  // Count balance: the author's prompts always include a full inline <script> block
  // at the end if needed, so truncation within <script> is common and fatal
  // (the rest of the HTML won't execute).
  const scriptOpenCount = (html.match(/<script[^>]*>/gi) ?? []).length;
  const scriptCloseCount = (html.match(/<\/script>/gi) ?? []).length;
  if (scriptOpenCount !== scriptCloseCount) {
    return `Script tag balance error: ${String(scriptOpenCount)} opening <script> tag(s), but ${String(scriptCloseCount)} closing </script> tag(s). The page may be truncated.`;
  }

  // Check 2: Detect documents ending mid-script, mid-string, or mid-attribute.
  // A well-authored page ends cleanly at a closing tag (or at least at a tag boundary),
  // not dangling inside a string literal or inside an attribute value.
  // Signs of truncation:
  // - Ends inside a quoted string (dangling quote that never closes)
  // - Ends inside an opening tag (< but no closing >)
  // - Ends with an unescaped backslash (likely mid-escape sequence)
  const trimmed = html.trimEnd();

  // Check for unclosed tag: the document must not end inside a tag — i.e. the
  // LAST '<' must be followed by a '>' somewhere. (Guarding on the last bracket,
  // not on the whole document containing '>', because every real page contains
  // thousands of closed tags before a truncated final one.)
  const lastOpenBracket = trimmed.lastIndexOf('<');
  if (lastOpenBracket !== -1 && !trimmed.includes('>', lastOpenBracket)) {
    return 'Document ends inside an unclosed tag. The page may be truncated.';
  }

  // NOTE deliberately NOT checked: dangling-quote parity. Counting quotes in an
  // arbitrary tail window is parity-broken (the window can start mid-attribute),
  // which false-positives on healthy pages — and the real truncation cases are
  // already caught: mid-script truncation trips the script balance check above,
  // and mid-attribute truncation trips the unclosed-tag check.

  // Check 3: The document should not end with an incomplete tag like `<div` or
  // an incomplete HTML entity like `&am`.
  if (/[<&]\w*$/.test(trimmed)) {
    return 'Document ends with an incomplete HTML element or entity. The page may be truncated.';
  }

  // Final check (deliberately LAST so the more specific diagnostics above win):
  // a full document must actually END. The authors always produce a complete
  // standalone page, so a document that opens <html and never closes </html> is
  // truncated — even when the cut lands exactly on a tag boundary with no
  // scripts involved (a real stored corpse ended mid-<table> with a clean </th>
  // as its final bytes and zero script tags: every other check passes it).
  if (/<html[\s>]/i.test(html) && !/<\/html>/i.test(html)) {
    return 'Document opens <html> but never closes </html>. The page may be truncated.';
  }

  return null;
}
