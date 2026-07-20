import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * 1.16.1 GUI fixes (from the 1.16.0 demo):
 *  A — redo gate counts must be session-scoped (matching the session-scoped
 *      undo/redo actions), so undone entries from a PRIOR server process don't
 *      light up ↷ for a session that has nothing to redo.
 *  B — column rename/add must refuse built-in entities (notes/files/secrets,
 *      which aren't in the config `entities:` map) BEFORE touching SQL, and
 *      refuse duplicate target names — no physical/config drift.
 *  C/D/G — the served bundle no longer ships the "Connect to existing cloud"
 *      button or the Activity rail, and the "+ New workspace…" handler stops
 *      propagation so opening the create input doesn't close the menu.
 *  F — a write that should change a row but leaves it byte-identical surfaces
 *      loudly (covered by integration: a real edit + a same-value edit both
 *      succeed without a false positive; the throw path is unit-tested).
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface HistoryResp {
  entries: { id: string; operation: string; undone: number }[];
  canUndo: boolean;
  canRedo: boolean;
}

const j = (r: Response) => r.json();
const post = (s: GuiServerHandle, path: string, body?: unknown) =>
  fetch(`${s.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const patch = (s: GuiServerHandle, path: string, body: unknown) =>
  fetch(`${s.url}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

function makeRoot(): { configPath: string; outputDir: string; dbFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-1161-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  tasks:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      status: { type: text }',
      '    outputFile: tasks.md',
      '',
    ].join('\n'),
  );
  return { configPath, outputDir: join(root, 'context'), dbFile: join(root, 'data', 'test.db') };
}

async function boot(reuse?: { configPath: string; outputDir: string }) {
  const r = reuse ?? makeRoot();
  const s = await startGuiServer({
    configPath: r.configPath,
    outputDir: r.outputDir,
    port: 0,
    openBrowser: false,
  });
  servers.push(s);
  return { s, ...('dbFile' in r ? (r as ReturnType<typeof makeRoot>) : r) };
}
async function history(s: GuiServerHandle): Promise<HistoryResp> {
  return (await j(await fetch(`${s.url}/api/history?limit=200`))) as HistoryResp;
}
async function seedTask(s: GuiServerHandle, title: string, status: string): Promise<string> {
  const r = await post(s, '/api/tables/tasks/rows', { title, status });
  expect(r.status).toBe(201);
  const body = (await r.json()) as { id?: string; row?: { id?: string } };
  return (body.id ?? body.row?.id)!;
}

describe('1.16.1 — A: undo/redo gate counts are session-scoped', () => {
  it('does not enable redo/undo for a fresh session from another session’s entries', async () => {
    const root = makeRoot();
    // Session 1: insert, edit, undo the edit → S1 has an undone entry + a live one.
    const { s: s1 } = await boot(root);
    const id = await seedTask(s1, 'x', 'todo');
    expect((await patch(s1, `/api/tables/tasks/rows/${id}`, { status: 'done' })).status).toBe(200);
    expect((await post(s1, '/api/history/undo')).status).toBe(200);
    expect((await history(s1)).canRedo).toBe(true); // S1 can redo its own undo
    await s1.close();
    servers.splice(servers.indexOf(s1), 1);

    // Session 2: a NEW server process (new session id) on the SAME db. The
    // undone + live rows belong to S1, so S2's stack gates must be OFF.
    const { s: s2 } = await boot({ configPath: root.configPath, outputDir: root.outputDir });
    const h2 = await history(s2);
    expect(h2.entries.length).toBeGreaterThan(0); // history list stays global
    expect(h2.canRedo).toBe(false); // FIX: pre-fix this was true (global count)
    expect(h2.canUndo).toBe(false); // FIX: pre-fix this was true (global count)
  });
});

describe('1.16.1 — B: column editor guards built-ins, ordering, and dup names', () => {
  it('refuses to rename a column on a built-in table without mutating the physical schema', async () => {
    const { s, dbFile } = await boot();
    const r = await post(s, '/api/schema/entities/notes/columns/body/rename', { to: 'body2' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/built-in/i);
    // No drift: the physical `notes` table still has `body`, not `body2`.
    const db = new Database(dbFile, { readonly: true });
    const cols = (db.prepare('PRAGMA table_info(notes)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    db.close();
    expect(cols).toContain('body');
    expect(cols).not.toContain('body2');
  });

  it('refuses to add a column to a built-in table', async () => {
    const { s } = await boot();
    const r = await post(s, '/api/schema/entities/notes/columns', { name: 'extra', type: 'text' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/built-in/i);
  });

  it('refuses a rename whose target column already exists', async () => {
    const { s } = await boot();
    const r = await post(s, '/api/schema/entities/tasks/columns/title/rename', { to: 'status' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/already exists/i);
  });

  it('refuses adding a column whose name already exists', async () => {
    const { s } = await boot();
    const r = await post(s, '/api/schema/entities/tasks/columns', { name: 'title', type: 'text' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/already exists/i);
  });

  it('still renames a normal user-table column successfully', async () => {
    const { s } = await boot();
    expect(
      (await post(s, '/api/schema/entities/tasks/columns/status/rename', { to: 'state' })).status,
    ).toBe(200);
    const ops = (await history(s)).entries.map((e) => e.operation);
    expect(ops).toContain('schema.rename_column');
  });
});

describe('1.16.1 — F: writes that should change a row but do not surface loudly', () => {
  it('a real edit and a same-value edit both succeed (no false positive)', async () => {
    const { s } = await boot();
    const id = await seedTask(s, 'x', 'todo');
    expect((await patch(s, `/api/tables/tasks/rows/${id}`, { status: 'done' })).status).toBe(200);
    // Same-value PATCH must NOT trip the write-landed guard.
    expect((await patch(s, `/api/tables/tasks/rows/${id}`, { status: 'done' })).status).toBe(200);
  });
});

describe('1.16.1 — C/D/G: served bundle no longer ships removed UI; create handler is guarded', () => {
  it('omits the "Connect to existing cloud" button; 5.0 ships the floating Ask Lattice assistant', async () => {
    const { s } = await boot();
    const html = await (await fetch(`${s.url}/`)).text();
    expect(html).not.toContain('open-connect-existing'); // C
    // D (revised for 5.0): the AI assistant moved from a docked rail to a floating
    // "Ask Lattice" panel; the chat feed element is reused inside it.
    expect(html).toContain('ask-lattice-panel');
    expect(html).toContain('rail-feed');
  });

  it('the "+ New workspace…" button opens the create/join wizard (1.16.4 single switcher)', async () => {
    const { s } = await boot();
    const html = await (await fetch(`${s.url}/`)).text();
    // 1.16.4: one workspace switcher; its create button opens the 3-step
    // wizard (local / cloud / join), replacing the old inline local-only form.
    expect(html).toContain('showCreateDatabaseWizard();');
    expect(html).not.toContain('function showCreateWorkspaceInput');
    // The legacy second (database) switcher host is gone.
    expect(html).not.toContain('id="db-switcher-host"');
    expect(html).not.toContain('function renderDbSwitcher');
  });
});
