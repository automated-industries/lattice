import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import {
  Lattice,
  ensureLatticeRoot,
  addWorkspace,
  resolveWorkspacePaths,
} from '../../src/index.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';

// A degraded boot (a load-bearing read fails at startup) must NOT silently brick into
// an empty-looking workspace: it must surface the failure AND self-heal once the reads
// recover — no manual reload. The server here is healthy; the failures are injected on
// the client side (route interception) to model a transient read failure at boot.
test.describe.configure({ mode: 'serial' });

let server: GuiServerHandle;

test.beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), 'lattice-e2e-boot-'));
  process.env.LATTICE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lattice-e2e-boot-home-'));
  process.env.LATTICE_ENCRYPTION_KEY = 'e2e-test-key';
  seedClaudeOAuth();
  process.env.LATTICE_ROOT = join(base, '.lattice');
  const root = ensureLatticeRoot(base);
  const alpha = addWorkspace(root, { displayName: 'Alpha' });
  const db = await Lattice.openWorkspace({ root, workspaceId: alpha.id });
  db.close();
  const pa = resolveWorkspacePaths(root, alpha);
  server = await startGuiServer({
    configPath: pa.configPath,
    outputDir: pa.contextDir,
    port: 0,
    host: '127.0.0.1',
    teamCloud: false,
    openBrowser: false,
  });
});

test.afterAll(async () => {
  await server.close();
});

test('a degraded boot surfaces a visible error instead of a silent empty workspace', async ({
  page,
}) => {
  // Both load-bearing boot reads fail for the whole session.
  await page.route('**/api/entities-summary', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"degraded"}' }),
  );
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"degraded"}' }),
  );

  await page.goto(server.url + '#/');

  // The escape-hatch notice is visible in the content pane. Before the fix, renderRoute
  // ran first and its async render clobbered the placeholder, so nothing was surfaced —
  // this assertion fails there.
  await expect(page.locator('#content .boot-degraded-notice')).toBeVisible({ timeout: 10000 });
  // The switcher is NOT painted as a misleading empty registry. A failed
  // /api/workspaces is unknown, not empty, so renderWsSwitcher leaves the menu
  // unbuilt rather than rendering the empty-registry menu ("+ New workspace" only) —
  // before the fix, buildMenu ran on the null list and produced that .db-create row.
  await expect(page.locator('#ws-menu .db-create')).toHaveCount(0);
});

test('a degraded boot self-heals once the reads recover, with no manual reload', async ({
  page,
}) => {
  // Fail only the FIRST call of each load-bearing read (the boot); the self-heal's
  // refetch then succeeds — a transient read failure at startup.
  let esCalls = 0;
  let wsCalls = 0;
  await page.route('**/api/entities-summary', (route) => {
    esCalls += 1;
    if (esCalls === 1)
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' });
    return route.continue();
  });
  await page.route('**/api/workspaces', (route) => {
    wsCalls += 1;
    if (wsCalls === 1)
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' });
    return route.continue();
  });

  await page.goto(server.url + '#/');

  // Degraded first…
  await expect(page.locator('#content .boot-degraded-notice')).toBeVisible({ timeout: 8000 });
  // …then self-heals with no reload: the notice clears and the switcher populates with
  // the real workspace. Before the fix there is no retry path, so this never recovers.
  await expect(page.locator('#content .boot-degraded-notice')).toBeHidden({ timeout: 20000 });
  await expect(page.locator('#ws-name')).toHaveText('Alpha', { timeout: 8000 });
});

test('self-heals a workspaces-list-only failure (entities healthy) until the list recovers', async ({
  page,
}) => {
  // Only the workspace LIST read fails (its own transient registry/FS error); entities
  // read fine, so the content pane works but the switcher is unbuilt. The self-heal must
  // keep retrying until the list recovers — not declare success just because entities is
  // readable. Fail the first few /api/workspaces calls, then let them succeed.
  let wsCalls = 0;
  await page.route('**/api/workspaces', (route) => {
    wsCalls += 1;
    if (wsCalls <= 3)
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' });
    return route.continue();
  });

  await page.goto(server.url + '#/');

  // The header switcher starts on the generic shell label (list unknown)…
  await expect(page.locator('#ws-name')).toHaveText('workspace');
  // …and self-heals to the real workspace once the list read recovers, no manual reload.
  // Before the fix, the self-heal cleared the degraded flag after one entities-only
  // success and never retried the list, so the switcher stayed stuck on 'workspace'.
  await expect(page.locator('#ws-name')).toHaveText('Alpha', { timeout: 20000 });
});
