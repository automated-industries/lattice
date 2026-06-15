import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';

/**
 * Regression — there were TWO cloud-workspace creation methodologies: the
 * onboarding / "Migrate to cloud" flows used the structured Postgres form
 * (postgresFormHtml: Host / Port / Database / User / Password), while the header
 * "New workspace" wizard used a single retired `postgres://` connection-string
 * field (parsed client-side by parsePostgresUrl). Every cloud-create path must
 * now use the ONE shared structured form + the /api/dbconfig/migrate-to-cloud
 * backend — the postgres:// URL methodology is retired and fully removed.
 */
describe('cloud-create is unified on the structured connection form', () => {
  it('retired the postgres:// URL input + its helpers', () => {
    expect(appJs).not.toContain('parsePostgresUrl');
    expect(appJs).not.toContain('redactUrlCredentials');
    expect(appJs).not.toContain('wiz-cloud-url');
    expect(appJs).not.toContain('wizState.cloudUrl');
  });

  it('every cloud-create flow uses the shared structured form + migrate-to-cloud', () => {
    // The shared form helper is the single connection-input component.
    expect(appJs).toContain('function postgresFormHtml');
    expect(appJs).toContain('function readPostgresWizardForm');
    // The header "New workspace" wizard now renders that same form for the cloud
    // kind and captures the structured fields into wizState.pg.
    expect(appJs).toContain('wizState.pg');
    // All cloud creation routes through the one backend endpoint.
    expect(appJs).toContain("fetch('/api/dbconfig/migrate-to-cloud'");
  });

  it('migrate-to-cloud success re-fetches everything (no manual refresh needed)', () => {
    // showMigrateToCloudModal must call reloadEverything() on success so the
    // swapped-to-cloud state (entities + per-row _access sharing) shows live.
    const modalStart = appJs.indexOf('function showMigrateToCloudModal');
    // Bound by the next NAMED top-level function (renderSystemPromptPanel follows
    // the modal) — not the first inner anonymous `function`.
    const modalEnd = appJs.indexOf('function renderSystemPromptPanel', modalStart + 1);
    expect(modalStart).toBeGreaterThan(-1);
    expect(modalEnd).toBeGreaterThan(modalStart);
    const modalSrc = appJs.slice(modalStart, modalEnd);
    expect(modalSrc).toContain('/api/dbconfig/migrate-to-cloud');
    expect(modalSrc).toContain('reloadEverything()');
  });
});
