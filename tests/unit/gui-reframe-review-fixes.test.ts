import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';

/**
 * Regression guards for the seven defects an adversarial review found in the
 * single-layout GUI reframe. Each `expect` re-introducing one of these bugs would
 * flip a check here. The GUI client is one composed IIFE string (appJs), so these
 * assert against its text — the same pattern the byte-pin + gui-html suites use.
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

describe('reframe review fix #6 — dashboard add-source opens the Inputs tab', () => {
  it('opens the Inputs drawer tab (where the src-add-* buttons live), not Data Model', () => {
    expect(appJs).toContain("openConfigureDrawer('inputs')");
  });
});

describe('reframe review fix #7 — markdown render-progress targets the sidebar tree', () => {
  it('scopes render-progress + the tree refresh to #nav-md-tree (the removed #out-markdown-tree is gone)', () => {
    expect(appJs).toContain('#nav-md-tree .mdt-node[data-table]');
    // The sidebar markdown tree is the live host id.
    expect(appJs).toContain("getElementById('nav-md-tree')");
  });
});
