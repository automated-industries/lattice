import { describe, it, expect } from 'vitest';
import { guiAppHtml } from '../../src/gui/app.js';

describe('guiAppHtml', () => {
  it('contains the structural DOM hooks the SPA boots against', () => {
    // Sidebar / nav mount points
    expect(guiAppHtml).toContain('id="object-nav"');
    expect(guiAppHtml).toContain('id="settings-nav"');
    expect(guiAppHtml).toContain('id="content"');

    // Settings entries
    expect(guiAppHtml).toContain('href="#/settings/data-model"');

    // Branding
    expect(guiAppHtml).toContain('Lattice');
  });

  it('boots from /api/entities on load', () => {
    expect(guiAppHtml).toContain("'/api/entities'");
  });
});
