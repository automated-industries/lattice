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

  it('detectSupabasePoolerMistakes is wired into the SPA bundle', () => {
    // The function lives inline in the GUI app source. Verify the bundle
    // contains both the function symbol and its hint strings so a future
    // refactor that accidentally drops the validation surface trips this
    // test instead of shipping silently.
    expect(guiAppHtml).toContain('detectSupabasePoolerMistakes');
    expect(guiAppHtml).toContain('tenant-prefixed user');
    expect(guiAppHtml).toContain('transaction mode');
  });

  it('Migrate-to-cloud modal probes before saving the credential', () => {
    // v1.13.2 + earlier sent the form straight to /api/dbconfig/migrate-to-cloud
    // without probing first — a wrong host/port/user got persisted and
    // failed silently on the next open. v1.13.3 routes Migrate through
    // probeBeforeCredentialSave so the credential is never saved without
    // proving it can actually connect.
    expect(guiAppHtml).toContain('probeBeforeCredentialSave');
  });
});
