import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * Postgres-gated sibling of gui-schema-history: proves the soft-delete history
 * + revert model is adapter-portable. Run-unique table names isolate against
 * the shared CI/dev database.
 *
 *   docker run -d -e POSTGRES_USER=lattice -e POSTGRES_PASSWORD=lattice \
 *     -e POSTGRES_DB=lattice_test -p 5432:5432 postgres:16
 *   LATTICE_TEST_PG_URL=postgres://lattice:lattice@localhost:5432/lattice_test npx vitest run
 */

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<{ s: GuiServerHandle; tasks: string }> {
  const runId = randomBytes(4).toString('hex');
  const tasks = `tasks_${runId}`;
  const root = mkdtempSync(join(tmpdir(), `lattice-schist-pg-${runId}-`));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      `db: ${PG_URL!}`,
      '',
      'entities:',
      `  ${tasks}:`,
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      status: { type: text }',
      `    outputFile: ${tasks}.md`,
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
  return { s, tasks };
}

const post = (s: GuiServerHandle, path: string, body?: unknown) =>
  fetch(`${s.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const del = (s: GuiServerHandle, path: string) => fetch(`${s.url}${path}`, { method: 'DELETE' });

async function entityNames(s: GuiServerHandle): Promise<string[]> {
  const e = (await (await fetch(`${s.url}/api/entities`)).json()) as { tables: { name: string }[] };
  return e.tables.map((t) => t.name);
}

describe.skipIf(!PG_URL)('Schema history (Postgres) — soft-delete + revert', () => {
  it('soft-deletes a table and revert restores its rows (no physical drop)', async () => {
    const { s, tasks } = await boot();
    const seed = await post(s, `/api/tables/${tasks}/rows`, { title: 'Keep me', status: 'todo' });
    expect(seed.status).toBe(201);

    expect((await del(s, `/api/schema/entities/${tasks}`)).status).toBe(200);
    expect(await entityNames(s)).not.toContain(tasks);

    // The shared CI/dev Postgres means every PG test server writes to the same
    // _lattice_gui_audit — so filter by this run's unique table_name to find
    // THIS test's delete entry (not another test's).
    const hist = (await (await fetch(`${s.url}/api/history?limit=200`)).json()) as {
      entries: { id: string; operation: string; table_name: string }[];
    };
    const entry = hist.entries.find(
      (e) => e.operation === 'schema.delete_entity' && e.table_name === tasks,
    );
    expect(entry).toBeTruthy();

    expect((await post(s, `/api/history/revert/${entry!.id}`)).status).toBe(200);
    expect(await entityNames(s)).toContain(tasks);
    const rows = (await (await fetch(`${s.url}/api/tables/${tasks}/rows`)).json()) as {
      rows: { title: string }[];
    };
    expect(rows.rows.map((r) => r.title)).toEqual(['Keep me']);
  });

  // NOTE: undo/redo operate on the GLOBAL latest audit entry. In production one
  // Postgres database is one workspace (one audit log), so that's correct; but
  // the CI/dev Postgres is shared across every test server here, so a global
  // undo can target another test's entry. Undo/redo is adapter-agnostic config
  // logic (same applySchemaConfig path as revert), covered by the isolated
  // SQLite suite — the PG sibling proves the cross-adapter soft-delete + revert
  // + purge below.

  it('purge physically drops a soft-deleted table; then its revert is refused', async () => {
    const { s, tasks } = await boot();
    expect((await del(s, `/api/schema/entities/${tasks}`)).status).toBe(200);
    expect((await post(s, '/api/schema/purge', { type: 'table', name: tasks })).status).toBe(200);

    const hist = (await (await fetch(`${s.url}/api/history?limit=200`)).json()) as {
      entries: { id: string; operation: string; table_name: string }[];
    };
    const del0 = hist.entries.find(
      (e) => e.operation === 'schema.delete_entity' && e.table_name === tasks,
    );
    expect((await post(s, `/api/history/revert/${del0!.id}`)).status).toBe(400); // purged
  });
});
