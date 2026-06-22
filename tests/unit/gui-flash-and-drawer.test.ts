import { describe, it, expect } from 'vitest';
import { guiAppHtml } from '../../src/gui/app.js';

/**
 * 3.3.5 wiring guards, asserted against the served SPA.
 *
 * Flashing middle div: a background refresh must re-render in place (no
 * loading-frame wipe), and the background render must NOT reconcile the whole
 * view on every table-done.
 *
 * Settings drawer: closing it must clear a `#/settings/*` URL so a later
 * re-render can't reopen the panel.
 */
describe('3.3.5 GUI — no-flash refresh + settings-drawer URL sync', () => {
  it('renderRoute supports a soft (no loading-frame) refresh and afterMutation uses it', () => {
    expect(guiAppHtml).toContain('function renderRoute(opts)');
    // The loading-frame wipe is gated on NOT soft.
    expect(guiAppHtml).toContain('if (content && !soft) content.innerHTML = routeLoadingHtml()');
    // Background refresh re-renders in place.
    expect(guiAppHtml).toContain('renderRoute({ soft: true })');
  });

  it('a finished table clears its overlay in place (the per-table-done reconcile is gone)', () => {
    // The marker comment proves the table-done branch was changed to NOT refetch +
    // re-render the whole pane on every table (the flashing cause).
    expect(guiAppHtml).toContain('the flashing-div symptom');
    expect(guiAppHtml).toContain('clearCardProgress(e.table)');
  });

  it('closing the settings drawer resets a #/settings hash so it cannot self-reopen', () => {
    expect(guiAppHtml).toContain("location.hash.indexOf('#/settings/') === 0");
    expect(guiAppHtml).toContain("window.history.replaceState(null, '', '#/')");
  });

  it('background in-place re-renders pass {soft:true} — no bare else-branch renderRoute (the regressed FOUC sites)', () => {
    // The advanced-mode toggle (same remapped hash) and the workspace-switch reload
    // (already on #/) re-render the pane IN PLACE; both previously called a BARE
    // `renderRoute()`, which synchronously painted the loading frame (the wipe gated
    // on `!soft` above) and flashed during background/chat activity. Both now pass
    // {soft:true}. The bare `else renderRoute();` pattern was unique to those two
    // sites — guard that it cannot reappear. (The PRIMARY flash cause — spurious
    // renders triggered by chat writes — is covered behaviorally by
    // tests/unit/eager-rerender-filter.test.ts.)
    expect(guiAppHtml).not.toContain('else renderRoute();');
    expect(guiAppHtml).toContain('else renderRoute({ soft: true })');
  });
});
