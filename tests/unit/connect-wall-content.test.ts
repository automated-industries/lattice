import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';

/**
 * First-run connect wall copy + chrome. Pinned on the composed client bundle
 * (the connect wall lives in a template-literal module). Guards the launch-screen
 * design: the Lattice logo (not an emoji), the black Claude-logo CTA, and the
 * trimmed copy.
 */
describe('first-run connect wall', () => {
  it('shows the Lattice logo mark, not the grandma emoji', () => {
    expect(appJs).toContain('+ BRAND_SVG +');
    expect(appJs).toContain('class="connect-wall-mark"');
    expect(appJs).not.toContain('👵');
  });

  it('uses the black Claude-logo button for the connect CTA', () => {
    expect(appJs).toContain('class="connect-claude-btn"');
    // The Claude sunburst mark is generated + injected into the button.
    expect(appJs).toContain('var CLAUDE_LOGO_SVG = (function ()');
    expect(appJs).toContain("CLAUDE_LOGO_SVG + '<span>Connect with Claude</span></a>'");
  });

  it('has the trimmed, plan-aware copy', () => {
    expect(appJs).toContain('Connect your Claude account plan (Max, Pro, etc) to continue');
    expect(appJs).not.toContain('there is nothing to skip');
  });

  it('labels the code field by placeholder only (no separate label), and the CTA reads Connect', () => {
    expect(appJs).toContain('placeholder="Paste Authentication Code here"');
    expect(appJs).not.toContain('placeholder="code#state"');
    expect(appJs).not.toContain('Paste the code Claude gives you');
    expect(appJs).toContain('id="connect-wall-finish">Connect</button>');
  });
});
