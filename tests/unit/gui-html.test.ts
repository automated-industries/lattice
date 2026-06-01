import { describe, it, expect } from 'vitest';
import { guiAppHtml } from '../../src/gui/app.js';

describe('guiAppHtml', () => {
  it('contains the structural DOM hooks the SPA boots against', () => {
    // Sidebar / content mount points
    expect(guiAppHtml).toContain('id="object-nav"');
    expect(guiAppHtml).toContain('id="content"');
    // The sidebar carries the Advanced-mode toggle at its top (the old
    // collapse control was removed); the static settings nav moved into the
    // gear-triggered drawer.
    expect(guiAppHtml).toContain('class="sidebar-advanced');
    expect(guiAppHtml).not.toContain('id="sidebar-collapse"');
    expect(guiAppHtml).not.toContain('id="settings-nav"');

    // Settings now live in a slide-over drawer opened by the header gear,
    // with one tab per existing settings page + the Advanced-mode toggle.
    expect(guiAppHtml).toContain('id="settings-gear"');
    expect(guiAppHtml).toContain('id="settings-drawer"');
    expect(guiAppHtml).toContain('id="drawer-body"');
    expect(guiAppHtml).toContain('data-tab="database"');
    expect(guiAppHtml).toContain('data-tab="lattice"');
    expect(guiAppHtml).toContain('data-tab="user"');
    expect(guiAppHtml).toContain('id="advanced-toggle"');

    // Data Model still lives inside Database Settings (renderDataModelInto),
    // now rendered into the drawer body rather than a full page.
    expect(guiAppHtml).not.toContain('href="#/settings/data-model"');
    expect(guiAppHtml).toContain('id="data-model-host"');
    expect(guiAppHtml).toContain('renderDataModelInto');

    // The file-system workspace + classic table editor both ship.
    expect(guiAppHtml).toContain('renderFsCollection');
    expect(guiAppHtml).toContain('renderFsItem');
    expect(guiAppHtml).toContain('renderTable');

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

  it('renders cloud URLs via redactUrlCredentials (no plaintext passwords in DOM)', () => {
    // The team cards used to render `escapeHtml(conn.cloud_url)` directly —
    // when conn.cloud_url is a postgres://user:password@host/db URL the
    // password ended up as plaintext in the GUI. v1.13.4 routes every
    // cloud_url through redactUrlCredentials.
    expect(guiAppHtml).toContain('redactUrlCredentials');
    // Direct un-redacted patterns are the regression — must NOT appear
    // anywhere in the bundle.
    expect(guiAppHtml).not.toMatch(/escapeHtml\(conn\.cloud_url\)/);
    expect(guiAppHtml).not.toMatch(/escapeHtml\(c\.cloud_url\)/);
  });

  it('removes the team-card Sync button + outbox/DLQ/last-seq stats (realtime against canonical store)', () => {
    // v1.13.4: the GUI no longer exposes a "Sync now" action. Lattice
    // is realtime against whatever its db: line points at — either
    // direct Postgres or local SQLite. The HTTP-mode outbox + change
    // log machinery is still available via `lattice teams sync` on the
    // CLI for power users, but the GUI no longer pretends the user
    // needs to nudge it.
    expect(guiAppHtml).not.toContain('data-act="sync"');
    expect(guiAppHtml).not.toContain('Sync now');
    // Outbox / DLQ / Last seq stats are gone too — they were
    // sync-loop artifacts.
    expect(guiAppHtml).not.toMatch(/stat-label">Outbox/);
    expect(guiAppHtml).not.toMatch(/stat-label">DLQ/);
    expect(guiAppHtml).not.toMatch(/stat-label">Last seq/);
  });

  it('modal field labels and inputs render with explicit dark-surface contrast', () => {
    // v1.13.7 left .modal .field label at var(--text-muted) and gave inputs
    // no explicit background/color — so a browser UA stylesheet or zoom-
    // overlay rendering the modal body in light mode produced unreadable
    // light-gray-on-white text. v1.13.8 pins both to explicit surface +
    // text variables so the labels stay readable regardless of theme.
    expect(guiAppHtml).toMatch(
      /\.modal \.field label \{[\s\S]*?color: var\(--text\);[\s\S]*?font-weight: 500;/,
    );
    expect(guiAppHtml).toMatch(
      /\.modal \.field input, \.modal \.field textarea \{[\s\S]*?background: var\(--surface\);[\s\S]*?color: var\(--text\);/,
    );
  });

  it('redactUrlCredentials uses an ASCII mask so URL.toString() does not percent-encode it', () => {
    // v1.13.7 set u.password to a bullet glyph; URL.toString() then
    // percent-encoded the non-ASCII userinfo character and rendered
    // "%E2%80%A2" in the GUI. v1.13.8 uses '****' which is ASCII-only.
    expect(guiAppHtml).toMatch(/u\.password = '\*+'/);
    expect(guiAppHtml).not.toMatch(/u\.password = '••+'/);
  });

  it('team member admin lives in Database Settings, not a legacy team card', () => {
    // The legacy project-config team-card UI (renderTeamCard /
    // renderTeamsForProjectConfig / wireTeamCardActions) was removed —
    // team member admin now lives inline in Database Settings via the
    // members list. Guard against the dead code creeping back.
    expect(guiAppHtml).not.toContain('renderTeamCard');
    expect(guiAppHtml).not.toContain('renderTeamsForProjectConfig');
    expect(guiAppHtml).not.toContain('wireTeamCardActions');
    // The live members-list path marks the current operator + per-row actions.
    expect(guiAppHtml).toContain('renderMembersList');
    expect(guiAppHtml).toContain('leave-self');
  });
});
