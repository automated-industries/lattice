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

    // Topbar upload button + Files/Folder menu, wired to the ingest flow.
    expect(guiAppHtml).toContain('id="upload-btn"');
    expect(guiAppHtml).toContain('id="upload-menu"');
    expect(guiAppHtml).toContain('id="upload-input"');
    expect(guiAppHtml).toContain('id="upload-folder-input"');
    expect(guiAppHtml).toContain('webkitdirectory');
    expect(guiAppHtml).toContain('initUploadButton');

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

  it('lets the composer paperclip attach files or a whole folder (webkitdirectory)', () => {
    // The paperclip now opens a Files/Folder menu like the topbar Upload button,
    // backed by a second webkitdirectory input, both feeding uploadFiles().
    expect(guiAppHtml).toContain('id="chat-clip-menu"');
    expect(guiAppHtml).toContain('id="chat-clip-files"');
    expect(guiAppHtml).toContain('id="chat-clip-folder"');
    expect(guiAppHtml).toContain('id="chat-folder" webkitdirectory');
  });

  it('wires the Check-for-duplicates action: auto-dedupe exact + animated removal + review modal', () => {
    expect(guiAppHtml).toContain('id="check-dupes"');
    // Auto-removes exact dups and animates the rows dissolving out of the table.
    expect(guiAppHtml).toContain('function autoDedupeExact');
    expect(guiAppHtml).toContain('function animateDedupeRemoval');
    expect(guiAppHtml).toContain('row-dissolving');
    // Near-matches still go through the manual review modal + merge.
    expect(guiAppHtml).toContain('function showDedupModal');
    expect(guiAppHtml).toContain("'/api/dedup/find'");
    expect(guiAppHtml).toContain("'/api/dedup/merge'");
    expect(guiAppHtml).toContain('function dedupMerge');
    // Undo path restores the soft-deleted duplicates.
    expect(guiAppHtml).toContain('function dedupRestore');
  });

  it('attributes automatic ops to Lattice and manual edits to the user (not "you")', () => {
    expect(guiAppHtml).toContain('function feedActorLabel');
    expect(guiAppHtml).toContain("return 'Lattice'");
    // Manual gui edits read the loaded display name, falling back to "you".
    expect(guiAppHtml).toContain('state.displayName');
    expect(guiAppHtml).toContain("'/api/userconfig/identity'");
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

  it('cloud member admin lives in Database Settings, not a legacy team card', () => {
    // The legacy project-config team-card UI (renderTeamCard /
    // renderTeamsForProjectConfig / wireTeamCardActions) was removed.
    expect(guiAppHtml).not.toContain('renderTeamCard');
    expect(guiAppHtml).not.toContain('renderTeamsForProjectConfig');
    expect(guiAppHtml).not.toContain('wireTeamCardActions');
    // v3: there is no server-side member registry / members list. The owner
    // invites by provisioning a scoped role (/api/cloud/invite); the panel
    // surfaces that as an "Invite a member" affordance.
    expect(guiAppHtml).not.toContain('renderMembersList');
    expect(guiAppHtml).toContain('showInviteMemberModal');
    // Exit action: a single neutral "Forget this cloud" that switches the
    // client back to a local workspace (no disconnect/leave registry calls).
    expect(guiAppHtml).toContain('db-forget-btn');
    expect(guiAppHtml).not.toContain('db-disconnect-btn');
    expect(guiAppHtml).not.toContain('db-leave-btn');
  });

  it('resets a #/settings/* hash when closing the drawer so the link re-opens on re-click', () => {
    // Regression: the drawer opens via a #/settings/* hash (e.g. the
    // "User Settings → Assistant" link). closeSettingsDrawer left that hash in
    // place, so clicking the same link again fired no hashchange and the drawer
    // never re-opened. The fix resets the hash to #/ via replaceState on close.
    expect(guiAppHtml).toContain('function closeSettingsDrawer');
    expect(guiAppHtml).toContain("history.replaceState(null, '', '#/')");
    // Guarded so it only fires for drawer routes, not the history page or a
    // gear-opened drawer over a non-settings route.
    expect(guiAppHtml).toContain("h.indexOf('#/settings/') === 0 && h !== '#/settings/history'");
  });

  it('shows an aggregate progress toast for multi-file/folder uploads', () => {
    // A folder pick / multi-select fans out to one ingest POST per file. Instead
    // of one transient pill per file, a single persistent progress card tracks
    // the whole batch (done / total + a bar), reusing an in-flight batch.
    // The toast element is built via DOM properties (el.id / el.className), so
    // the bundle carries the bare string literals, not HTML attributes.
    expect(guiAppHtml).toContain("'upload-progress-toast'");
    expect(guiAppHtml).toContain("className = 'upload-progress'");
    expect(guiAppHtml).toContain('up-bar-fill');
    expect(guiAppHtml).toContain('function enqueueUploadBatch');
    expect(guiAppHtml).toContain('function tickUploadBatch');
    // Batch uploads suppress the per-file feed spinner (silentFeed) to avoid
    // flooding the rail with one "Analyzing…" row per file.
    expect(guiAppHtml).toContain('silentFeed');
  });

  it('lists files that were not fully ingested (skipped / failed) in the toast', () => {
    // A 200-OK 'skipped' file (archive, image, >100-page PDF) got a row but no
    // text — it must be surfaced, not counted as a silent success. The toast
    // shows a per-file list with a human-readable reason, kept open until the
    // user dismisses it.
    expect(guiAppHtml).toContain('function renderUploadIssues');
    expect(guiAppHtml).toContain('function uploadIssueReason');
    expect(guiAppHtml).toContain('not fully ingested');
    expect(guiAppHtml).toContain('up-issue-list');
    // Reads the real per-file outcome off the response, not just HTTP status.
    expect(guiAppHtml).toContain('extraction_status');
    // A single skipped file (no batch toast) is surfaced as a one-off toast
    // naming the file + reason, reusing uploadIssueReason.
    expect(guiAppHtml).toContain('not fully ingested: ');
  });
});
