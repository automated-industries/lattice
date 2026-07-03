import { describe, it, expect } from 'vitest';
import { guiAppHtml } from '../../src/gui/app.js';

/**
 * Fail-before-fix guards for the 3.2 GUI changes that are presentational (text /
 * CSS / ordering / markup) and so are asserted against the shipped HTML string.
 * Each assertion checks the NEW behavior, so reverting the change makes it fail.
 */
describe('3.2 GUI regression guards', () => {
  it('#2 render indicator reads "Rendering NN%…" (initial + dynamic)', () => {
    // The per-table display lives in the Markdown tree (fade + in-node bar);
    // the aggregate header pill keeps the dynamic "Rendering N%…" text.
    expect(guiAppHtml).toContain('mdt-render-pending'); // per-node fade
    expect(guiAppHtml).toContain('mdt-render-fill'); // per-node bar
    expect(guiAppHtml).toContain("'Rendering ' + Math.round(sum / active.length) + '%"); // header pill
  });

  it('#3 the top bar gets an explicit stacking context (dropdowns above cards)', () => {
    expect(guiAppHtml).toContain('position: relative; z-index: 100;');
  });

  it('#7 the chat Private-mode toggle is checked+disabled on local workspaces', () => {
    expect(guiAppHtml).toContain("cloudMode ? '' : ' checked disabled'");
    expect(guiAppHtml).toContain('Local workspaces are always private');
  });

  it('#8 the sidebar objects list is sorted alphabetically by display label', () => {
    expect(guiAppHtml).toContain('firstClass.sort(');
  });

  it('#11 the "Chat" settings tab is gone; System Prompt lives under Workspace', () => {
    expect(guiAppHtml).not.toContain('data-tab="chat"');
    expect(guiAppHtml).toContain('renderSystemPromptPanel');
    expect(guiAppHtml).toContain('>System Prompt<');
  });

  it('#12 the members list renders a Kick control (not the bare Postgres role)', () => {
    expect(guiAppHtml).toContain('data-kick='); // owner Kick button
    expect(guiAppHtml).toContain('/api/cloud/remove-member');
  });
});
