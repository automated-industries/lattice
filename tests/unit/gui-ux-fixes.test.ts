import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';
import { guiAppHtml } from '../../src/gui/app.js';
import { css } from '../../src/gui/app/css.js';

/**
 * GUI UX fixes: workspace-switch view preservation, the combined "＋ File(s)"
 * add-source button, and the truncated topbar status.
 */

describe('workspace switch preserves the current section', () => {
  it('maps the current hash to its own section home — never Analytics from Configure', () => {
    // Graph stays Graph, Tables stays Tables; Configure resolves to the concrete
    // Objects view (#/folders), not the ambiguous '#/'.
    expect(appJs).toContain("cur.indexOf('#/graph') === 0");
    expect(appJs).toContain("cur.indexOf('#/tables') === 0");
    expect(appJs).toContain("'#/folders'");
  });
});

describe('add-source: one combined "＋ File(s)" button', () => {
  it('replaces the separate +Folder/+File buttons with one button + a file/folder menu', () => {
    expect(guiAppHtml).toContain('id="src-add-files"');
    expect(guiAppHtml).toContain('＋ File(s)');
    expect(guiAppHtml).toContain('data-pick="file"');
    expect(guiAppHtml).toContain('data-pick="folder"');
    // The two old buttons are gone.
    expect(guiAppHtml).not.toContain('id="src-add-folder"');
    expect(guiAppHtml).not.toContain('id="src-add-file"');
  });
});

describe('Claude disconnect is discoverable in Settings (works on desktop)', () => {
  it('offers a Disconnect Claude button in the User assistant panel, not only the topbar', () => {
    expect(appJs).toContain('id="asst-disconnect"');
    expect(appJs).toContain('Disconnect Claude');
    expect(appJs).toContain("fetchJson('/api/assistant/oauth', { method: 'DELETE' })");
  });
});

describe('topbar status truncates instead of pushing the toggle to a second line', () => {
  it('caps the status width and ellipsizes the text', () => {
    expect(css).toContain('.app-status .app-status-text');
    expect(css).toContain('text-overflow: ellipsis');
    expect(css).toContain('max-width: min(34vw, 340px)');
  });
});
