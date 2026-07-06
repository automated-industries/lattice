// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

import { searchJs } from '../../src/gui/app/modules/search.js';

/**
 * Regression: cross-workspace markdown leak.
 *
 * The Outputs > Markdown tree (renderOutputsMarkdown, which self-fetches the
 * ACTIVE workspace's rendered context via GET /api/context/tree) is only drawn
 * by renderOutputs(). reloadEverything() runs on every workspace switch. It used
 * to refresh entities / sidebar / chat / switcher but NOT the Outputs column —
 * so after switching from workspace A to B, the Markdown tree kept showing A's
 * rendered context (another workspace's data) until a hard reload.
 *
 * This test executes the real reloadEverything() in a jsdom global with its
 * dependencies stubbed and asserts it re-renders the Outputs column, so a future
 * edit that drops the refresh from the switch path fails here.
 */
describe('workspace switch refreshes the Outputs column (no cross-workspace markdown leak)', () => {
  it('reloadEverything() calls renderOutputs() so the Markdown tree reflects the new workspace', async () => {
    const w = globalThis as unknown as Record<string, unknown>;
    // Every endpoint reloadEverything fetches resolves to an inert shape.
    w.fetchJson = () => Promise.resolve({});
    w.state = {};
    const renderOutputs = vi.fn();
    w.renderOutputs = renderOutputs;
    // Stub the other side effects reloadEverything triggers.
    for (const name of [
      'renderWsSwitcher',
      'applyWorkspaceLogo',
      'renderSidebar',
      'renderComposer',
      'clearChat',
      'refreshThreadList',
      'renderRoute',
      'startEventStream',
      // Defined in the model-tables module (same IIFE in the real bundle); stub it
      // here so this isolated searchJs eval doesn't ReferenceError on the switch-reset.
      'mtResetState',
      // Same for the analytics view's per-workspace resets (analytics-tabs /
      // analytics-view modules).
      'anResetTabs',
    ]) {
      w[name] = vi.fn();
    }
    w.currentThreadId = null;
    w.loadedTables = {};
    w.renderProgress = {};

    // Indirect eval defines reloadEverything (+ siblings) on the jsdom global.
    (0, eval)(searchJs as string);

    await (w.reloadEverything as () => Promise<void>)();

    expect(renderOutputs).toHaveBeenCalled();
    // The switch must also reset the Tables-explorer state (cached edges + any
    // in-flight Wire/Merge selection), or the new workspace shows the old one's
    // relationships. reloadEverything() is the single canonical switch path.
    expect(w.mtResetState).toHaveBeenCalled();
  });

  it('a switch while a Settings / Version-history takeover is open re-renders it for the new workspace', async () => {
    // The Settings drawer (and Version history) overlay the current view and show
    // WORKSPACE-SPECIFIC data (name, DB connection, data model, history). A switch
    // used to route these takeovers to #/folders, which left the drawer open showing
    // the PREVIOUS workspace's data (topbar said workspace B, the drawer still said A).
    // The switch must PRESERVE a #/settings/* route so renderRoute re-dispatches it and
    // openSettingsDrawer re-renders the drawer body for the new workspace.
    const w = globalThis as unknown as Record<string, unknown>;
    w.fetchJson = () => Promise.resolve({});
    w.state = {};
    const renderRoute = vi.fn();
    w.renderRoute = renderRoute;
    for (const name of [
      'renderOutputs',
      'renderWsSwitcher',
      'applyWorkspaceLogo',
      'renderSidebar',
      'renderComposer',
      'clearChat',
      'refreshThreadList',
      'startEventStream',
      'mtResetState',
      'anResetTabs',
    ]) {
      w[name] = vi.fn();
    }
    w.currentThreadId = null;
    w.loadedTables = {};
    w.renderProgress = {};
    window.location.hash = '#/settings/database';

    (0, eval)(searchJs as string);
    await (w.reloadEverything as () => Promise<void>)();

    // The takeover route is preserved (NOT reset to #/folders)…
    expect(window.location.hash).toBe('#/settings/database');
    // …so the switch re-renders it in place (soft) for the new workspace.
    expect(renderRoute).toHaveBeenCalledWith({ soft: true });
  });
});
