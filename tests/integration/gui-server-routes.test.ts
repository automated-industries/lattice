import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * Integration coverage for the SQLite-reachable GUI HTTP surface in
 * src/gui/server.ts — the read routes, full row CRUD + audit/undo/redo
 * history flow, and the database management routes (list / create / switch /
 * delete). These paths ship in the 1.14.x GUI and were lightly tested; this
 * suite exercises them end-to-end against an in-process SQLite server (no
 * Postgres, no 2.0 assistant surface), including the delete-database Rule 16
 * error branches.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-gui-routes-'));
  dirs.push(cfgDir);
  savedEnv.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
  savedEnv.LATTICE_ENCRYPTION_KEY = process.env.LATTICE_ENCRYPTION_KEY;
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'gui-routes-test-key';
});

afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedEnv.LATTICE_CONFIG_DIR === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedEnv.LATTICE_CONFIG_DIR;
  if (savedEnv.LATTICE_ENCRYPTION_KEY === undefined) delete process.env.LATTICE_ENCRYPTION_KEY;
  else process.env.LATTICE_ENCRYPTION_KEY = savedEnv.LATTICE_ENCRYPTION_KEY;
});

function writeConfig(dir: string, name: string, dbName: string): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    [
      `db: ./data/${dbName}.db`,
      `name: ${dbName}`,
      '',
      'entities:',
      '  items:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: items.md',
      '',
    ].join('\n'),
  );
  return p;
}

async function boot(configPath: string): Promise<GuiServerHandle> {
  const outputDir = join(resolve(configPath, '..'), 'context');
  mkdirSync(outputDir, { recursive: true });
  const handle = await startGuiServer({
    configPath,
    outputDir,
    port: 0,
    host: '127.0.0.1',
    openBrowser: false,
  });
  servers.push(handle);
  return handle;
}

type ApiResult = { status: number; body: Record<string, unknown> };
async function api(
  base: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON / empty */
  }
  return { status: res.status, body };
}

