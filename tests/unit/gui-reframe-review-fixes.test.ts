import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';
import { css } from '../../src/gui/app/css.js';

/**
 * Regression guards for the defects two adversarial passes found in the single-layout
 * GUI reframe: the first pass found seven, and re-verifying the fixes found two more the
 * fixes themselves introduced. Each `expect` re-introducing one of these bugs would flip
 * a check here. The GUI client is one composed IIFE string (appJs) + one composed
 * stylesheet (css), so these assert against their text — the byte-pin + gui-html pattern.
 */

describe('reframe review fix #1 — computed-table builder is reachable', () => {
  it('routes #/computed/* to renderComputedBuilder in renderRoute (not swallowed into the drawer)', () => {
    // The builder renders as a full center page from the #/computed/(name) hash.
    expect(appJs).toContain('renderComputedBuilder(content, decodeURIComponent(cbm[1]))');
    // configureRouteFor must NOT intercept #/computed/* back into the tables list.
    expect(appJs).not.toContain('/^#\\/computed\\//.test(hash)');
  });
  it('closes the Configure drawer the builder was launched from so it is not hidden behind it', () => {
    // The '+ New computed table' / 'Edit definition' affordances live inside the
    // drawer; entering the builder must drop that overlay.
    expect(appJs).toContain('drawerIsOpen() && typeof closeSettingsDrawer');
  });
  it('does NOT rebuild the builder on a soft/background render (would wipe the in-progress form)', () => {
    // Re-verify follow-up: a landed mutation fires renderRoute({soft:true}); the
    // #/computed branch must bail before renderComputedBuilder resets the form. The
    // cbm branch opens with an early `if (soft) return;` guard.
    const cbmIdx = appJs.indexOf('/^#\\/computed\\/([^/]+)$/.exec(hash)');
    expect(cbmIdx).toBeGreaterThan(-1);
    const branch = appJs.slice(cbmIdx, cbmIdx + 1000);
    expect(branch).toContain('if (soft) return;');
    // ...and the soft guard precedes the renderComputedBuilder call within the branch.
    const softIdx = branch.indexOf('if (soft) return;');
    const renderIdx = branch.indexOf('renderComputedBuilder(content');
    expect(softIdx).toBeGreaterThan(-1);
    expect(renderIdx).toBeGreaterThan(-1);
    expect(softIdx).toBeLessThan(renderIdx);
  });
  it('commits the edit-mode load on the route still matching, not a renderGen match (soft render cannot orphan it)', () => {
    // Third-order follow-up to the soft-guard: keying the async paint on renderGen let
    // a soft render's gen bump orphan an in-flight edit load into a stuck spinner. The
    // load now commits via cbRouteMatches(nameArg) instead.
    expect(appJs).toContain('function cbRouteMatches(nameArg)');
    // The edit-mode commit is gated on BOTH a current per-load token AND the route
    // still matching — the token re-suppresses stale same-route re-entrant paints
    // that keying on the hash alone would miss.
    expect(appJs).toContain('var loadTok = ++cbLoadSeq;');
    expect(appJs).toContain('loadTok !== cbLoadSeq || !cbRouteMatches(nameArg)');
  });
});

describe('reframe review re-verify fix — Graph drawer subtab has a real height', () => {
  it('pins .brain-graph to a definite height inside the Data Model grid so the canvas is not 0px', () => {
    // Re-verify follow-up: .dm-tables-merge is an auto-height grid, so .brain-graph's
    // height:100% would collapse the force-graph canvas to 0. A scoped rule restores it.
    expect(css).toContain('.dm-tables-merge .brain-graph');
    expect(css).toMatch(/\.dm-tables-merge \.brain-graph\s*\{\s*height:\s*64vh/);
  });
});

describe('reframe review fix #1b/#2 — graph node drill-in never dead-ends', () => {
  it('normalizes a stray #/graph/<entity> hash to that entity table tab', () => {
    expect(appJs).toContain('/^#\\/graph\\/(.+)$/.exec(hash)');
  });
  it('a graph-node click opens the in-drawer entity editor, not the removed #/graph route', () => {
    expect(appJs).toContain('dmShowEntityEditor(node.id)');
    // The old dead-end navigation is gone.
    expect(appJs).not.toContain("location.hash = '#/graph/' + encodeURIComponent(node.id)");
  });
  it('the Graph drawer subtab renders a #dm-panel so the editor has a target', () => {
    // Graph subtab now uses the same two-column merge layout as the Tables subtab.
    expect(appJs).toContain('brain-graph');
    expect(appJs).toContain('id="dm-panel"');
  });
});

describe('reframe review fix #3 — deleting a file returns to the files list', () => {
  it('routes a w:file collection fallback to the files-table collection, not the invalid #/w/file/files', () => {
    // Both call sites (renderFsItem deleted-row fallback + removeRow post-delete nav)
    // special-case w:file, whose only #/w/file/ form is a record id.
    expect(appJs).toContain("section === 'w:file' ? '#/w/table/' + encodeURIComponent(table)");
    expect(appJs).toContain("delSec === 'w:file' ? '#/w/table/' + encodeURIComponent(table)");
  });
});

describe('reframe review fix #4 — a dismissed Configure drawer does not re-pop', () => {
  it('closeSettingsDrawer clears any configureRouteFor hash, not only #/settings/*', () => {
    expect(appJs).toContain('configureRouteFor(location.hash)');
  });
});

describe('reframe review fix #6 — dashboard add-source opens the right Configure tab', () => {
  it('opens the matching Files/Connectors/Databases tab (where the src-add-* buttons live), not Data Model', () => {
    // The single Inputs tab was split into three; each add-source action opens ITS tab.
    expect(appJs).toContain('openConfigureDrawer(addTab[name])');
    expect(appJs).toContain("'add-file': 'files'");
    expect(appJs).toContain("'add-connector': 'connectors'");
    expect(appJs).toContain("'add-database': 'databases'");
  });
});

// (reframe review fix #7 — markdown render-progress on #nav-md-tree — retired: the
// Markdown sidebar section + its render-progress overlay were removed entirely.)
