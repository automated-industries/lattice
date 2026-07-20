// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { bootInterstitialJs } from '../../src/gui/app/modules/boot-interstitial.js';

/**
 * activeElement() is the client's "what am I looking at" signal — it is POSTed as
 * `activeContext` with every chat message so the assistant knows the surface the user
 * currently has open (so "why is this dashboard blank?" resolves to THIS dashboard,
 * and the self-diagnosis `investigate` tool has a default target).
 *
 * Regression: activeElement()'s only dashboard branch matched the RETIRED
 * `#/analytics/<id>` hash. In the 5.0 single layout the canonical open-dashboard route
 * is `#/w/dash/<id>` (renderRoute), and normalizeLegacyHash rewrites `#/analytics/<id>`
 * → `#/w/dash/<id>` on entry — so no one ever sits on the hash activeElement() matched.
 * Result: on a real open dashboard it returned null, the chat POSTed `activeContext:null`,
 * and the assistant asked the user to open a dashboard that was already open. These tests
 * pin that activeElement() recognizes the canonical `#/w/<kind>/<id>` routes.
 */

type ActiveEl = () => { table: string; id: string } | null;

function loadActiveElement(): ActiveEl {
  const w = globalThis as unknown as Record<string, unknown>;
  // The `#/w/<kind>/…` and legacy `#/analytics/…` branches return before touching
  // fsParse; stub it anyway so the fallback path is defined like at runtime.
  w.fsParse = () => null;
  // Indirect eval defines activeElement() (+ its neighbors) on the jsdom global scope.
  (0, eval)(bootInterstitialJs as string);
  return w.activeElement as ActiveEl;
}

describe('activeElement() — currently-open surface for chat context (jsdom)', () => {
  let activeElement: ActiveEl;
  beforeEach(() => {
    activeElement = loadActiveElement();
  });

  it('recognizes the canonical open-dashboard route #/w/dash/<id> (the regressed case)', () => {
    window.location.hash = '#/w/dash/prop-coverage';
    expect(activeElement()).toEqual({ table: 'dashboards', id: 'prop-coverage' });
  });

  it('decodes a percent-encoded dashboard id', () => {
    window.location.hash = '#/w/dash/Prop%20Coverage';
    expect(activeElement()).toEqual({ table: 'dashboards', id: 'Prop Coverage' });
  });

  it('recognizes an open file route #/w/file/<id>', () => {
    window.location.hash = '#/w/file/abc123';
    expect(activeElement()).toEqual({ table: 'files', id: 'abc123' });
  });

  it('recognizes an open table record #/w/table/<name>/<rowId> as the table,id pair', () => {
    window.location.hash = '#/w/table/authors/a1';
    expect(activeElement()).toEqual({ table: 'authors', id: 'a1' });
  });

  it('takes the DEEPEST table,id pair when drilled into a relation', () => {
    window.location.hash = '#/w/table/authors/a1/books/b2';
    expect(activeElement()).toEqual({ table: 'books', id: 'b2' });
  });

  it('returns null for a bare table collection (a list — nothing is selected)', () => {
    window.location.hash = '#/w/table/authors';
    expect(activeElement()).toBeNull();
  });

  it('still resolves the legacy #/analytics/<id> route (back-compat)', () => {
    window.location.hash = '#/analytics/legacy-dash';
    expect(activeElement()).toEqual({ table: 'dashboards', id: 'legacy-dash' });
  });
});
