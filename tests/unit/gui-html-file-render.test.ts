import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';
import { css } from '../../src/gui/app/css.js';

// The HTML-file preview is part of the inlined GUI client script (no DOM test
// harness exists for it), so assert the composed `appJs`/`css` carry the feature
// AND its isolation guarantees.
describe('inline HTML-file rendering (client script)', () => {
  it('renders an html artifact in a fully isolated (null-origin) sandboxed frame', () => {
    expect(appJs).toContain('html-file-frame');
    expect(appJs).toContain('htmlFileSrcdoc');
    // sandbox grants scripts only — the attribute is closed right after allow-scripts,
    // so the dangerous allow-scripts+allow-same-origin combo (which would re-couple the
    // untrusted page to the host origin) is never emitted.
    expect(appJs).toContain('sandbox="allow-scripts"');
    expect(appJs).not.toContain('allow-scripts allow-same-origin');
  });

  it('gives the frame zero network egress (connect-src none) — no direct fetch/exfil', () => {
    expect(appJs).toContain('Content-Security-Policy');
    expect(appJs).toContain("connect-src 'none'");
    // No same-origin/remote network grants leaked into the frame CSP.
    expect(appJs).not.toContain("connect-src 'self'");
    // Nested browsing contexts / plugins / workers are also denied.
    expect(appJs).toContain("child-src 'none'");
    expect(appJs).toContain("object-src 'none'");
  });

  it('makes the CSP unconditionally first — the authored doc is confined to <body>', () => {
    // The frame document is OUR head (CSP first) wrapping the authored content, so
    // no untrusted markup can precede the policy (the meta-CSP ordering bypass).
    expect(appJs).toContain('<!doctype html><html><head>');
    expect(appJs).toContain('</head><body>');
  });

  it('mediates all data access through a read-only parent postMessage broker', () => {
    expect(appJs).toContain('installHtmlFileBroker');
    expect(appJs).toContain('window.lattice');
    // The broker only honours messages whose source IS a live page frame's
    // window (any iframe.html-frame — file preview or dashboard canvas).
    expect(appJs).toContain("querySelectorAll('iframe.html-frame')");
    expect(appJs).toContain('e.source === frames[fi].contentWindow');
    // The injected bridge exposes the read-only SQL surface, and the broker
    // routes it to the server-enforced endpoint (never a raw DB path).
    expect(appJs).toContain('sql:function(q){return __lreq("sql",{sql:q});}');
    expect(appJs).toContain("'/api/analytics/sql'");
    // Read-only: it refuses credential/system tables and exposes no write path.
    expect(appJs).toContain('forbidden table');
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
