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

  it('does NOT strip in-page methods that merely share a name with a window method', () => {
    // sidebar.open / ctx.moveTo / indexedDB.open are ordinary DOM/JS that work under the
    // sandbox — only window.open/window.print/etc. are blocked. A false strip would delete
    // a working control.
    for (const call of [
      'sidebar.open()',
      'drawer.open(true)',
      'panel.moveTo(1,2)',
      'indexedDB.open("db")',
      'ctx.moveTo(0,0)',
      'foo.print()',
    ]) {
      const out = sanitizeSandboxedHtml(`<button onclick='${call}'>Go</button>`);
      expect(out.removed).toEqual([]);
      expect(out.html).toContain('<button');
    }
  });

  it('neutralizes a blocked handler on a CONTAINER but keeps its wrapped content', () => {
    // A whole-card clickable wrapper must not take its heading/chart/table down with it.
    const html =
      '<section onclick="window.print()"><h1>Q3</h1><canvas id="c"></canvas>' +
      '<table><tr><td>x</td></tr></table></section>';
    const out = sanitizeSandboxedHtml(html);
    expect(out.removed).toHaveLength(1);
    expect(out.html).toContain('<h1>Q3</h1>');
    expect(out.html).toContain('<canvas');
    expect(out.html).toContain('<td>x</td>');
    expect(out.html).not.toContain('onclick');
  });

  it('neutralizes cursor: help affordance on inert elements lacking title', () => {
    const html =
      '<span style="cursor: help;">cite</span>' +
      '<span style="cursor: help;" title="Full Source">cite2</span>' +
      '<div>normal text</div>';
    const out = sanitizeSandboxedHtml(html);
    expect(out.removed).toHaveLength(1); // Only the first span, not the one with title
    expect(out.removed[0]).toContain('interactive-style cursor affordance');
    // First span should have no style attribute (it was the only style and got removed)
    expect(out.html).toContain('<span>cite</span>');
    // Second span should keep its cursor style (it has title)
    expect(out.html).toContain('style="cursor: help;"');
    expect(out.html).toContain('title="Full Source"');
    expect(out.html).toContain('<span');
    expect(out.html).toContain('cite');
  });

  it('preserves cursor: help on elements WITH title attribute (legitimate tooltip)', () => {
    const html = '<span style="cursor: help;" title="More info">badge</span>';
    const out = sanitizeSandboxedHtml(html);
    expect(out.removed).toEqual([]);
    expect(out.html).toContain('cursor: help');
    expect(out.html).toContain('title="More info"');
  });

  it('preserves cursor: pointer on elements WITH href (legitimate link affordance)', () => {
    const html = '<a href="/page" style="cursor: pointer;">link</a>';
    const out = sanitizeSandboxedHtml(html);
    expect(out.removed).toEqual([]);
    expect(out.html).toContain('cursor: pointer');
    expect(out.html).toContain('href="/page"');
  });

  it('preserves cursor: pointer on elements WITH event handlers', () => {
    const html =
      '<div style="cursor: pointer;" onclick="this.classList.toggle(\'x\')">clicker</div>';
    const out = sanitizeSandboxedHtml(html);
    expect(out.removed).toEqual([]);
    expect(out.html).toContain('cursor: pointer');
    expect(out.html).toContain('onclick');
  });

  it('neutralizes cursor: pointer on inert elements lacking any interactivity', () => {
    const html = '<div style="cursor: pointer;">not clickable</div>';
    const out = sanitizeSandboxedHtml(html);
    expect(out.removed).toHaveLength(1);
    expect(out.removed[0]).toContain('interactive-style cursor affordance');
    expect(out.html).not.toContain('cursor: pointer');
    expect(out.html).toContain('not clickable');
  });

  it('neutralizes class-based cursor: help rules on inert elements', () => {
    const html =
      '<style>.source-tag { cursor: help; color: blue; }</style>' +
      '<span class="source-tag">cite</span>';
    const out = sanitizeSandboxedHtml(html);
    expect(out.removed).toHaveLength(1);
    expect(out.removed[0]).toContain('interactive-style cursor affordance');
    // The CSS rule should remain (we override with inline style)
    expect(out.html).toContain('<style>');
    expect(out.html).toContain('cursor: help');
    // The element should have cursor: default inline override
    expect(out.html).toContain('cursor: default');
    // The element and its text should survive
    expect(out.html).toContain('<span class="source-tag"');
    expect(out.html).toContain('cite');
  });

  it('preserves class-based cursor rules on elements WITH title', () => {
    const html =
      '<style>.source-tag { cursor: help; }</style>' +
      '<span class="source-tag" title="Full Citation">cite</span>';
    const out = sanitizeSandboxedHtml(html);
    expect(out.removed).toEqual([]);
    expect(out.html).toContain('title="Full Citation"');
    // No override should be added (element is interactive via title)
    expect(out.html).not.toContain('cursor: default');
  });

  it('handles multiple cursor affordances in a single page', () => {
    const html =
      '<style>.help-badge { cursor: help; }</style>' +
      '<span style="cursor: help;">inline 1</span>' +
      '<span class="help-badge">class 1</span>' +
      '<span style="cursor: help;" title="has title">inline 2</span>' +
      '<span class="help-badge" onclick="void">class 2</span>';
    const out = sanitizeSandboxedHtml(html);
    // Should remove affordances from: inline 1, class 1 (2 removals)
    // Should NOT remove from: inline 2 (has title), class 2 (has handler)
    expect(out.removed.length).toBe(2);
    expect(out.removed[0]).toContain('interactive-style cursor affordance');
    expect(out.removed[1]).toContain('interactive-style cursor affordance');
  });

  it('leaves a clean artifact with cursor affordances and proper title attributes unchanged', () => {
    const clean =
      '<style>.badge { cursor: help; }</style>' +
      '<span class="badge" title="Full source name">cite</span>' +
      '<span style="cursor: help;" title="Info">info</span>';
    const out = sanitizeSandboxedHtml(clean);
    expect(out.removed).toEqual([]);
    expect(out.html).toBe(clean);
  });

  it('removes cursor style while preserving other inline styles', () => {
    const html = '<span style="color: red; cursor: help; font-weight: bold;">text</span>';
    const out = sanitizeSandboxedHtml(html);
    expect(out.removed).toHaveLength(1);
    // color and font-weight should remain
    expect(out.html).toContain('color: red');
    expect(out.html).toContain('font-weight: bold');
    // cursor: help should be gone
    expect(out.html).not.toContain('cursor: help');
  });
});
