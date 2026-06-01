import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import {
  Lattice,
  ensureLatticeRoot,
  addWorkspace,
  resolveWorkspacePaths,
} from '../../src/index.js';

let server: GuiServerHandle;
let base: string;

test.beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'lattice-e2e-ws-'));
  process.env.LATTICE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lattice-e2e-ws-home-'));
  process.env.LATTICE_ENCRYPTION_KEY = 'e2e-test-key';
  const root = ensureLatticeRoot(base);
  const alpha = addWorkspace(root, { displayName: 'Alpha' });
  const beta = addWorkspace(root, { displayName: 'Beta' });
  // Render both so either can be opened; Alpha stays active (created first).
  for (const ws of [alpha, beta]) {
    const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
    db.close();
  }
  const pa = resolveWorkspacePaths(root, alpha);
  // The server discovers the root by walking up from the workspace config —
  // no LATTICE_ROOT env needed, so this spec can't leak into other specs.
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
  rmSync(base, { recursive: true, force: true });
});

test('the header workspace switcher lists workspaces and switches the active one', async ({
  page,
}) => {
  await page.goto(server.url);

  const switcher = page.locator('#ws-switcher');
  await expect(switcher).toBeVisible();
  await expect(page.locator('#ws-name')).toHaveText('Alpha');

  await page.locator('#ws-button').click();
  const menu = page.locator('#ws-menu');
  await expect(menu).toBeVisible();
  const betaItem = menu.locator('button.db-item', { hasText: 'Beta' });
  await expect(betaItem).toBeVisible();

  await betaItem.click();
  // After switching, the header reflects the new active workspace.
  await expect(page.locator('#ws-name')).toHaveText('Beta');
});
