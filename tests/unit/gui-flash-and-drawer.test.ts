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

  it('a finished render does ONE reconcile on the terminal done (no per-table refetch storm)', () => {
    // Per-table events only fold the renderProgress map (no refetch); the terminal
    // 'done' does the single reconciling refetch (afterMutation). That is the
    // anti-flashing invariant — one refresh per render, never one per table.
    expect(guiAppHtml).toContain('ONE reconciling refetch');
    expect(guiAppHtml).toContain('afterMutation().catch(function () {');
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

describe('5.0.1 GUI — workspace-switch flow + middle-pane flash', () => {
  it('Bug A: afterMutation skips the view re-render when only chat tables changed', () => {
    // scheduleRealtimeRefresh accumulates ANY changed table (incl. chat_messages/
    // chat_threads from streaming) and calls afterMutation, which would re-render the
    // pane on every turn. afterMutation now returns early when the change is chat-only.
    expect(guiAppHtml).toContain("t === 'chat_threads' || t === 'chat_messages'");
    expect(guiAppHtml).toContain('function afterMutation(changedTables)');
  });

  it('Bug B: the switch overlay is raised immediately on click (both switch entry points)', () => {
    // The dropdown handler and the Configure Workspaces-row handler both call
    // showSwitchOverlay() before the /api/workspaces/switch POST — one motion, no
    // dropdown-then-fullscreen two-step.
    expect(guiAppHtml).toContain('function showSwitchOverlay()');
    // reloadEverything still shows it (idempotent); the pre-POST call is the new bit.
    const overlayCalls = (guiAppHtml.match(/showSwitchOverlay\(\)/g) || []).length;
    expect(overlayCalls).toBeGreaterThan(1);
  });

  it('Bug C: reloadEverything refreshes an open Configure drawer for the new workspace', () => {
    // A gear-opened drawer has no #/settings hash, so the hash-based re-render skips
    // it; reloadEverything now refreshes the open tab directly via selectDrawerTab.
    expect(guiAppHtml).toContain('drawerIsOpen()');
    expect(guiAppHtml).toContain('selectDrawerTab(drawerTab)');
  });

  it('Bug D: a failed switch reverts to the previous workspace instead of stranding it', () => {
    // On a switch/reload error, re-switch to the workspace we came from + reload.
    expect(guiAppHtml).toContain('if (currentId && currentId !== id)');
  });
});

describe('5.2 GUI — the brand logo is always home', () => {
  it('clicking the logo closes an open Configure/History takeover and lands on home', () => {
    // The drawer is a full-workspace takeover and the hash beneath it is usually
    // already '#/' (closeSettingsDrawer parks it there), so the bare <a href="#/">
    // fired no hashchange and clicking the logo with Configure open did nothing.
    // The brand now has a real click handler: close the takeover, then go home.
    expect(guiAppHtml).toContain("document.querySelector('header.topbar a.brand')");
    expect(guiAppHtml).toContain('if (drawerIsOpen()) closeSettingsDrawer();');
    // Same-hash clicks must still work (no hashchange can fire), so the hash is
    // only assigned when actually elsewhere.
    expect(guiAppHtml).toContain("if ((location.hash || '#/') !== '#/') location.hash = '#/';");
    // Open-in-new-tab semantics stay intact (modified clicks fall through to the href).
    expect(guiAppHtml).toContain(
      'e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0',
    );
  });
});
