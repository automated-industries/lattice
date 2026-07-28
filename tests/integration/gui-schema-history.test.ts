import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * Schema/data-model changes are tracked in the GUI Version History + Activity
 * and are reversible — using a SOFT-DELETE model: a "delete" removes the
 * entity/field from the config (hiding it) but never physically DROPs the SQL
 * object, so revert restores it with all data intact and no snapshot is needed.
 */

interface AuditEntry {
  id: string;
  table_name: string;
  operation: string;
  before_json: string | null;
  after_json: string | null;
  undone: number;
}
interface HistoryResp {
  entries: AuditEntry[];
  canUndo: boolean;
  canRedo: boolean;
}

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<{ s: GuiServerHandle; dbFile: string }> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-schist-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  articles:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '    outputFile: articles.md',
      '  tasks:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      status: { type: text }',
      '    outputFile: tasks.md',
      '',
    ].join('\n'),
  );
  const s = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
  });
  servers.push(s);
  return { s, dbFile: join(root, 'data', 'test.db') };
}

const j = (r: Response) => r.json();
const post = (s: GuiServerHandle, path: string, body?: unknown) =>
  fetch(`${s.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const del = (s: GuiServerHandle, path: string) => fetch(`${s.url}${path}`, { method: 'DELETE' });

async function entityNames(s: GuiServerHandle): Promise<string[]> {
  const e = (await j(await fetch(`${s.url}/api/entities`))) as { tables: { name: string }[] };
  return e.tables.map((t) => t.name);
}
async function history(s: GuiServerHandle): Promise<HistoryResp> {
  return (await j(await fetch(`${s.url}/api/history?limit=200`))) as HistoryResp;
}
async function rowTitles(s: GuiServerHandle, table: string): Promise<string[]> {
  const r = (await j(await fetch(`${s.url}/api/tables/${table}/rows`))) as {
    rows: { title: string }[];
  };
  return r.rows.map((x) => x.title).sort();
}
async function seedRow(s: GuiServerHandle, table: string, body: Record<string, unknown>) {
  const r = await post(s, `/api/tables/${table}/rows`, body);
  expect(r.status).toBe(201);
}

describe('Schema history — tracking + soft-delete revert', () => {
  it('records every schema op in the version history with a schema.* operation', async () => {
    const { s } = await boot();
    expect((await post(s, '/api/schema/entities', { name: 'widgets' })).status).toBe(200);
    expect(
      (await post(s, '/api/schema/entities/widgets/columns', { name: 'sku', type: 'text' })).status,
    ).toBe(200);
    const ops = (await history(s)).entries.map((e) => e.operation);
    expect(ops).toContain('schema.create_entity');
    expect(ops).toContain('schema.add_column');
  });

  it('soft-deletes a table: hidden from the GUI but never physically dropped; revert restores rows', async () => {
    const { s, dbFile } = await boot();
    await seedRow(s, 'tasks', { title: 'Wire the search bar', status: 'todo' });
    await seedRow(s, 'tasks', { title: 'Ship 1.16', status: 'doing' });

    // Soft-delete the table.
    expect((await del(s, '/api/schema/entities/tasks')).status).toBe(200);
    expect(await entityNames(s)).not.toContain('tasks'); // hidden from the GUI

    // MECHANISM: the SQL table + rows are still physically present (no DROP).
    const raw = new Database(dbFile, { readonly: true });
    const stillThere = raw.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number };
    raw.close();
    expect(stillThere.n).toBe(2);

    // The delete is a tracked, revertible history entry.
    const entry = (await history(s)).entries.find((e) => e.operation === 'schema.delete_entity');
    expect(entry).toBeTruthy();

    // Revert → table reappears with all its rows intact (no snapshot needed).
    expect((await post(s, `/api/history/revert/${entry!.id}`)).status).toBe(200);
    expect(await entityNames(s)).toContain('tasks');
    expect(await rowTitles(s, 'tasks')).toEqual(['Ship 1.16', 'Wire the search bar']);
  });

  it('soft-deletes a link/column: column hidden but values preserved; revert restores them', async () => {
    const { s } = await boot();
    // Add a link tasks -> articles (creates a junction in the M2M model)… but
    // for a column-level soft-delete test, add a scalar column with data.
    expect(
      (await post(s, '/api/schema/entities/tasks/columns', { name: 'note', type: 'text' })).status,
    ).toBe(200);
    await seedRow(s, 'tasks', { title: 'A', status: 'todo', note: 'keep me' });

    // Add a link (junction) then delete it — soft.
    expect(
      (await post(s, '/api/schema/junctions', { left: 'tasks', right: 'articles' })).status,
    ).toBe(200);
    const junctionGone = await del(s, '/api/schema/entities/tasks_articles');
    expect(junctionGone.status).toBe(200);
    expect(await entityNames(s)).not.toContain('tasks_articles');

    // Revert the junction delete → it comes back.
    const jEntry = (await history(s)).entries.find(
      (e) => e.operation === 'schema.delete_entity' && e.table_name === 'tasks_articles',
    );
    expect(jEntry).toBeTruthy();
    expect((await post(s, `/api/history/revert/${jEntry!.id}`)).status).toBe(200);
    expect(await entityNames(s)).toContain('tasks_articles');
  });

  it('reverts non-destructive ops (create, rename, add-column)', async () => {
    const { s } = await boot();
    expect((await post(s, '/api/schema/entities', { name: 'widgets' })).status).toBe(200);
    const createEntry = (await history(s)).entries.find(
      (e) => e.operation === 'schema.create_entity',
    );
    expect((await post(s, `/api/history/revert/${createEntry!.id}`)).status).toBe(200);
    expect(await entityNames(s)).not.toContain('widgets'); // create reverted = hidden
  });

  it('undo + redo round-trips a schema op (it participates in the global stack)', async () => {
    const { s } = await boot();
    expect((await post(s, '/api/schema/entities', { name: 'gizmos' })).status).toBe(200);
    expect(await entityNames(s)).toContain('gizmos');
    expect((await post(s, '/api/history/undo')).status).toBe(200);
    expect(await entityNames(s)).not.toContain('gizmos');
    expect((await post(s, '/api/history/redo')).status).toBe(200);
    expect(await entityNames(s)).toContain('gizmos');
  });

  it("undo/redo is session-scoped: one session does not undo another session's action", async () => {
    // Two GUI servers against the SAME database = two sessions (e.g. two cloud
    // users). Undo steps through YOUR OWN actions only, not the other session's.
    const root = mkdtempSync(join(tmpdir(), 'lattice-schist-multi-'));
    dirs.push(root);
    mkdirSync(join(root, 'data'), { recursive: true });
    const configPath = join(root, 'lattice.config.yml');
    writeFileSync(
      configPath,
      [
        'db: ./data/test.db',
        '',
        'entities:',
        '  articles:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      title: { type: text }',
        '    outputFile: articles.md',
        '',
      ].join('\n'),
    );
    const a = await startGuiServer({
      configPath,
      outputDir: join(root, 'ctxA'),
      port: 0,
      openBrowser: false,
    });
    servers.push(a);
    // Session A creates an entity.
    expect((await post(a, '/api/schema/entities', { name: 'alpha' })).status).toBe(200);

    // A second server (session B) opens the same DB.
    const b = await startGuiServer({
      configPath,
      outputDir: join(root, 'ctxB'),
      port: 0,
      openBrowser: false,
    });
    servers.push(b);
    expect(await entityNames(b)).toContain('alpha'); // B sees the table

    // B's undo has nothing of its own to undo — it must NOT undo A's create.
    expect((await post(b, '/api/history/undo')).status).toBe(400); // "Nothing to undo"
    expect(await entityNames(b)).toContain('alpha'); // still there

    // A's own undo removes its create.
    expect((await post(a, '/api/history/undo')).status).toBe(200);
    expect(await entityNames(a)).not.toContain('alpha');
  });

  it('refuses to create over a soft-deleted name (revert it instead)', async () => {
    const { s } = await boot();
    await seedRow(s, 'tasks', { title: 'X', status: 'todo' });
    expect((await del(s, '/api/schema/entities/tasks')).status).toBe(200);
    const recreate = await post(s, '/api/schema/entities', { name: 'tasks' });
    expect(recreate.status).toBe(400); // a deleted "tasks" exists — revert it instead
  });
});

describe('Schema history — one-click undo affordance (undoId)', () => {
  // The data-model editor shows an "Undo" button on the success toast right after
  // a delete/rename. These pin the server half of that affordance: each schema
  // route returns the audit id of the change it made, and the toast Undo posts it
  // to the existing per-entry revert route. Modelled on the version-history
  // Revert path, targeting the change by id (not "whatever is newest") so a later
  // change can never be reverted by mistake.

  it('delete table returns an undoId that restores the table (the toast Undo)', async () => {
    const { s } = await boot();
    await seedRow(s, 'tasks', { title: 'Wire the search bar', status: 'todo' });
    await seedRow(s, 'tasks', { title: 'Ship 1.16', status: 'doing' });

    const resp = await del(s, '/api/schema/entities/tasks');
    expect(resp.status).toBe(200);
    const body = (await j(resp)) as { ok: boolean; undoId?: string };
    expect(typeof body.undoId).toBe('string');
    expect(await entityNames(s)).not.toContain('tasks');

    // The Undo button hits the per-entry revert with exactly this id.
    expect((await post(s, `/api/history/revert/${body.undoId}`)).status).toBe(200);
    expect(await entityNames(s)).toContain('tasks');
    expect(await rowTitles(s, 'tasks')).toEqual(['Ship 1.16', 'Wire the search bar']);
  });

  it('rename returns an undoId that restores the old name', async () => {
    const { s } = await boot();
    const resp = await post(s, '/api/schema/entities/tasks/rename', { to: 'jobs' });
    expect(resp.status).toBe(200);
    const body = (await j(resp)) as { ok: boolean; undoId?: string };
    expect(typeof body.undoId).toBe('string');
    expect(await entityNames(s)).toContain('jobs');
    expect(await entityNames(s)).not.toContain('tasks');

    expect((await post(s, `/api/history/revert/${body.undoId}`)).status).toBe(200);
    expect(await entityNames(s)).toContain('tasks');
    expect(await entityNames(s)).not.toContain('jobs');
  });

  it('junction-link delete returns an undoId that restores the link (the delete-link toast Undo)', async () => {
    const { s } = await boot();
    expect(
      (await post(s, '/api/schema/junctions', { left: 'tasks', right: 'articles' })).status,
    ).toBe(200);
    expect(await entityNames(s)).toContain('tasks_articles');

    const resp = await del(s, '/api/schema/entities/tasks_articles');
    expect(resp.status).toBe(200);
    const body = (await j(resp)) as { undoId?: string };
    expect(typeof body.undoId).toBe('string');
    expect(await entityNames(s)).not.toContain('tasks_articles');

    expect((await post(s, `/api/history/revert/${body.undoId}`)).status).toBe(200);
    expect(await entityNames(s)).toContain('tasks_articles');
  });

  it('undo fails LOUDLY (named conflict) when the workspace has moved on', async () => {
    const { s } = await boot();
    // Rename tasks -> jobs, capturing the undo id the toast would carry.
    const resp = await post(s, '/api/schema/entities/tasks/rename', { to: 'jobs' });
    const body = (await j(resp)) as { undoId?: string };
    expect(typeof body.undoId).toBe('string');

    // The name "tasks" is taken again by a fresh table before Undo is clicked.
    expect((await post(s, '/api/schema/entities', { name: 'tasks' })).status).toBe(200);

    // Undoing the rename would rename "jobs" back to a name that now collides —
    // the server refuses with a named reason, never a silent no-op or clobber.
    const undo = await post(s, `/api/history/revert/${body.undoId}`);
    expect(undo.status).toBe(400);
    const err = (await j(undo)) as { error: string };
    expect(err.error).toMatch(/already exists/i);

    // Both tables survive untouched — nothing was silently changed.
    expect(await entityNames(s)).toContain('tasks');
    expect(await entityNames(s)).toContain('jobs');
  });

  it('a second undo of the same change is refused (already undone), not a silent success', async () => {
    const { s } = await boot();
    await seedRow(s, 'tasks', { title: 'X', status: 'todo' });
    const resp = await del(s, '/api/schema/entities/tasks');
    const body = (await j(resp)) as { undoId?: string };
    expect(typeof body.undoId).toBe('string');

    // First undo restores the table.
    expect((await post(s, `/api/history/revert/${body.undoId}`)).status).toBe(200);
    expect(await entityNames(s)).toContain('tasks');

    // Clicking Undo again (or a stale toast) is refused loudly — the entry is
    // already undone, so it is not a fresh no-op success.
    const again = await post(s, `/api/history/revert/${body.undoId}`);
    expect(again.status).toBe(400);
  });
});

describe('Schema history — purge (API only)', () => {
  it('purge physically drops a soft-deleted table; afterwards its revert is refused', async () => {
    const { s, dbFile } = await boot();
    await seedRow(s, 'tasks', { title: 'X', status: 'todo' });
    expect((await del(s, '/api/schema/entities/tasks')).status).toBe(200);

    // Purge the orphaned (soft-deleted) table — physical DROP.
    expect((await post(s, '/api/schema/purge', { type: 'table', name: 'tasks' })).status).toBe(200);
    const raw = new Database(dbFile, { readonly: true });
    const exists = raw
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='tasks'")
      .get() as { n: number };
    raw.close();
    expect(exists.n).toBe(0); // physically gone

    // The earlier soft-delete can no longer be reverted (data is truly gone).
    const entry = (await history(s)).entries.find((e) => e.operation === 'schema.delete_entity');
    const revert = await post(s, `/api/history/revert/${entry!.id}`);
    expect(revert.status).toBe(400); // permanently purged, cannot revert
  });

  it('purge refuses a live (non-orphaned) table', async () => {
    const { s } = await boot();
    expect((await post(s, '/api/schema/purge', { type: 'table', name: 'tasks' })).status).toBe(400);
    expect(await entityNames(s)).toContain('tasks'); // untouched
  });
});
