import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

// A small relational schema that exercises all three relation kinds the
// file-system view drills through:
//   authors --(1:N)--> books        (books.author_id ref authors)
//   books   --(1:N)--> reviews      (reviews.book_id ref books)
//   books   --(M:N)--> tags         (book_tags junction)
const REL_YAML = [
  'db: ./data/app.db',
  'name: fs-e2e',
  '',
  'entities:',
  '  authors:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      name: { type: text }',
  '      bio: { type: text }',
  '      deleted_at: { type: text }',
  '    outputFile: authors.md',
  '  books:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      title: { type: text }',
  '      summary: { type: text }',
  '      author_id: { type: uuid }',
  '      deleted_at: { type: text }',
  '    relations:',
  '      author: { type: belongsTo, table: authors, foreignKey: author_id }',
  '    outputFile: books.md',
  '  reviews:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      body: { type: text }',
  '      book_id: { type: uuid }',
  '      deleted_at: { type: text }',
  '    relations:',
  '      book: { type: belongsTo, table: books, foreignKey: book_id }',
  '    outputFile: reviews.md',
  '  tags:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      label: { type: text }',
  '      deleted_at: { type: text }',
  '    outputFile: tags.md',
  '  book_tags:',
  '    fields:',
  '      book_id: { type: uuid }',
  '      tag_id: { type: uuid }',
  '    relations:',
  '      book: { type: belongsTo, table: books, foreignKey: book_id }',
  '      tag: { type: belongsTo, table: tags, foreignKey: tag_id }',
  '    outputFile: book_tags.md',
  '',
].join('\n');

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui({ yaml: REL_YAML });
});
test.afterEach(async () => {
  await gui.close();
});

/** Seed an author → book → review chain. Returns the created ids. */
async function seedChain(base: string): Promise<{ authorId: string; bookId: string }> {
  const author = await createRow(base, 'authors', { name: 'Jane Author', bio: 'A novelist.' });
  const authorId = String(author.id);
  const book = await createRow(base, 'books', {
    title: 'Tidewater',
    summary: '# Tidewater\n\nA debut novel.',
    author_id: authorId,
  });
  const bookId = String(book.id);
  await createRow(base, 'reviews', { body: 'Luminous.', book_id: bookId });
  return { authorId, bookId };
}

