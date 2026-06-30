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

  await page.goto(`${gui.url}#/fs/tags`);
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
  await expect(page).toHaveURL(/#\/fs\/tags\/[^/]+$/);
});

test('an object page shows its data provenance; a row opens its detail', async ({ page }) => {
  const author = (await createRow(gui.url, 'authors', {
    name: 'Jane Author',
    bio: 'A novelist.',
  })) as { id: string };
  await page.goto(gui.url);
  await expect(page.locator('nav.sidebar')).toBeVisible();

  // Default mode: the sidebar object link points at the file-system route.
  const navLink = page.locator('#object-nav a').first();
  await expect(navLink).toHaveAttribute('href', /#\/fs\//);

  await page.goto(`${gui.url}#/fs/authors`);
  // The object page is the table's rows (mirroring the Files file list).
  await expect(page.locator('.fs-rows-table')).toBeVisible({ timeout: 5000 });

  // Opening the row directly shows its detail (the record view header carries the name).
  await page.goto(`${gui.url}#/fs/authors/${author.id}`);
  await expect(page.locator('.view-header')).toContainText('Jane Author', { timeout: 5000 });
});

test('drilling a row shows the record view, relationship sub-folders, and a breadcrumb', async ({
  page,
}) => {
  const { authorId } = await seedChain(gui.url);

  // Author item view: the record header + a "Books" sub-folder.
  await page.goto(`${gui.url}#/fs/authors/${authorId}`);
  await expect(page.locator('.view-header')).toContainText('Jane Author');
  const booksFolder = page.locator('.fs-folder', { hasText: 'Books' });
  await expect(booksFolder).toBeVisible();
  await booksFolder.click();

  // Books collection (filtered to this author) → a rows table; open the book.
  await expect(page).toHaveURL(new RegExp(`#/fs/authors/${authorId}/books$`));
  const bookLink = page.locator('.fs-rows-table a', { hasText: 'Tidewater' });
  await expect(bookLink).toBeVisible();
  await bookLink.click();

  // Book item view: a Reviews (1:N) folder AND a Tags (M:N) folder.
  await expect(page.locator('.fs-folder', { hasText: 'Reviews' })).toBeVisible();
  await expect(page.locator('.fs-folder', { hasText: 'Tags' })).toBeVisible();

  // Breadcrumb reflects the full clickable drill path, rooted at Tables.
  const crumbs = page.locator('.fs-crumbs');
  await expect(crumbs).toContainText('Tables');
  await expect(crumbs).toContainText('Authors');
  await expect(crumbs).toContainText('Jane Author');
  await expect(crumbs).toContainText('Books');
  await expect(crumbs).toContainText('Tidewater');

  // Drill one level deeper into Reviews to prove unbounded nesting.
  await page.locator('.fs-folder', { hasText: 'Reviews' }).click();
  await expect(page.locator('.fs-rows-table', { hasText: 'Luminous.' })).toBeVisible();
});

test('a record renders the Formatted | Markdown toggle and switches between the views', async ({
  page,
}) => {
  // The 5.0 record view replaced the column-by-column field editor (and its inline
  // click-to-edit) with a Formatted (rendered markdown) | Markdown (editable raw
  // markdown that writes back via PUT …/context) toggle. The markdown write-back
  // itself is covered at the API level by tests/integration/gui-row-context-writeback.
  const { authorId } = await seedChain(gui.url);
  await page.goto(`${gui.url}#/fs/authors/${authorId}`);

  // The record header carries the name; the Formatted | Markdown toggle is present
  // with Formatted active by default.
  await expect(page.locator('.view-header')).toContainText('Jane Author');
  const toggle = page.locator('.fs-view-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle.locator('[data-fsview="formatted"]')).toHaveClass('on');

  // Switch to the editable Markdown view…
  await toggle.locator('[data-fsview="markdown"]').click();
  await expect(toggle.locator('[data-fsview="markdown"]')).toHaveClass('on');
  await expect(page.locator('#fs-context')).toBeVisible();

  // …and back to Formatted.
  await toggle.locator('[data-fsview="formatted"]').click();
  await expect(toggle.locator('[data-fsview="formatted"]')).toHaveClass('on');
});

test('Advanced mode toggle restores the classic row/table editor', async ({ page }) => {
  await createRow(gui.url, 'authors', { name: 'Jane Author' });
  // The dashboard (now reached via its own route; the graph is the default view)
  // lists cards that point at the file-system route in default mode.
  await page.goto(`${gui.url}#/dashboard`);
  const card = page.locator('.card').first();
  await expect(card).toHaveAttribute('href', /#\/fs\//);

  // Advanced View now lives in Settings → Lattice (moved out of the sidebar).
  // Open the gear → Lattice tab, then click the toggle track the way a user would.
  await page.locator('#settings-gear').click();
  await page.locator('.drawer-tab[data-tab="lattice"]').click();
  await page.locator('#drawer-body .toggle-track').click();
  await expect(page.locator('#advanced-toggle')).toBeChecked();
  await page.keyboard.press('Escape'); // close the drawer to reach the sidebar

  // Object navigation now targets the classic #/objects route …
  await expect(page.locator('#object-nav a').first()).toHaveAttribute('href', /#\/objects\//);
  // … which renders the row table with its inline create row. Scope to the main
  // content region: the settings drawer we just opened retains its rendered
  // Lattice panel (which has its own workspace-list <table>), so an unscoped
  // `table` locator is ambiguous after a hash-only navigation.
  await page.goto(`${gui.url}#/objects/authors`);
  await expect(page.locator('#content table')).toBeVisible();
  await expect(page.locator('#content tr.create-row')).toBeVisible();
});

test('the gear opens a settings drawer with Database / Lattice / User tabs', async ({ page }) => {
  await page.goto(gui.url);
  await page.locator('#settings-gear').click();

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
