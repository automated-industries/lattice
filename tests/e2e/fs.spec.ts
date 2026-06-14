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
  '      author_id: { type: uuid, ref: authors }',
  '      deleted_at: { type: text }',
  '    outputFile: books.md',
  '  reviews:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      body: { type: text }',
  '      book_id: { type: uuid, ref: books }',
  '      deleted_at: { type: text }',
  '    outputFile: reviews.md',
  '  tags:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      label: { type: text }',
  '      deleted_at: { type: text }',
  '    outputFile: tags.md',
  '  book_tags:',
  '    fields:',
  '      book_id: { type: uuid, ref: books }',
  '      tag_id: { type: uuid, ref: tags }',
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

test('clicking an object shows its rows as a folder grid', async ({ page }) => {
  await createRow(gui.url, 'authors', { name: 'Jane Author', bio: 'A novelist.' });
  await page.goto(gui.url);
  await expect(page.locator('nav.sidebar')).toBeVisible();

  // Default mode: the sidebar object link points at the file-system route.
  const navLink = page.locator('#object-nav a').first();
  await expect(navLink).toHaveAttribute('href', /#\/fs\//);

  await page.goto(`${gui.url}#/fs/authors`);
  // Data tiles only — exclude the 1.16.2 "New" create tile (also a .fs-tile).
  const tile = page.locator('.fs-tile:not(.fs-tile-create)');
  await expect(tile).toHaveCount(1);
  await expect(tile.first()).toContainText('Jane Author');
});

test('drilling a row shows a column-built preview, relationship sub-folders, and a breadcrumb', async ({
  page,
}) => {
  const { authorId } = await seedChain(gui.url);

  // Author item view: preview + a "Books" sub-folder.
  await page.goto(`${gui.url}#/fs/authors/${authorId}`);
  await expect(page.locator('.fs-doc')).toContainText('Jane Author');
  const booksFolder = page.locator('.fs-folder', { hasText: 'Books' });
  await expect(booksFolder).toBeVisible();
  await booksFolder.click();

  // Books collection (filtered to this author) → open the book.
  await expect(page).toHaveURL(new RegExp(`#/fs/authors/${authorId}/books$`));
  const bookTile = page.locator('.fs-tile', { hasText: 'Tidewater' });
  await expect(bookTile).toBeVisible();
  await bookTile.click();

  // Book item view: a Reviews (1:N) folder AND a Tags (M:N) folder.
  await expect(page.locator('.fs-folder', { hasText: 'Reviews' })).toBeVisible();
  await expect(page.locator('.fs-folder', { hasText: 'Tags' })).toBeVisible();

  // Breadcrumb reflects the full clickable drill path.
  const crumbs = page.locator('.fs-crumbs');
  await expect(crumbs).toContainText('Home');
  await expect(crumbs).toContainText('Authors');
  await expect(crumbs).toContainText('Jane Author');
  await expect(crumbs).toContainText('Books');
  await expect(crumbs).toContainText('Tidewater');

  // Drill one level deeper into Reviews to prove unbounded nesting.
  await page.locator('.fs-folder', { hasText: 'Reviews' }).click();
  await expect(page.locator('.fs-tile', { hasText: 'Luminous.' })).toBeVisible();
});

test('click-to-edit a value persists via PATCH', async ({ page }) => {
  const { authorId } = await seedChain(gui.url);
  await page.goto(`${gui.url}#/fs/authors/${authorId}`);

  const nameCell = page.locator('.fs-field-val.ce[data-col="name"]');
  await expect(nameCell).toContainText('Jane Author');
  await nameCell.click();
  const input = nameCell.locator('input');
  await expect(input).toBeVisible();
  await input.fill('Jane Q. Author');
  await input.press('Enter');

  // The cell repaints with the new value …
  await expect(nameCell).toContainText('Jane Q. Author');
  // … and the change is actually persisted server-side.
  const res = await page.request.get(`${gui.url}/api/tables/authors/rows/${authorId}`);
  expect(res.ok()).toBeTruthy();
  const row = (await res.json()) as { name: string };
  expect(row.name).toBe('Jane Q. Author');
});

test('a long-form field edits as a textarea and round-trips newlines losslessly (1.16.3 B)', async ({
  page,
}) => {
  // `bio` is a long-form field that was NOT in the old hardcoded
  // {body,summary,transcript} textarea set, so it used to open a single-line
  // <input>. Focusing that input stripped the newlines, so a click+blur with
  // no real edit fired a spurious PATCH that mangled the value (rendered as
  // "huge text"). The fix: every FS_LONGFORM field opens a <textarea>.
  const MULTILINE_BIO = 'Line one.\n\n## A heading\n\nLine two with **bold**.';
  const author = await createRow(gui.url, 'authors', { name: 'Multi Line', bio: MULTILINE_BIO });
  const authorId = String(author.id);
  await page.goto(`${gui.url}#/fs/authors/${authorId}`);

  const bioCell = page.locator('.fs-field-val.ce[data-col="bio"]');
  await expect(bioCell).toBeVisible();

  // Opens a <textarea>, never a single-line <input>.
  await bioCell.click();
  await expect(bioCell.locator('textarea')).toBeVisible();
  await expect(bioCell.locator('input')).toHaveCount(0);

  // No-op blur (no edit) must NOT change the stored value — the heart of the bug.
  await bioCell.locator('textarea').blur();
  let res = await page.request.get(`${gui.url}/api/tables/authors/rows/${authorId}`);
  expect(((await res.json()) as { bio: string }).bio).toBe(MULTILINE_BIO);

  // A real edit round-trips with all newlines preserved (committed via blur —
  // plain Enter inserts a newline in a textarea rather than committing).
  const EDITED = MULTILINE_BIO + '\n\nAppended paragraph.';
  await bioCell.click();
  await bioCell.locator('textarea').fill(EDITED);
  await bioCell.locator('textarea').blur();
  res = await page.request.get(`${gui.url}/api/tables/authors/rows/${authorId}`);
  expect(((await res.json()) as { bio: string }).bio).toBe(EDITED);
});

test('Advanced mode toggle restores the classic row/table editor', async ({ page }) => {
  await createRow(gui.url, 'authors', { name: 'Jane Author' });
  await page.goto(gui.url);

  // Default: dashboard cards point at the file-system route.
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
  // … which renders the row table with its inline create row.
  await page.goto(`${gui.url}#/objects/authors`);
  await expect(page.locator('table')).toBeVisible();
  await expect(page.locator('tr.create-row')).toBeVisible();
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

test('the simple-view create tile opens an inline form that makes a new object with a many-to-many link', async ({
  page,
}) => {
  await createRow(gui.url, 'authors', { name: 'Jane Author', bio: 'A novelist.' });
  await createRow(gui.url, 'tags', { label: 'fiction' });

  await page.goto(gui.url);
  await page.evaluate(() => {
    window.location.hash = '#/fs/books';
  });

  // The "New" create tile navigates to an INLINE create form (no modal),
  // styled like the item page (#/fs/books/new).
  await page.locator('.fs-tile-create').click();
  const form = page.locator('.fs-create-form');
  await expect(form).toBeVisible();
  await expect(page.locator('.modal')).toHaveCount(0);
  await form.locator('input[name="title"]').fill('Tidewater');
  // belongsTo author + a many-to-many tag link (select by index — `tags` have
  // no name/title so the option text is the id; index 1 is the first real row).
  await form.locator('select[name="author_id"]').selectOption({ index: 1 });
  await form.locator('.fs-link-select').first().selectOption({ index: 1 });
  await page.locator('#fs-create-save').click();

  // Lands on the new object's page…
  await expect(page.locator('.view-header h1').filter({ hasText: 'Tidewater' })).toBeVisible();
  // …and the M:N junction row was created from the staged link.
  const res = await page.request.get(gui.url + '/api/tables/book_tags/rows');
  const body = (await res.json()) as { rows: unknown[] };
  expect(body.rows.length).toBe(1);
});
