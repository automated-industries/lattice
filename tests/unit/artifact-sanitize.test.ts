import { describe, it, expect } from 'vitest';
import { sanitizeSandboxedHtml } from '../../src/gui/artifact-sanitize.js';

describe('sanitizeSandboxedHtml', () => {
  it('removes a print/PDF button whose onclick calls a sandbox-blocked API', () => {
    const html =
      '<div><h1>Dashboard</h1>' +
      '<button onclick="window.print()">Print / PDF all tabs</button>' +
      '<table><tr><td>data</td></tr></table></div>';
    const out = sanitizeSandboxedHtml(html);
    expect(out.removed).toHaveLength(1);
    expect(out.removed[0]).toContain('Print / PDF all tabs');
    expect(out.html).not.toContain('window.print()');
    expect(out.html).not.toContain('<button');
    // The real content survives.
    expect(out.html).toContain('<h1>Dashboard</h1>');
    expect(out.html).toContain('<td>data</td>');
  });

  it('removes window.open / alert / confirm / prompt triggers', () => {
    for (const call of ['window.open("x")', 'alert("hi")', 'confirm("ok?")', 'prompt("name")']) {
      const out = sanitizeSandboxedHtml(`<button onclick='${call}'>Go</button><p>keep</p>`);
      expect(out.removed).toHaveLength(1);
      expect(out.html).not.toContain('<button');
      expect(out.html).toContain('<p>keep</p>');
    }
  });

  it('removes a javascript: link that runs a blocked action', () => {
    const out = sanitizeSandboxedHtml(
      '<a href="javascript:window.print()">print</a><span>x</span>',
    );
    expect(out.removed).toHaveLength(1);
    expect(out.html).not.toContain('javascript:');
    expect(out.html).toContain('<span>x</span>');
  });

  it('neutralizes a pop-out target but keeps the link and its text', () => {
    const out = sanitizeSandboxedHtml('<a href="/x" target="_blank">Open report</a>');
    expect(out.removed).toHaveLength(1);
    expect(out.html).toContain('Open report');
    expect(out.html).not.toContain('_blank');
    expect(out.html).toContain('href="/x"');
  });

  it('neutralizes a form submit target (no network in the preview)', () => {
    const out = sanitizeSandboxedHtml('<form action="/save" method="post"><input></form>');
    expect(out.removed).toHaveLength(1);
    expect(out.html).toContain('<form');
    expect(out.html).not.toContain('action="/save"');
  });

  it('leaves a clean artifact byte-identical with nothing removed', () => {
    const clean =
      '<div class="card"><h2>Revenue</h2><canvas id="c"></canvas>' +
      '<script>new Chart(document.getElementById("c"), {});</script></div>';
    const out = sanitizeSandboxedHtml(clean);
    expect(out.removed).toEqual([]);
    expect(out.html).toBe(clean);
  });

  it('does not touch a benign onclick that only mutates the DOM', () => {
    const html = '<button onclick="this.classList.toggle(\'x\')">Toggle</button>';
    const out = sanitizeSandboxedHtml(html);
    expect(out.removed).toEqual([]);
    expect(out.html).toBe(html);
  });
});
