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

  it('disables autocapitalize/autocorrect/spellcheck on Postgres wizard text inputs', () => {
    // The wizard renders id="w-user" / "w-host" / "w-dbname" / "w-label" /
    // "w-password" through postgresFormHtml. The fixed-string `attrs` var
    // applies to all five so we look for the combined attribute set
    // anywhere in the inline-rendered HTML.
    expect(guiAppHtml).toContain('autocapitalize="off"');
    expect(guiAppHtml).toContain('autocorrect="off"');
    expect(guiAppHtml).toContain('spellcheck="false"');
  });

  it('trims every text field in readPostgresWizardForm', () => {
    // The implementation uses a `get` helper that calls `.trim()` on each
    // read; we assert the trim is present in the form-reading function.
    expect(guiAppHtml).toContain('readPostgresWizardForm');
    expect(guiAppHtml).toContain(".value || '').trim()");
  });

  it('uses switch-not-discard wording in the Connect-Existing modal', () => {
    // The v1.13.1 wording said "Your local SQLite data will be ignored",
    // which mis-described the actual behavior (the file is preserved on
    // disk; only the YAML's db: line is rewritten). v1.13.2 reframes
    // this as a switch — the assertion guards against regression to the
    // old copy.
    expect(guiAppHtml).not.toContain('local SQLite data will be ignored');
    expect(guiAppHtml).toContain('Your local SQLite file is preserved');
  });
});
