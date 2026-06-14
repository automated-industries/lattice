// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { analyticsJs } from '../../src/gui/app/analytics.js';
import { guiAppHtml } from '../../src/gui/app.js';

/**
 * #4 — Google Analytics 4, opt-in, gated on consent. The IIFE is executed in a
 * jsdom window so we can assert the real runtime behavior: no network contact
 * while opted out, lazy single gtag.js load on consent, the GA kill switch, and
 * the anonymization contract (sanitize + synthetic pageView).
 */
const MEASUREMENT_ID = 'G-3M1RPJ4ZB3';
const DISABLE_FLAG = 'ga-disable-' + MEASUREMENT_ID;

interface GA {
  MEASUREMENT_ID: string;
  init: (enabled: boolean) => void;
  setConsent: (enabled: boolean) => void;
  track: (name: string, params?: Record<string, unknown>) => void;
  pageView: (routeType: string) => void;
}

function bootAnalytics(): GA {
  const w = window as unknown as Record<string, unknown>;
  document.head.querySelectorAll('script').forEach((s) => s.remove());
  w.dataLayer = undefined;
  w.LatticeGA = undefined;
  delete w[DISABLE_FLAG];
  // The shipped module is an IIFE that attaches window.LatticeGA. Execute it in
  // this jsdom global (it needs a real document/window/navigator).
  // eslint-disable-next-line no-eval
  (0, eval)(analyticsJs);
  return w.LatticeGA as GA;
}

function gtagScriptCount(): number {
  return document.querySelectorAll('script[src*="googletagmanager.com/gtag/js"]').length;
}
function dataLayer(): unknown[][] {
  return ((window as unknown as Record<string, unknown>).dataLayer as unknown[][]) ?? [];
}
function events(): unknown[][] {
  return dataLayer().filter((a) => a[0] === 'event');
}

describe('#4 Google Analytics — static contract', () => {
  it('analyticsJs carries the measurement id + privacy flags', () => {
    expect(analyticsJs).toContain(MEASUREMENT_ID);
    expect(analyticsJs).toContain('send_page_view: false');
    expect(analyticsJs).toContain('allow_google_signals: false');
    expect(analyticsJs).toContain('allow_ad_personalization_signals: false');
    expect(analyticsJs).toContain('anonymize_ip: true');
  });

  it('guiAppHtml does not unconditionally load gtag.js in <head>', () => {
    // The inlined IIFE references the URL (loaded lazily on consent), but there
    // must be NO static <script src="...googletagmanager..."> tag.
    expect(guiAppHtml).not.toMatch(/<script[^>]+src=["']https:\/\/www\.googletagmanager/i);
  });
});

describe('#4 Google Analytics — runtime consent + anonymization', () => {
  it('init(false) loads no gtag.js; init(true) loads exactly one (idempotent)', () => {
    let ga = bootAnalytics();
    ga.init(false);
    expect(gtagScriptCount()).toBe(0); // opted out → zero network contact

    ga = bootAnalytics();
    ga.init(true);
    expect(gtagScriptCount()).toBe(1);
    ga.setConsent(true); // re-consent must not double-inject
    expect(gtagScriptCount()).toBe(1);
  });

  it('setConsent(false) sets the GA kill switch and track() no-ops', () => {
    const ga = bootAnalytics();
    ga.init(true);
    ga.setConsent(false);
    expect((window as unknown as Record<string, unknown>)[DISABLE_FLAG]).toBe(true);
    const before = events().length;
    ga.track('row_create', {});
    expect(events().length).toBe(before); // nothing emitted while opted out
  });

  it('track() drops non-enum string params (never table names / PII)', () => {
    const ga = bootAnalytics();
    ga.init(true);
    ga.track('row_create', { table: 'Secret Client Names!!', count: 3, ok: true });
    const evt = events().find((a) => a[1] === 'row_create');
    expect(evt).toBeDefined();
    const params = evt![2] as Record<string, unknown>;
    expect(params.table).toBeUndefined(); // free-form string dropped
    expect(params.count).toBe(3); // numbers kept
    expect(params.ok).toBe(true); // booleans kept
  });

  it('pageView emits a synthetic route — never the raw hash', () => {
    const ga = bootAnalytics();
    ga.init(true);
    ga.pageView('fs');
    const evt = events().find((a) => a[1] === 'page_view');
    expect(evt).toBeDefined();
    const params = evt![2] as Record<string, string>;
    expect(params.page_location).toBe('https://app.lattice.local/fs');
    expect(params.page_location).not.toContain('#');
  });
});
