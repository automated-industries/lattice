import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';
import { css } from '../../src/gui/app/css.js';

/**
 * GUI wiring for markdown artifacts: the file preview shows an "Artifact" badge
 * for a row flagged `artifact_type`, renders `text/markdown` content via the
 * rich `mdRender` (the document renderer — fenced code, ordered + unordered
 * lists, links, tables, blockquotes), and the chat client navigates to a
 * just-created artifact when the stream sends an `open` event.
 */
describe('gui artifact UI', () => {
  it('renders an artifact badge for files flagged artifact_type', () => {
    expect(appJs).toContain('row.artifact_type');
    expect(appJs).toContain('artifact-badge');
    expect(css).toContain('.artifact-badge');
  });

  it('renders markdown artifact content through the rich mdRender renderer', () => {
    expect(appJs).toContain("'text/markdown'");
    expect(appJs).toContain('MD_MIMES.indexOf(mime) >= 0');
    expect(appJs).toContain('mdRender(String(row.extracted_text)');
  });

  it('navigates to a just-created artifact on the chat stream "open" event', () => {
    expect(appJs).toContain("ev.type === 'open'");
    expect(appJs).toContain('openSearchHit(pendingOpen.table, pendingOpen.id)');
  });
});

/**
 * Behavioral test of the actual shipped renderer: pull escapeHtml + mdInline +
 * mdRender out of the appJs bundle and run them. The whole confirmed review
 * finding was "the tool promises GFM but the renderer only does a subset", so we
 * assert the GFM constructs an assistant emits in a document actually render —
 * and that HTML is escaped (no XSS via artifact content).
 */
function loadMdRender(): (s: string) => string {
  const start = appJs.indexOf('function escapeHtml');
  const end = appJs.indexOf('// Redact the userinfo');
  if (start < 0 || end < 0 || end <= start) throw new Error('could not locate renderer in appJs');
  const slice = appJs.slice(start, end);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(`${slice}\n;return mdRender;`) as () => (s: string) => string;
  return factory();
}

describe('mdRender (document markdown renderer)', () => {
  const md = loadMdRender();

  it('renders headings, bold/italic and inline code', () => {
    expect(md('# Title')).toContain('<h3>Title</h3>');
    expect(md('**b** *i* `c`')).toContain('<strong>b</strong>');
    expect(md('**b** *i* `c`')).toContain('<em>i</em>');
    expect(md('**b** *i* `c`')).toContain('<code>c</code>');
  });

  it('renders ordered AND unordered lists', () => {
    expect(md('1. one\n2. two')).toContain('<ol><li>one</li><li>two</li></ol>');
    expect(md('- a\n- b')).toContain('<ul><li>a</li><li>b</li></ul>');
  });

  it('renders fenced code blocks', () => {
    expect(md('```\nconst x = 1;\n```')).toContain('<pre><code>const x = 1;</code></pre>');
  });

  it('renders http/https links (and drops unsafe schemes)', () => {
    expect(md('[site](https://example.com)')).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener">site</a>',
    );
    // javascript: links are not linkified — the label survives, the href does not.
    expect(md('[x](javascript:alert(1))')).not.toContain('href="javascript:');
  });

  it('renders GFM tables', () => {
    const out = md('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(out).toContain('<table>');
    expect(out).toContain('<th>a</th>');
    expect(out).toContain('<th>b</th>');
    expect(out).toContain('<td>1</td>');
    expect(out).toContain('<td>2</td>');
  });

  it('renders blockquotes and horizontal rules', () => {
    expect(md('> quoted')).toContain('<blockquote>quoted</blockquote>');
    expect(md('---')).toContain('<hr>');
  });

  it('escapes HTML in artifact content (no XSS)', () => {
    const out = md('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  // Regression for the adversarial-review findings (all correctness, not XSS):
  it('keeps * inside a URL literal — no emphasis bleed into the href', () => {
    const out = md('[s](https://x.com/q?a*b*c)');
    expect(out).toContain('href="https://x.com/q?a*b*c"');
    expect(out).not.toContain('<em>');
  });

  it('handles CRLF line endings for headings and lists', () => {
    expect(md('# H\r\nnext')).toContain('<h3>H</h3>');
    expect(md('- a\r\n- b\r\n- c')).toContain('<ul><li>a</li><li>b</li><li>c</li></ul>');
  });

  it('does not let stray control bytes collide with the code-span placeholder', () => {
    const SOH = String.fromCharCode(1);
    const out = md('`SECRET` then ' + SOH + '0' + SOH + ' end');
    expect((out.match(/SECRET/g) || []).length).toBe(1); // not duplicated
    expect(out).not.toContain('undefined');
  });
});
