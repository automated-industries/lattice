import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';
import { css } from '../../src/gui/app/css.js';

// The HTML-file preview is part of the inlined GUI client script (no DOM test
// harness exists for it), so assert the composed `appJs`/`css` carry the feature.
describe('inline HTML-file rendering (client script)', () => {
  it('renders an html artifact in a sandboxed srcdoc frame', () => {
    expect(appJs).toContain('html-file-frame');
    expect(appJs).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(appJs).toContain('htmlFileSrcdoc');
  });

  it('injects a CSP that allows same-origin data fetch but blocks exfiltration', () => {
    expect(appJs).toContain('Content-Security-Policy');
    expect(appJs).toContain("connect-src 'self'");
  });

  it('bundles the chart library and decodes it into the frame', () => {
    expect(appJs).toContain('__LATTICE_CHART_LIB__');
    expect(appJs).toContain('atob(');
  });

  it('never emits a literal closing script tag (would terminate the inline GUI script)', () => {
    // Built from split tokens so the test source itself stays clean too.
    expect(appJs.includes('</' + 'script>')).toBe(false);
  });

  it('styles a taller frame for a live HTML file', () => {
    expect(css).toContain('.html-frame');
  });
});