describe('GUI server — SQLite read routes', () => {
  it('serves project/entities/graph/system-tables/native-entities/gui-meta', async () => {
    const cfg = writeConfig(dirs[0]!, 'lattice.config.yml', 'main');
    const h = await boot(cfg);

    const project = await api(h.url, '/api/project');
    expect(project.status).toBe(200);

    const entities = await api(h.url, '/api/entities');
    expect(entities.status).toBe(200);
    expect(Array.isArray(entities.body.entities) || Array.isArray(entities.body.tables)).toBe(true);
    // User-facing native entities (files/notes/secrets) appear in the Objects
    // list, but the assistant's internal conversation storage must NOT — it's
    // an implementation detail of the chat rail, not a data object.
    const entityNames = (
      (entities.body.tables ?? entities.body.entities ?? []) as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(entityNames).toContain('files'); // a user-facing native entity is present…
    expect(entityNames).not.toContain('chat_threads'); // …but conversation storage is hidden
    expect(entityNames).not.toContain('chat_messages');

    for (const route of [
      '/api/graph',
      '/api/system-tables',
      '/api/native-entities',
      '/api/gui-meta',
      '/api/gui-meta/columns?table=items',
    ]) {
      const r = await api(h.url, route);
      expect(r.status, `${route} should be 200`).toBe(200);
    }
  });
});

describe('GUI server — row CRUD + audit history', () => {
  it('inserts, reads, patches, lists history, undoes, redoes, and deletes a row', async () => {
    const cfg = writeConfig(dirs[0]!, 'lattice.config.yml', 'main');
    const h = await boot(cfg);

    // Create
    const created = await api(h.url, '/api/tables/items/rows', {
      method: 'POST',
      body: { name: 'first' },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(id).toBeTruthy();

    // List + read-by-id
    const list = await api(h.url, '/api/tables/items/rows');
    expect(list.status).toBe(200);
    expect((list.body.rows as unknown[]).length).toBe(1);
    const byId = await api(h.url, `/api/tables/items/rows/${id}`);
    expect(byId.status).toBe(200);
    expect(byId.body.name).toBe('first');

    // Update
    const patched = await api(h.url, `/api/tables/items/rows/${id}`, {
      method: 'PATCH',
      body: { name: 'renamed' },
    });
    expect(patched.status).toBe(200);

    // History reflects the insert + update
    const history = await api(h.url, '/api/history');
    expect(history.status).toBe(200);
    expect((history.body.entries as unknown[]).length).toBeGreaterThanOrEqual(2);

    // Undo the last change, then redo it
    const undo = await api(h.url, '/api/history/undo', { method: 'POST' });
    expect(undo.status).toBe(200);
    const afterUndo = await api(h.url, `/api/tables/items/rows/${id}`);
    expect(afterUndo.body.name).toBe('first');
    const redo = await api(h.url, '/api/history/redo', { method: 'POST' });
    expect(redo.status).toBe(200);
    const afterRedo = await api(h.url, `/api/tables/items/rows/${id}`);
    expect(afterRedo.body.name).toBe('renamed');

    // Unknown table is rejected
    const bad = await api(h.url, '/api/tables/nope/rows');
    expect(bad.status).toBe(400);

    // Soft-delete then hard-delete
    const softDel = await api(h.url, `/api/tables/items/rows/${id}`, { method: 'DELETE' });
    expect(softDel.status).toBe(200);
    const hardDel = await api(h.url, `/api/tables/items/rows/${id}?hard=true`, {
      method: 'DELETE',
    });
    expect(hardDel.status).toBe(200);
  });
});

describe('GUI server — realtime stream + history edge cases', () => {
  it('serves realtime status and an SSE stream that cleans up on disconnect', async () => {
    const cfg = writeConfig(dirs[0]!, 'lattice.config.yml', 'main');
    const h = await boot(cfg);

    const status = await api(h.url, '/api/realtime/status');
    expect(status.status).toBe(200);
    expect(status.body.mode).toBe('local');

    // Connect to the SSE stream, read the initial `state` event, then abort.
    // The abort fires the server's req 'close' handler (cleanup path). The
    // backported closeAllConnections() guard keeps the afterEach close() from
    // hanging on this keep-alive socket.
    const ac = new AbortController();
    const streamRes = await fetch(`${h.url}/api/realtime/stream`, { signal: ac.signal });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream');
    const reader = streamRes.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: state');
    ac.abort();
    await reader.cancel().catch(() => undefined);
  });

  it('handles history revert + empty undo/redo', async () => {
    const cfg = writeConfig(dirs[0]!, 'lattice.config.yml', 'main');
    const h = await boot(cfg);

    // Nothing to undo / redo on a fresh database.
    expect((await api(h.url, '/api/history/undo', { method: 'POST' })).status).toBe(400);
    expect((await api(h.url, '/api/history/redo', { method: 'POST' })).status).toBe(400);

    // Insert a row, then revert that specific audit entry.
    await api(h.url, '/api/tables/items/rows', { method: 'POST', body: { name: 'x' } });
    const history = await api(h.url, '/api/history');
    const entryId = (history.body.entries as { id: string }[])[0]!.id;
    expect((await api(h.url, `/api/history/revert/${entryId}`, { method: 'POST' })).status).toBe(
      200,
    );
    // Reverting it again → already undone (400); a bogus id → 404.
    expect((await api(h.url, `/api/history/revert/${entryId}`, { method: 'POST' })).status).toBe(
      400,
    );
    expect(
      (await api(h.url, '/api/history/revert/does-not-exist', { method: 'POST' })).status,
    ).toBe(404);
  });
});

describe('GUI server — schema editing routes', () => {
  it('adds an entity, adds/renames a column, renames the entity, toggles column-secret', async () => {
    const cfg = writeConfig(dirs[0]!, 'lattice.config.yml', 'main');
    const h = await boot(cfg);

    // Add a new entity
    const addEntity = await api(h.url, '/api/schema/entities', {
      method: 'POST',
      body: { name: 'widgets' },
    });
    expect(addEntity.status).toBe(200);
    expect(addEntity.body.name).toBe('widgets');

    // Invalid + duplicate name → 400
    expect(
      (await api(h.url, '/api/schema/entities', { method: 'POST', body: { name: '1bad' } })).status,
    ).toBe(400);
    expect(
      (await api(h.url, '/api/schema/entities', { method: 'POST', body: { name: 'widgets' } }))
        .status,
    ).toBe(400);

    // Add a column
    const addCol = await api(h.url, '/api/schema/entities/widgets/columns', {
      method: 'POST',
      body: { name: 'price', type: 'integer', required: true },
    });
    expect(addCol.status).toBe(200);
    expect(
      (
        await api(h.url, '/api/schema/entities/widgets/columns', {
          method: 'POST',
          body: { name: '1bad' },
        })
      ).status,
    ).toBe(400);

    // Rename the column (and reject renaming the id PK)
    expect(
      (
        await api(h.url, '/api/schema/entities/widgets/columns/price/rename', {
          method: 'POST',
          body: { to: 'cost' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(h.url, '/api/schema/entities/widgets/columns/id/rename', {
          method: 'POST',
          body: { to: 'pk' },
        })
      ).status,
    ).toBe(400);

    // Rename the entity (and reject an unknown entity)
    expect(
      (
        await api(h.url, '/api/schema/entities/widgets/rename', {
          method: 'POST',
          body: { to: 'gadgets' },
        })
      ).status,
    ).toBe(200);
    expect(
      (await api(h.url, '/api/schema/entities/nope/rename', { method: 'POST', body: { to: 'x' } }))
        .status,
    ).toBe(400);

    // Toggle the column-secret flag — once to insert the meta row, once to update it
    expect(
      (
        await api(h.url, '/api/gui-meta/columns/gadgets/cost', {
          method: 'PUT',
          body: { secret: true },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(h.url, '/api/gui-meta/columns/gadgets/cost', {
          method: 'PUT',
          body: { secret: false },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(h.url, '/api/gui-meta/columns/nope/cost', {
          method: 'PUT',
          body: { secret: true },
        })
      ).status,
    ).toBe(400);
  });
});

describe('GUI server — database management routes', () => {
  it('lists, creates, and switches databases', async () => {
    const cfg = writeConfig(dirs[0]!, 'lattice.config.yml', 'main');
    const h = await boot(cfg);

    const list = await api(h.url, '/api/databases');
    expect(list.status).toBe(200);
    expect((list.body.configs as unknown[]).length).toBeGreaterThanOrEqual(1);

    // Create a second database (switches active to it)
    const created = await api(h.url, '/api/databases/create', {
      method: 'POST',
      body: { name: 'second' },
    });
    expect(created.status).toBe(200);

    // Bad create (empty name) → 400
    const badCreate = await api(h.url, '/api/databases/create', { method: 'POST', body: {} });
    expect(badCreate.status).toBe(400);

    // Switch back to the original
    const switched = await api(h.url, '/api/databases/switch', {
      method: 'POST',
      body: { path: cfg },
    });
    expect(switched.status).toBe(200);

    // Switch to a non-existent config → 400
    const badSwitch = await api(h.url, '/api/databases/switch', {
      method: 'POST',
      body: { path: join(dirs[0]!, 'does-not-exist.yml') },
    });
    expect(badSwitch.status).toBe(400);

    // Switch to a config that exists but fails to open (malformed YAML) →
    // the server surfaces the open failure as 500 rather than ending up with
    // no active DB.
    const brokenCfg = join(dirs[0]!, 'broken.config.yml');
    writeFileSync(brokenCfg, 'db: ./data/broken.db\nentities: [ this is : not valid yaml');
    const brokenSwitch = await api(h.url, '/api/databases/switch', {
      method: 'POST',
      body: { path: brokenCfg },
    });
    expect(brokenSwitch.status).toBe(500);
  });

  it('delete surfaces a filesystem failure loudly instead of half-deleting (Rule 16)', async () => {
    const cfg = writeConfig(dirs[0]!, 'lattice.config.yml', 'main');
    // A second, non-active database whose .db path is a DIRECTORY, so the
    // file unlink throws and the server must report it (500), not swallow it.
    const bCfg = writeConfig(dirs[0]!, 'b.config.yml', 'b');
    mkdirSync(join(dirs[0]!, 'data', 'b.db'), { recursive: true });
    const h = await boot(cfg);

    const res = await api(h.url, '/api/databases/delete', {
      method: 'POST',
      body: { path: bCfg },
    });
    expect(res.status).toBe(500);
    expect(String(res.body.error)).toContain('Failed to delete database files');
  });
});
