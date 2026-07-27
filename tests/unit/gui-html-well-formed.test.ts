import { describe, it, expect } from 'vitest';
import { validateHtmlWellFormed } from '../../src/gui/html-well-formed.js';

describe('validateHtmlWellFormed (HTML well-formedness gate)', () => {
  it('accepts a well-formed complete document', () => {
    const html =
      '<!doctype html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>';
    expect(validateHtmlWellFormed(html)).toBeNull();
  });

  it('accepts a well-formed HTML fragment with no doctype', () => {
    const html = '<div><p>Content</p></div>';
    expect(validateHtmlWellFormed(html)).toBeNull();
  });

  it('accepts a document with an inline script tag', () => {
    const html = '<!doctype html><html><body><script>console.log("hello");</script></body></html>';
    expect(validateHtmlWellFormed(html)).toBeNull();
  });

  it('rejects a document with unbalanced script tags (more openers than closers)', () => {
    const html = '<!doctype html><html><body><script>console.log("incomplete);</body></html>';
    const error = validateHtmlWellFormed(html);
    expect(error).toBeTruthy();
    expect(error).toContain('Script tag balance');
  });

  it('rejects a document with unbalanced script tags (more closers than openers)', () => {
    const html = '<!doctype html><html><body></script></script></body></html>';
    const error = validateHtmlWellFormed(html);
    expect(error).toBeTruthy();
    expect(error).toContain('Script tag balance');
  });

  it('rejects a document ending inside an unclosed tag', () => {
    const html = '<!doctype html><html><body><div class="test';
    const error = validateHtmlWellFormed(html);
    expect(error).toBeTruthy();
    expect(error).toContain('unclosed');
  });

  it('rejects a document truncated mid-attribute (caught as an unclosed tag)', () => {
    const html = '<!doctype html><html><body><div title="incomplete string';
    const error = validateHtmlWellFormed(html);
    expect(error).toBeTruthy();
    expect(error).toContain('unclosed tag');
  });

  it('does NOT false-positive on a healthy page whose tail has odd quote parity', () => {
    // Regression: a quote-parity heuristic over an arbitrary tail window rejected
    // healthy pages (the window can begin mid-attribute). A valid page with many
    // quoted attributes near the end must pass.
    const attrs = Array.from(
      { length: 30 },
      (_, i) => `<span class="c${i}" data-x="y${i}">s</span>`,
    ).join('');
    const html = `<!doctype html><html><body>${attrs}<script>var a = "ok";</script></body></html>`;
    expect(validateHtmlWellFormed(html)).toBeNull();
  });

  it('rejects a document ending with an incomplete element like <div', () => {
    const html = '<!doctype html><html><body><div';
    const error = validateHtmlWellFormed(html);
    expect(error).toBeTruthy();
    // Caught by the unclosed-tag check (which runs first); the incomplete-ending
    // check remains as a backstop for entity-style truncation (`&am`).
    expect(error).toMatch(/unclosed tag|incomplete HTML/);
  });

  it('rejects a document ending with an incomplete entity like &am', () => {
    const html = '<!doctype html><html><body>Price: &am';
    const error = validateHtmlWellFormed(html);
    expect(error).toBeTruthy();
    expect(error).toContain('incomplete HTML');
  });

  it('accepts escaped quotes in strings (e.g. \\" inside a string)', () => {
    const html =
      '<!doctype html><html><body><script>var x = "He said \\"hello\\"";</script></body></html>';
    expect(validateHtmlWellFormed(html)).toBeNull();
  });

  it('accepts a document with multiple script tags', () => {
    const html =
      '<!doctype html><html><body><script>var a = 1;</script><script>var b = 2;</script></body></html>';
    expect(validateHtmlWellFormed(html)).toBeNull();
  });

  it('rejects a real truncation: incomplete inline script at end', () => {
    const html =
      '<!doctype html><html><body><h1>Dashboard</h1><script>async function load() { const data = await lattice.query("tab';
    const error = validateHtmlWellFormed(html);
    expect(error).toBeTruthy();
    expect(error).toContain('Script tag balance'); // unclosed <script tag
  });

  it('accepts a document with trailing whitespace', () => {
    const html = '<!doctype html><html><body><h1>Hello</h1></body></html>\n\n  \t';
    expect(validateHtmlWellFormed(html)).toBeNull();
  });

  it('accepts a document with many lines', () => {
    const html = `<!doctype html>
<html>
<head>
  <title>Multiline</title>
  <style>
    body { font-family: sans-serif; }
  </style>
</head>
<body>
  <h1>Title</h1>
  <p>Content</p>
  <script>
    console.log("works");
  </script>
</body>
</html>`;
    expect(validateHtmlWellFormed(html)).toBeNull();
  });

  it('rejects a full document that opens <html> but never closes </html> (tag-boundary truncation)', () => {
    // Real corpse shape: zero scripts, truncation landing exactly after a clean
    // closing tag mid-table — every other check passes it.
    const html =
      '<!doctype html><html lang="en"><head><title>T</title></head><body><table><tr><th>Name</th><th>Contract Type</th>';
    const error = validateHtmlWellFormed(html);
    expect(error).toBeTruthy();
    expect(error).toContain('never closes </html>');
  });

  it('accepts an HTML fragment with no <html> wrapper at all', () => {
    expect(validateHtmlWellFormed('<div><p>fragment</p></div>')).toBeNull();
  });

  it('rejects a document that ends inside a script tag body', () => {
    // This has an opening <script> but no closing </script>.
    const html = '<!doctype html><html><body><script>console.log(';
    const error = validateHtmlWellFormed(html);
    expect(error).toBeTruthy();
    expect(error).toContain('Script tag balance');
  });
});
