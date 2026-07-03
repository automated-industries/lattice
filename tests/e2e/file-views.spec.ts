import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootGui, type BootedGui } from './helpers.js';

/**
 * 4.3 — file/artifact document view. Opening a file shows the formatted view with
 * an actions dropdown (View source / Version history / Delete) beside the title;
 * "View source" switches to a full-page raw-text mode; editing the content mutates
 * the SAME row (no new file) and is kept in version history; "Delete" is a
 * recoverable soft-delete that never touches the on-disk file.
 */

let gui: BootedGui;
let mdFile: string;
let srcDir: string;
test.beforeEach(async () => {
  gui = await bootGui();
  srcDir = mkdtempSync(join(tmpdir(), 'lattice-fv-e2e-'));
  mdFile = join(srcDir, 'note.md');
  writeFileSync(mdFile, '# Hello\n\noriginal body');
});
test.afterEach(async () => {
  await gui.close();
  rmSync(srcDir, { recursive: true, force: true });
});

async function ingestFile(page: import('@playwright/test').Page): Promise<string> {
  const res = await page.request.post(gui.url + '/api/sources/roots', {
    data: { path: mdFile, kind: 'file' },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { result: { id: string } };
  return body.result.id;
}

test('a file gets the UNIFIED record page: toggle + sharing + provenance + menu', async ({
  page,
}) => {
  const id = await ingestFile(page);
  await page.goto(gui.url + '#/fs/files/' + id);
  // Formatted view by default: the inline preview inside the shared chrome.
  await expect(page.locator('#file-preview')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.fs-doc')).toHaveCount(0);
  // The SAME chrome as every record page: the Formatted|Markdown toggle, the
  // visibility/sharing line, and the collapsible Data provenance panel.
  await expect(page.locator('.fs-view-toggle')).toBeVisible();
  await expect(page.locator('#row-provenance')).toContainText('Data provenance');
  // The actions dropdown carries history + delete (source moved to the toggle).
  await expect(page.locator('#file-menu-btn')).toBeVisible();
  await page.locator('#file-menu-btn').click();
  await expect(page.locator('.file-menu-item[data-act="history"]')).toBeVisible();
  await expect(page.locator('.file-menu-item[data-act="delete"]')).toBeVisible();
  await expect(page.locator('.file-menu-item[data-act="source"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Markdown (source) mode enters via the shared toggle…
  await page.locator('.fs-view-toggle [data-fsview="markdown"]').click();
  await expect(page.locator('.file-source-pre')).toContainText('original body', { timeout: 5000 });
  // …and Formatted returns to the preview.
  await page.locator('.fs-view-toggle [data-fsview="formatted"]').click();
  await expect(page.locator('#file-preview')).toBeVisible();
});

test('in-place content edit mutates the same row and is kept in history', async ({ page }) => {
  const id = await ingestFile(page);
  // Count files rows before editing.
  const before = await (await page.request.get(gui.url + '/api/tables/files/rows')).json();
  const countBefore = (before as { rows: unknown[] }).rows.length;

  // Edit the content in place (the same path the Source-view Save uses).
  const put = await page.request.put(gui.url + '/api/tables/files/rows/' + id + '/content', {
    data: { text: 'EDITED BODY' },
  });
  expect(put.ok()).toBeTruthy();

  // Same row, updated — and NO new file row was spawned.
  const row = (await (await page.request.get(gui.url + '/api/tables/files/rows/' + id)).json()) as {
    extracted_text: string;
  };
  expect(row.extracted_text).toBe('EDITED BODY');
  const after = await (await page.request.get(gui.url + '/api/tables/files/rows')).json();
  expect((after as { rows: unknown[] }).rows.length).toBe(countBefore);

  // The edit is recorded in the row's version history.
  const hist = (await (
    await page.request.get(gui.url + '/api/tables/files/rows/' + id + '/history')
  ).json()) as { history: unknown[] };
  expect(hist.history.length).toBeGreaterThan(0);
});

test('Delete soft-deletes the record but never the on-disk file', async ({ page }) => {
  const id = await ingestFile(page);
  await page.goto(gui.url + '#/fs/files/' + id);
  await page.locator('#file-menu-btn').click();
  await page.locator('.file-menu-item[data-act="delete"]').click();
  // The row is soft-deleted (recoverable from trash), not hard-deleted…
  await expect
    .poll(
      async () => {
        const trash = await (
          await page.request.get(gui.url + '/api/tables/files/rows?deleted=only')
        ).json();
        return (trash as { rows: { id: string }[] }).rows.some((r) => r.id === id);
      },
      { timeout: 8000 },
    )
    .toBe(true);
  // …and the user's on-disk file is untouched.
  expect(existsSync(mdFile)).toBe(true);
});
