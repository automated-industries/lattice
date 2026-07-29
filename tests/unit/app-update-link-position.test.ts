import { describe, expect, it } from 'vitest';

import { css } from '../../src/gui/app/css.js';
import { guiAppHtml } from '../../src/gui/app.js';

// Header auto-update pill placement. The #app-update-link anchor sits in DOM
// order immediately before the Configure button, but .configure-trigger owns
// the header's flexible gap (margin-left: auto) — so a VISIBLE update pill was
// rendered mid-header, left of the auto gap, instead of at the far right next
// to Configure. The fix is CSS-only: when the pill is visible it takes over
// the auto margin, and the Configure button's own auto margin is neutralized
// via the adjacent-sibling selector. The hidden state is unchanged.
describe('header update pill sits immediately left of Configure when visible', () => {
  it('visible pill takes over the flexible header gap', () => {
    expect(css).toContain('#app-update-link:not([hidden]) { margin-left: auto; }');
  });

  it('neutralizes the Configure auto margin only while the pill is visible', () => {
    expect(css).toContain(
      '#app-update-link:not([hidden]) + .configure-trigger { margin-left: 8px; }',
    );
  });

  it('keeps the hidden state exactly as before (display none, no layout impact)', () => {
    expect(css).toContain('#app-update-link[hidden] { display: none; }');
    // Configure keeps its own auto margin for the (default) hidden-pill case.
    expect(css).toMatch(/\.configure-trigger \{\s*\n\s*margin-left: auto;/);
  });

  it('DOM keeps the pill as the immediate element sibling before Configure', () => {
    // The adjacent-sibling neutralizer above depends on this: nothing but
    // whitespace/comments may sit between the update link and the Configure
    // button, or the + combinator stops matching and Configure would keep its
    // auto margin while the pill also has one (double gap).
    const between =
      /<a id="app-update-link"[^>]*>[^<]*<\/a>([\s\S]*?)<button class="configure-trigger"/.exec(
        guiAppHtml,
      );
    expect(between).not.toBeNull();
    const gap = between?.[1] ?? '';
    expect(gap.length).toBeGreaterThan(0);
    // Strip HTML comments; what remains must contain no element tags.
    expect(gap.replace(/<!--[\s\S]*?-->/g, '').trim()).toBe('');
  });
});
