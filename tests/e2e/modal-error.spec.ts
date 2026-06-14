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

// 3.0.1: a failed modal submit (e.g. "Join a cloud" → bad credentials) used to
// surface as a .toast that paints BEHIND the modal backdrop's blur — blurry and
// detached from the dialog. The fix routes every showModal failure into an
// inline .modal-error region inside the pane. This test forces a submit failure
// through the generic showModal path (the delete-workspace confirm modal) and
// asserts the error renders in-pane, not as a toast.
test.beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'lattice-e2e-modalerr-'));
  process.env.LATTICE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lattice-e2e-modalerr-home-'));
  process.env.LATTICE_ENCRYPTION_KEY = 'e2e-test-key';
  const root = ensureLatticeRoot(base);
  const alpha = addWorkspace(root, { displayName: 'Alpha' });
  // A sibling so the workspace UI behaves the same as a real multi-workspace
  // install (not strictly required — the delete call is intercepted).
  const beta = addWorkspace(root, { displayName: 'Beta' });
  for (const ws of [alpha, beta]) {
    const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
    db.close();
  }
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
  rmSync(base, { recursive: true, force: true });
});

test('a failed modal submit shows the error inside the pane, not as a toast behind the backdrop', async ({
  page,
}) => {
  await page.goto(`${server.url}#/settings/database`);

  // Open the delete-workspace confirm modal (a generic showModal with onSubmit).
  const deleteBtn = page.locator('#db-delete-btn');
  await expect(deleteBtn).toBeVisible();
  await deleteBtn.click();

  // Type the workspace name to enable the destructive OK button.
  const ok = page.locator('.modal-backdrop [data-act="ok"]');
  await expect(ok).toBeDisabled();
  await page.locator('#confirm-db-name').fill('Alpha');
  await expect(ok).toBeEnabled();

  // Force the submit to fail at the API so showModal's failure path runs.
  await page.route('**/api/workspaces/delete', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Invalid Postgres credentials' }),
    }),
  );
  await ok.click();

  // The error renders INSIDE the modal pane (descendant of .modal), visible
  // and sharp — not behind the blurred backdrop.
  const inPaneError = page.locator('.modal .modal-error');
  await expect(inPaneError).toBeVisible();
  await expect(inPaneError).toContainText('Failed: Invalid Postgres credentials');

  // The modal stays open so the user can correct and retry.
  await expect(page.locator('.modal-backdrop')).toBeVisible();

  // The failure is NOT carried by a toast (the old blurry-behind-backdrop bug).
  await expect(page.locator('.toast')).toHaveCount(0);
});
