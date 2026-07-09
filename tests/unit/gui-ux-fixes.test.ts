import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';
import { guiAppHtml } from '../../src/gui/app.js';
import { css } from '../../src/gui/app/css.js';

/**
 * GUI UX fixes: workspace-switch view preservation, the combined "＋ File(s)"
 * add-source button, and the truncated topbar status.
 */

describe('workspace switch preserves the Configure surface, else resets to home', () => {
  it('gates the switch target on configureRouteFor — preserves a Configure hash, resets the rest to home', () => {
    // Single layout: a switch keeps the user on the Configure drawer they're in
    // (Settings, or the Data Model Graph/Tables) so renderRoute re-renders it for
    // the NEW workspace in place — leaving the hash put would strand the drawer on
    // the previous workspace's data. Every other hash (a Workspace tab or a record
    // drill-in that may not exist in the new workspace) resets to the Workspace
    // home ('#/'). Gated on configureRouteFor, NOT the constant-true isAnalyticsHash
    // shim, and the deleted Objects view ('#/folders') is no longer a fallback.
    expect(appJs).toContain("cur.indexOf('#/settings/') === 0");
    expect(appJs).toContain('configureRouteFor(cur)');
    // The old isAnalyticsHash-gated ternary (which always resolved to '#/analytics')
    // and the '#/folders' fallback are gone.
    expect(appJs).not.toContain('switchTarget = (typeof isAnalyticsHash');
  });
});

// The single-layout reframe moves the Inputs (Files/Connectors/Databases) out of a
// static sidebar into the Configure drawer's Inputs tab, which is authored in JS
// (configure-drawer.ts) rather than the static guiAppHtml. This assertion is
// re-established against the drawer once that tab lands.
describe.skip('add-source: one combined "＋ File(s)" button (moved to the Configure drawer)', () => {
  it('replaces the separate +Folder/+File buttons with one button + a file/folder menu', () => {
    expect(guiAppHtml).toContain('id="src-add-files"');
    expect(guiAppHtml).toContain('＋ File(s)');
  });
});

describe('Claude disconnect is discoverable in Settings (works on desktop)', () => {
  it('offers a Disconnect button in the User assistant panel, not only the topbar', () => {
    expect(appJs).toContain('id="asst-disconnect"');
    expect(appJs).toContain('Disconnect Claude');
    // Disconnect is provider-aware: a Claude subscription hits the OAuth endpoint, a
    // connected OpenAI-compatible backend hits the provider endpoint.
    expect(appJs).toContain("'/api/assistant/oauth'");
    expect(appJs).toContain("'/api/assistant/provider/openai-compat'");
  });
});

describe('topbar status truncates instead of pushing the toggle to a second line', () => {
  it('caps the status width and ellipsizes the text', () => {
    expect(css).toContain('.app-status .app-status-text');
    expect(css).toContain('text-overflow: ellipsis');
    expect(css).toContain('max-width: min(34vw, 340px)');
  });
});
