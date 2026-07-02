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
// A TEST-ONLY id injected via window.__LATTICE_GA_ID — the module no longer
// hardcodes the production website property (that pollution was the bug).
const MEASUREMENT_ID = 'G-TEST1234567';
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
  document.head.querySelectorAll('script').forEach((s) => {
    s.remove();
  });
  w.dataLayer = undefined;
  w.LatticeGA = undefined;
  w[DISABLE_FLAG] = undefined; // falsy reset (no-dynamic-delete); GA treats it as "not disabled"
  // Inject the GA property id the way the server would (empty by default ⇒ no GA);
  // the module reads window.__LATTICE_GA_ID rather than a hardcoded property.
  w.__LATTICE_GA_ID = MEASUREMENT_ID;
  // The shipped module is an IIFE that attaches window.LatticeGA. Execute it in
  // this jsdom global (it needs a real document/window/navigator).

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
  it('analyticsJs reads an injectable id (no hardcoded property) + privacy flags', () => {
    // The id comes from window.__LATTICE_GA_ID (empty by default); the website's
    // production property must never be hardcoded into the local app again.
    expect(analyticsJs).toContain('window.__LATTICE_GA_ID');
    expect(analyticsJs).not.toContain('G-3M1RPJ4ZB3');
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

  it('loads NOTHING when no GA property id is configured — even with consent', () => {
    // Regression: a local install ships with no __LATTICE_GA_ID, so it must never
    // contact GA (the duplicate-users bug was the local app reporting into the
    // website property by default).
    const w = window as unknown as Record<string, unknown>;
    document.head.querySelectorAll('script').forEach((s) => {
      s.remove();
    });
    w.dataLayer = undefined;
    w.LatticeGA = undefined;
    w.__LATTICE_GA_ID = ''; // no property configured (the default)
    (0, eval)(analyticsJs);
    const ga = w.LatticeGA as GA;
    ga.init(true); // consent ON
    ga.track('app_open', {});
    expect(gtagScriptCount()).toBe(0); // empty id ⇒ no gtag.js injected, no network
  });

  it('the curated event set is wired into the embedded SPA (no silent drop)', () => {
    // Guards the #4 instrumentation: every coarse, anonymized action event is
    // emitted somewhere in the bundle. (The events fire client-side; param
    // anonymization is enforced by sanitize(), tested below.)
    const expected = [
      'app_open',
      'analytics_opt_in',
      'analytics_opt_out',
      'assistant_message',
      'assistant_thread_new',
      'file_ingest',
      'history_action',
      'member_invite',
      'table_create',
      'table_delete',
      'data_model_share',
      'workspace_create',
      'workspace_switch',
      // ('search' retired with the top search box; 'setting_change' with the
      //  Advanced View toggle — both emitters removed, so neither is in the SPA.)
    ];
    for (const evt of expected) {
      expect(guiAppHtml, `event ${evt} should be instrumented`).toContain(`'${evt}'`);
    }
    // Row writes go through a single rowWrite() with a computed verb.
    expect(guiAppHtml).toContain("'row_create'");
    expect(guiAppHtml).toContain("'row_update'");
    expect(guiAppHtml).toContain("'row_delete'");
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
