import { describe, it, expect } from 'vitest';
import { guiAppHtml } from '../../src/gui/app.js';

describe('guiAppHtml', () => {
  it('contains the structural DOM hooks the SPA boots against', () => {
    // Sidebar / content mount points
    expect(guiAppHtml).toContain('id="object-nav"');
    expect(guiAppHtml).toContain('id="content"');
    // The Advanced-mode toggle moved out of the sidebar into Settings → Lattice
    // (the old collapse control + static settings nav were already removed).
    expect(guiAppHtml).not.toContain('class="sidebar-advanced');
    expect(guiAppHtml).not.toContain('id="sidebar-collapse"');
    expect(guiAppHtml).not.toContain('id="settings-nav"');

    // Settings now live in a slide-over drawer opened by the header gear, with one
    // tab per settings page. (The "Advanced View" toggle + classic-editor feature
    // were removed — the file workspace is the single view.)
    expect(guiAppHtml).toContain('id="settings-gear"');
    expect(guiAppHtml).toContain('id="settings-drawer"');
    expect(guiAppHtml).toContain('id="drawer-body"');
    expect(guiAppHtml).toContain('data-tab="database"');
    expect(guiAppHtml).toContain('data-tab="lattice"');
    expect(guiAppHtml).toContain('data-tab="user"');
    expect(guiAppHtml).not.toContain('id="advanced-toggle"');

    // Data Model still lives inside Database Settings (renderEntityEditorInto —
    // an entity list + editor), rendered into the drawer body. The schema graph
    // itself moved to the center brain view (renderBrainGraph).
    expect(guiAppHtml).not.toContain('href="#/settings/data-model"');
    expect(guiAppHtml).toContain('id="data-model-host"');
    expect(guiAppHtml).toContain('renderEntityEditorInto');
    expect(guiAppHtml).toContain('renderBrainGraph');

    // The file-system workspace is the single view (the classic table editor
    // was absorbed into the unified record page and retired).
    expect(guiAppHtml).toContain('renderFsCollection');
    expect(guiAppHtml).toContain('renderFsItem');
    expect(guiAppHtml).toContain('loadFieldsEditor'); // the absorbed structured editor

    // Branding
    expect(guiAppHtml).toContain('Lattice');
  });

  it('boots from /api/entities-summary on load (the no-disk-scan Objects list)', () => {
    // Boot / workspace switch / post-mutation reloads use the summary endpoint
    // (tables + counts, no O(files) rendered-file scan) — the GUI never read the
    // scanned `entities` field.
    expect(guiAppHtml).toContain("'/api/entities-summary'");
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

  it('removes the standalone "Connect to existing cloud" (join-a-cloud-on-its-own) modal', () => {
    // 1.16.4: the standalone "connect to a raw cloud" path was removed — you
    // either migrate to a cloud or join a team via invite. The modal + its copy
    // are gone from the bundle (joining via invite stays).
    expect(guiAppHtml).not.toContain('Your local SQLite file is preserved');
    expect(guiAppHtml).not.toContain('Connect to existing cloud');
    expect(guiAppHtml).not.toContain('function showConnectExistingModal');
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

  it('never renders a cloud connection URL with a plaintext password', () => {
    // The retired postgres:// URL methodology rendered/parsed a connection string
    // and redacted it via redactUrlCredentials. Cloud connection input is now the
    // structured form everywhere: the password is a masked type="password" input
    // (never echoed) and no postgres:// URL is rendered, so a plaintext password
    // cannot reach the DOM. The old un-redacted regression patterns must still be
    // absent, and the retired URL-redaction helper is gone.
    expect(guiAppHtml).not.toMatch(/escapeHtml\(conn\.cloud_url\)/);
    expect(guiAppHtml).not.toMatch(/escapeHtml\(c\.cloud_url\)/);
    expect(guiAppHtml).toMatch(/<input type="password" id="w-password"/);
    expect(guiAppHtml).not.toContain('redactUrlCredentials');
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
    // Text-like modal inputs (radios/checkboxes are excluded from this rule so
    // they keep native rendering) pin an explicit surface + text color.
    expect(guiAppHtml).toMatch(
      /\.modal \.field input[^{]*, \.modal \.field textarea \{[\s\S]*?background: var\(--surface\);[\s\S]*?color: var\(--text\);/,
    );
  });

  it('cloud member admin lives in Database Settings, not a legacy team card', () => {
    // The legacy project-config team-card UI (renderTeamCard /
    // renderTeamsForProjectConfig / wireTeamCardActions) was removed.
    expect(guiAppHtml).not.toContain('renderTeamCard');
    expect(guiAppHtml).not.toContain('renderTeamsForProjectConfig');
    expect(guiAppHtml).not.toContain('wireTeamCardActions');
    // The members list (recovered from 1.14.0) lives in Database Settings,
    // backed by /api/cloud/members (the lattice_members group) — not a legacy
    // project-config team card. The owner invites via an email-bound token.
    expect(guiAppHtml).toContain('renderMembersList');
    expect(guiAppHtml).toContain('db-members-host');
    expect(guiAppHtml).toContain('showInviteMemberModal');
    // Exit action: a single neutral "Forget this cloud" that switches the
    // client back to a local workspace (no disconnect/leave registry calls).
    expect(guiAppHtml).toContain('db-forget-btn');
    expect(guiAppHtml).not.toContain('db-disconnect-btn');
    expect(guiAppHtml).not.toContain('db-leave-btn');
  });

  it('3.3: stamps the package version in the Settings drawer footer', () => {
    // The shell carries a placeholder that startGuiServer() replaces with the
    // real `v<version>` at serve time (so the static bundle stays version-free).
    expect(guiAppHtml).toContain('id="app-version"');
    expect(guiAppHtml).toContain('<!--LATTICE_VERSION-->');
    // The version moved OUT of the header (its old spot is now the status-pill
    // slot) and into the Settings drawer footer — so it sits AFTER the gear now.
    expect(guiAppHtml).toContain('class="drawer-version"');
    expect(guiAppHtml).toContain('id="header-status-slot"');
    expect(guiAppHtml.indexOf('id="app-version"')).toBeGreaterThan(
      guiAppHtml.indexOf('id="settings-gear"'),
    );
  });

  it('3.3: composer attach control is an upload icon, not the paperclip glyph', () => {
    expect(guiAppHtml).toContain('id="chat-clip"');
    // Native multi-select picker stays the whole feature.
    expect(guiAppHtml).toContain('id="chat-file" multiple');
    // The clip button now renders an inline upload-tray SVG; the 📎 glyph is gone.
    expect(guiAppHtml).toContain('title="Upload files"');
    expect(guiAppHtml).not.toContain('>📎</button>');
  });

  it('3.3: definition tooltips are wired (colDesc/tableDesc/titleAttr helpers)', () => {
    expect(guiAppHtml).toContain('function colDesc(');
    expect(guiAppHtml).toContain('function tableDesc(');
    expect(guiAppHtml).toContain('function titleAttr(');
  });

  it('3.4: "Specific people" grants STAGE a multi-select and commit via one batch Save', () => {
    // Per-row custom-share is now staged: the checklist lists member ROLES (the
    // grant target the RLS function keys on), toggles mutate a local map only,
    // and a single "Save sharing" control commits the whole batch through the
    // owner-only batch route.
    expect(guiAppHtml).toContain("'/api/cloud/row-grants'");
    expect(guiAppHtml).toContain('data-grant-role');
    // The batch Save control ships (primary button) + a staging session is tracked.
    expect(guiAppHtml).toContain('id="grants-save"');
    expect(guiAppHtml).toContain('Save sharing');
    expect(guiAppHtml).toContain('openGrantsPanel');
    // The OLD live-per-checkbox commit is gone: a 'change' listener that directly
    // POSTed a single /api/cloud/row-grant {grantee, revoke} on every toggle.
    expect(guiAppHtml).not.toContain("'/api/cloud/row-grant'");
    expect(guiAppHtml).not.toContain('grantee: role, revoke: !cb.checked');
    // The dead ad-hoc per-row grants endpoint (no server route existed) is gone.
    expect(guiAppHtml).not.toContain("/rows/' + encodeURIComponent(id) + '/grants");
  });

  it('3.3: workspace-logo Display panel + topbar swap are wired', () => {
    // The "Name" subsection is renamed "Display" and gains a logo control.
    expect(guiAppHtml).toContain('>Display</h3>');
    expect(guiAppHtml).toContain('function applyWorkspaceLogo(');
    expect(guiAppHtml).toContain('/api/cloud/workspace-logo');
    // The default topbar mark is still the inline SVG fallback.
    expect(guiAppHtml).toContain('class="brand-logo"');
  });

  it('3.3: boot loading interstitial ships in the static shell and masks the shell', () => {
    expect(guiAppHtml).toContain('id="app-loading"');
    // It must come BEFORE the app script + the placeholder "workspace" label so
    // it paints first and (at z-index 1500) covers them.
    expect(guiAppHtml.indexOf('id="app-loading"')).toBeLessThan(guiAppHtml.indexOf('id="ws-name"'));
    // a11y + hide hook + opaque (not a translucent scrim) background.
    expect(guiAppHtml).toContain('aria-busy');
    expect(guiAppHtml).toContain('aria-live');
    expect(guiAppHtml).toContain('function hideAppLoading(');
    expect(guiAppHtml).toContain('is-hidden');
    expect(guiAppHtml).toMatch(/\.app-loading\s*\{[\s\S]*?background:\s*var\(--bg\)/);
    // reduced-motion neutralizes the boot spinner.
    expect(guiAppHtml).toContain('app-loading-spinner');
  });

  it('3.3: virgin (zero-workspace) state + onboarding wizard are wired', () => {
    expect(guiAppHtml).toContain('function renderVirginState(');
    expect(guiAppHtml).toContain('function showOnboardingWizard(');
    expect(guiAppHtml).toContain('Welcome to Lattice');
    // The onboarding wizard drives the existing create/join/migrate APIs.
    expect(guiAppHtml).toContain("'/api/workspaces/create'");
    expect(guiAppHtml).toContain("'/api/cloud/redeem-invite'");
    expect(guiAppHtml).toContain("'/api/dbconfig/migrate-to-cloud'");
  });

  it('Claude auth is OAuth-only: connect at the wall, disconnect in the account menu, no API-key UI', () => {
    // Connect happens at the first-run wall (the surface-agnostic OAuth anchor).
    expect(guiAppHtml).toContain('/api/assistant/oauth/start');
    expect(guiAppHtml).toContain('Connect with Claude');
    // Disconnect lives in the header account menu.
    expect(guiAppHtml).toContain('account-disconnect');
    expect(guiAppHtml).toContain('Connected with Claude');
    // The per-user API-key settings UI is gone (OAuth-only).
    expect(guiAppHtml).not.toContain('Advanced — use an API key instead');
    expect(guiAppHtml).not.toContain('asst-oauth-disconnect');
  });

  it('computed-table builder: routed under Tables and wired to the HTTP surface', () => {
    // The full-page builder renders at #/computed/new | #/computed/<name>
    // (renderRoute dispatch) and the Tables tab stays lit (tabKeyForHash).
    expect(guiAppHtml).toContain('function renderComputedBuilder(');
    expect(guiAppHtml).toContain("hash.indexOf('#/computed/') === 0");
    // The builder drives the computed-tables HTTP surface: field picker,
    // dry-run preview, create/save, and the NDJSON refresh stream.
    expect(guiAppHtml).toContain('/api/computed-tables/fields?base=');
    expect(guiAppHtml).toContain("'/api/computed-tables/preview'");
    expect(guiAppHtml).toContain("'/api/computed-tables'");
    expect(guiAppHtml).toContain("+ '/refresh'");
    // The five kinds carry user-facing labels in the kind <select>.
    expect(guiAppHtml).toContain('Copy a field');
    expect(guiAppHtml).toContain('AI category');
    expect(guiAppHtml).toContain('Total across links');
    // The Tables explorer offers the builder entry point + computed detail
    // actions, and lineage understands the computes edge.
    expect(guiAppHtml).toContain('id="mt-computed-new"');
    expect(guiAppHtml).toContain('function mtWireComputedDetail(');
    expect(guiAppHtml).toContain("ed.type === 'computes'");
  });

  it('computed tables render read-only on record + collection pages', () => {
    // A computedTable entity gets a badge + a where-values-come-from note, and
    // the record page swaps the editable context for a read-only field list.
    expect(guiAppHtml).toContain('fs-computed-badge');
    expect(guiAppHtml).toContain('its values come from the records');
    expect(guiAppHtml).toContain('function loadComputedContext(');
    // The styles for the badge/note/read-only list ship in the stylesheet.
    expect(guiAppHtml).toContain('.fs-computed-note');
    expect(guiAppHtml).toContain('.fs-computed-fields');
    // The projection connector draws dashed, distinct from the m2m links.
    expect(guiAppHtml).toContain('.mt-edge-computes');
    expect(guiAppHtml).toContain('mt-edge mt-edge-computes');
  });
});
