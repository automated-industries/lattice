import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';

/**
 * First-run connect wall — now a WIZARD: choose a backend (Claude account or any
 * OpenAI-compatible endpoint) → enter its details (Connect stays faded until the required
 * fields are filled) → a "Testing your AI" step runs a real model call before the app
 * proceeds to Analytics. Pinned on the composed client bundle (the wall lives in a
 * template-literal module).
 */
describe('first-run connect wall (wizard)', () => {
  it('shows the Lattice logo mark, not the grandma emoji', () => {
    expect(appJs).toContain('+ BRAND_SVG +');
    expect(appJs).toContain('class="connect-wall-mark"');
    expect(appJs).not.toContain('👵');
  });

  it('step 1 offers the two backend choices with the welcome + security copy', () => {
    expect(appJs).toContain('Welcome to Lattice');
    expect(appJs).toContain('Choose which model to use to power Lattice');
    expect(appJs).toContain('data-method="claude"');
    expect(appJs).toContain('data-method="other"');
    expect(appJs).toContain('Lattice does not collect or retain your data');
  });

  it('uses the black Claude-logo button for the Claude connect step', () => {
    expect(appJs).toContain('class="connect-claude-btn"');
    expect(appJs).toContain('var CLAUDE_LOGO_SVG = (function ()');
    expect(appJs).toContain("CLAUDE_LOGO_SVG + '<span>Connect with Claude</span></a>'");
  });

  it('the Other AI Endpoint step takes base URL, key, and model', () => {
    expect(appJs).toContain('id="cw-base"');
    expect(appJs).toContain('id="cw-key"');
    expect(appJs).toContain('id="cw-model"');
    expect(appJs).toContain('/api/assistant/provider/openai-compat');
  });

  it('has a faded-until-filled Connect button and a "Testing your AI" step', () => {
    expect(appJs).toContain('id="cw-connect" disabled');
    expect(appJs).toContain('Testing your AI');
    expect(appJs).toContain("fetchJson('/api/assistant/test'");
  });
});