test('object pages paginate: Prev/Next + "A–B of T", and Next loads the next window', async ({
  page,
}) => {
  // PAGE_SIZE is 100; seed 101 tags so the object page spans two pages. Sequential
  // batches keep the single-writer DB calm without being slow.
  for (let b = 0; b < 101; b += 20) {
    await Promise.all(
      Array.from({ length: Math.min(20, 101 - b) }, (_, i) =>
        createRow(gui.url, 'tags', { label: 'tag-' + String(b + i).padStart(3, '0') }),
      ),
    );
  }

  await page.goto(`${gui.url}#/w/table/tags`);
  await expect(page.locator('.fs-rows-table')).toBeVisible({ timeout: 5000 });

  // Page 1: 100 rows, "1–100 of 101", Prev disabled, Next enabled.
  await expect(page.locator('.rows-pager-info')).toContainText('1–100 of 101');
  await expect(page.locator('.fs-rows-table tbody tr')).toHaveCount(100);
  await expect(page.locator('.rows-prev')).toBeDisabled();
  await expect(page.locator('.rows-next')).toBeEnabled();

  // Next → page 2: the remaining row, "101–101 of 101", Next disabled.
  await page.locator('.rows-next').click();
  await expect(page.locator('.rows-pager-info')).toContainText('101–101 of 101');
  await expect(page.locator('.fs-rows-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.rows-next')).toBeDisabled();
  await expect(page.locator('.rows-prev')).toBeEnabled();

  // The whole row still opens the record (pagination didn't break row-click).
  await page.locator('.fs-rows-table tbody tr').first().click();
  await expect(page).toHaveURL(/#\/w\/table\/tags\/[^/]+$/);
});

test('the sidebar opens a table workspace; the collection lists rows; a row opens its detail', async ({
  page,
}) => {
  const author = (await createRow(gui.url, 'authors', {
    name: 'Jane Author',
    bio: 'A novelist.',
  })) as { id: string };
  await page.goto(gui.url + '#/');
  await expect(page.locator('nav.dash-sidebar')).toBeVisible();

  // The single-layout sidebar Tables section carries a nav item per table; clicking
  // one opens that table's Workspace tab (#/w/table/<name>) — the replacement for
  // the old two-view Objects-nav link that pointed at #/fs/….
  const navItem = page.locator('.nav-table-item[data-table="authors"]');
  await expect(navItem).toBeVisible({ timeout: 5000 });
  await navItem.click();
  await expect(page).toHaveURL(/#\/w\/table\/authors$/);

  // The table's Workspace tab is the rows collection (mirroring the Files file list).
  await expect(page.locator('.fs-rows-table')).toBeVisible({ timeout: 5000 });

  // Opening the row directly shows its detail (the record view header carries the name).
  await page.goto(`${gui.url}#/w/table/authors/${author.id}`);
  await expect(page.locator('.view-header')).toContainText('Jane Author', { timeout: 5000 });
});

test('drilling a row shows the record view, relationship sub-folders, and a breadcrumb', async ({
  page,
}) => {
  const { authorId } = await seedChain(gui.url);

  // Author item view: the record header + a "Books" sub-folder.
  await page.goto(`${gui.url}#/w/table/authors/${authorId}`);
  await expect(page.locator('.view-header')).toContainText('Jane Author');
  const booksFolder = page.locator('.fs-folder', { hasText: 'Books' });
  await expect(booksFolder).toBeVisible();
  await booksFolder.click();

  // Books collection (filtered to this author) → a rows table; open the book.
  await expect(page).toHaveURL(new RegExp(`#/w/table/authors/${authorId}/books$`));
  const bookLink = page.locator('.fs-rows-table a', { hasText: 'Tidewater' });
  await expect(bookLink).toBeVisible();
  await bookLink.click();

  // Book item view: "Connected objects" lists only relations with rows — the
  // Reviews (1:N) folder shows (a review exists); the empty Tags (M:N) relation
  // is hidden entirely (count-0 tiles are removed, not shown as "0 items").
  await expect(page.locator('.fs-folder', { hasText: 'Reviews' })).toBeVisible();
  await expect(page.locator('.fs-folder', { hasText: 'Tags' })).toHaveCount(0);

  // Breadcrumb reflects the full clickable drill path. In the single layout a
  // Workspace table tab (#/w/table/*) has no top-level Objects index, so the crumb
  // roots directly at the object (Authors ▸ record ▸ relation ▸ …).
  const crumbs = page.locator('.fs-crumbs');
  await expect(crumbs).toContainText('Authors');
  await expect(crumbs).toContainText('Jane Author');
  await expect(crumbs).toContainText('Books');
  await expect(crumbs).toContainText('Tidewater');

  // Drill one level deeper into Reviews to prove unbounded nesting.
  await page.locator('.fs-folder', { hasText: 'Reviews' }).click();
  await expect(page.locator('.fs-rows-table', { hasText: 'Luminous.' })).toBeVisible();
});

test('a record exposes "View Markdown"/"View Formatted" in the ⋯ menu and switches views', async ({
  page,
}) => {
  // The 5.0 record view has a Formatted (rendered markdown) default and an editable
  // raw Markdown view that writes back via PUT …/context — reached via the ⋯ menu's
  // "View Markdown" (which then reads "View Formatted"). The markdown write-back
  // itself is covered at the API level by tests/integration/gui-row-context-writeback.
  const { authorId } = await seedChain(gui.url);
  await page.goto(`${gui.url}#/w/table/authors/${authorId}`);
  await expect(page.locator('.view-header')).toContainText('Jane Author');
  // No standalone toggle anymore.
  await expect(page.locator('.fs-view-toggle')).toHaveCount(0);

  // Open the ⋯ menu → "View Markdown" → the raw markdown context pane shows and the
  // item flips to "View Formatted" (the menu label is the source of truth for the mode).
  const menuBtn = page.locator('#file-menu-btn');
  await menuBtn.click();
  const mdItem = page.locator('#file-menu [data-act="markdown"]');
  await expect(mdItem).toHaveText('View Markdown');
  await mdItem.click();
  await expect(page.locator('#fs-context')).toBeVisible();
  await menuBtn.click();
  await expect(page.locator('#file-menu [data-act="markdown"]')).toHaveText('View Formatted');

  // …and back to Formatted (the item flips back).
  await page.locator('#file-menu [data-act="markdown"]').click();
  await menuBtn.click();
  await expect(page.locator('#file-menu [data-act="markdown"]')).toHaveText('View Markdown');
});

test('object navigation always targets the workspace (single view)', async ({ page }) => {
  await createRow(gui.url, 'authors', { name: 'Jane Author' });
  // There is a single view — the Workspace. Sidebar table nav opens the one
  // #/w/table/… surface; the former two-view "Advanced View" toggle + classic
  // #/objects editor were removed, and Configure → Lattice no longer carries a
  // view toggle.
  await page.goto(`${gui.url}#/`);
  await expect(page.locator('nav.dash-sidebar')).toBeVisible();

  const navItem = page.locator('.nav-table-item[data-table="authors"]');
  await expect(navItem).toBeVisible({ timeout: 5000 });
  await navItem.click();
  await expect(page).toHaveURL(/#\/w\/table\/authors$/);

  await page.locator('#configure-trigger').click();
  await page.locator('.drawer-tab[data-tab="lattice"]').click();
  await expect(page.locator('#settings-drawer')).toContainText('Lattice Settings');
  await expect(page.locator('#advanced-toggle')).toHaveCount(0);
});

test('the gear opens a settings drawer with Database / Lattice / User tabs', async ({ page }) => {
  await page.goto(gui.url);
  await page.locator('#configure-trigger').click();

  const drawer = page.locator('#settings-drawer');
  await expect(drawer).toHaveClass(/open/);
  // Defaults to the User tab.
  await expect(drawer).toContainText('User Settings');

  await page.locator('.drawer-tab[data-tab="database"]').click();
  await expect(drawer).toContainText('Workspace Settings');

  await page.locator('.drawer-tab[data-tab="lattice"]').click();
  await expect(drawer).toContainText('Lattice Settings');

  // Escape closes it.
  await page.keyboard.press('Escape');
  await expect(drawer).not.toHaveClass(/open/);
});

test('Version history + Settings are full-panel takeovers with highlighted, toggling triggers', async ({
  page,
}) => {
  await page.goto(gui.url + '#/');
  await expect(page.locator('nav.dash-sidebar')).toBeVisible();

  // Clock opens Version history as its OWN takeover, highlighted. Version
  // history is NOT a Settings sub-tab, so the Settings tab row is hidden and
  // the title reads "Version history".
  await page.locator('#history-link').click();
  const drawer = page.locator('#settings-drawer');
  await expect(drawer).toBeVisible();
  await expect(page.locator('#settings-drawer .drawer-title')).toHaveText('Version history');
  await expect(page.locator('#drawer-tabs')).toBeHidden();
  await expect(page.locator('#history-link')).toHaveClass(/on/);
  // The panel spans the workspace below the header (full-bleed left+right).
  const box = await drawer.boundingBox();
  const vw = await page.evaluate(() => window.innerWidth);
  expect(box?.width).toBeGreaterThan(vw - 4);
  // Clicking the clock again collapses.
  await page.locator('#history-link').click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('#history-link')).not.toHaveClass(/on/);

  // The wrench uses the same takeover chrome for Configure: the tab row shows, the
  // title reads "Configure", the wrench highlights.
  await page.locator('#configure-trigger').click();
  await expect(drawer).toBeVisible();
  // The `on` highlight is a standalone class token — match it with word boundaries
  // so it isn't confused with the "on" substring inside "c-on-figure-trigger".
  await expect(page.locator('#configure-trigger')).toHaveClass(/\bon\b/);
  await expect(page.locator('#settings-drawer .drawer-title')).toHaveText('Configure');
  await expect(page.locator('#drawer-tabs')).toBeVisible();
  // Switching to the clock swaps the content in place (still one panel): the
  // Settings tab row disappears and the clock takes the highlight.
  await page.locator('#history-link').click();
  await expect(page.locator('#drawer-tabs')).toBeHidden();
  await expect(page.locator('#settings-drawer .drawer-title')).toHaveText('Version history');
  await expect(page.locator('#history-link')).toHaveClass(/on/);
  await expect(page.locator('#configure-trigger')).not.toHaveClass(/\bon\b/);
  await page.locator('#history-link').click();
  await expect(drawer).toBeHidden();
});
