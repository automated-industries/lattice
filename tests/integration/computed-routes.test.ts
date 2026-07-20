import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * The computed-table HTTP surface (`/api/computed-tables`) end-to-end against
 * an in-process SQLite GUI server: full CRUD, the dry-run preview, the field
 * picker, the NDJSON refresh stream, the friendly row-write refusal, and the
 * `computedTable: true` stamp on the entities payload. (The team-cloud member
 * refusal of the mutating routes is covered by the Postgres-gated cloud
 * member suite — a member open needs a real scoped role.)
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // Deterministic "no model credentials" state: the refresh stream must report
  // per-field errors from the fill engine, never reach a real API.
  savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  savedEnv.ANTHROPIC_OAUTH_BETA = process.env.ANTHROPIC_OAUTH_BETA;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_OAUTH_BETA;
});

afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedEnv.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
  if (savedEnv.ANTHROPIC_OAUTH_BETA === undefined) delete process.env.ANTHROPIC_OAUTH_BETA;
  else process.env.ANTHROPIC_OAUTH_BETA = savedEnv.ANTHROPIC_OAUTH_BETA;
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-computed-routes-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  tickets:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      status: { type: text }',
      '      priority: { type: integer }',
      '      assignee_id: { type: uuid }',
      '      deleted_at: { type: text }',
      '    relations:',
      '      assignee: { type: belongsTo, table: users, foreignKey: assignee_id }',
      '    outputFile: tickets.md',
      '  users:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '    outputFile: users.md',
      '  tags:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      label: { type: text }',
      '    outputFile: tags.md',
      '  ticket_tags:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      ticket_id: { type: uuid }',
      '      tag_id: { type: uuid }',
      '    relations:',
      '      ticket: { type: belongsTo, table: tickets, foreignKey: ticket_id }',
      '      tag: { type: belongsTo, table: tags, foreignKey: tag_id }',
      '    outputFile: ticket_tags.md',
      '',
    ].join('\n'),
    'utf8',
  );
  const handle = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
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
    /* non-JSON */
  }
  return { status: res.status, body };
}

const summaryDef = {
  base: 'tickets',
  fields: {
    title: { kind: 'alias', source: 'title' },
    who: { kind: 'alias', source: 'assignee.name' },
    urgent: { kind: 'calc', expr: 'priority >= 3', type: 'boolean' },
    tag_count: { kind: 'aggregate', via: 'ticket_tags.tag', fn: 'count' },
    mood: {
      kind: 'ai_classify',
      input: 'status',
      prompt: 'Classify the status.',
      labels: ['open', 'closed'],
    },
  },
};

async function seedRows(h: GuiServerHandle): Promise<void> {
  const grace = await api(h.url, '/api/tables/users/rows', {
    method: 'POST',
    body: { name: 'Grace' },
  });
  expect(grace.status).toBe(201);
  const t1 = await api(h.url, '/api/tables/tickets/rows', {
    method: 'POST',
    body: {
      title: 'Fix crash',
      status: 'open',
      priority: 5,
      assignee_id: grace.body.id as string,
    },
  });
  expect(t1.status).toBe(201);
  const t2 = await api(h.url, '/api/tables/tickets/rows', {
    method: 'POST',
    body: { title: 'Docs pass', status: 'closed', priority: 1 },
  });
  expect(t2.status).toBe(201);
}

describe('computed-table routes', () => {
  it('full CRUD + inspect + entities stamp + row-write refusal', async () => {
    const h = await boot();
    await seedRows(h);

    // Create.
    const created = await api(h.url, '/api/computed-tables', {
      method: 'POST',
      body: { name: 'ticket_summary', def: summaryDef },
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, name: 'ticket_summary' });

    // A malformed definition is a 400, not a 500.
    const bad = await api(h.url, '/api/computed-tables', {
      method: 'POST',
      body: { name: 'nope', def: { base: 'tickets', fields: { x: { kind: 'wat' } } } },
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/unknown kind/);

    // List: def + per-field state.
    const list = await api(h.url, '/api/computed-tables');
    expect(list.status).toBe(200);
    const tables = list.body.tables as { name: string; def: unknown; state: unknown[] }[];
    expect(tables.map((t) => t.name)).toEqual(['ticket_summary']);
    expect(tables[0]!.def).toEqual(summaryDef);
    expect(Array.isArray(tables[0]!.state)).toBe(true);

    // Inspect: def + compiled SQL for display.
    const one = await api(h.url, '/api/computed-tables/ticket_summary');
    expect(one.status).toBe(200);
    expect(one.body.def).toEqual(summaryDef);
    expect(String(one.body.sql)).toContain('SELECT');
    expect((await api(h.url, '/api/computed-tables/ghost')).status).toBe(404);

    // The view reads through the normal rows route…
    const rows = await api(h.url, '/api/tables/ticket_summary/rows');
    expect(rows.status).toBe(200);
    expect((rows.body.rows as unknown[]).length).toBe(2);

    // …but a row write is refused with the friendly message (4xx, not 500).
    const write = await api(h.url, '/api/tables/ticket_summary/rows', {
      method: 'POST',
      body: { title: 'sneaky' },
    });
    expect(write.status).toBe(409);
    expect(String(write.body.error)).toContain(
      '"ticket_summary" is a computed view and can\'t be edited directly',
    );

    // /api/entities carries the authoritative computedTable flag.
    const entities = await api(h.url, '/api/entities');
    const summary = (entities.body.tables as { name: string; computedTable?: boolean }[]).find(
      (t) => t.name === 'ticket_summary',
    );
    expect(summary?.computedTable).toBe(true);

    // Update: the calc widens and the change is served immediately.
    const updated = await api(h.url, '/api/computed-tables/ticket_summary', {
      method: 'PUT',
      body: {
        def: {
          ...summaryDef,
          fields: {
            ...summaryDef.fields,
            urgent: { kind: 'calc', expr: 'priority >= 1', type: 'boolean' },
          },
        },
      },
    });
    expect(updated.status).toBe(200);
    const after = await api(h.url, '/api/tables/ticket_summary/rows');
    for (const r of after.body.rows as { urgent: unknown }[]) expect(Number(r.urgent)).toBe(1);

    // Delete.
    expect(
      (await api(h.url, '/api/computed-tables/ticket_summary', { method: 'DELETE' })).status,
    ).toBe(200);
    expect(((await api(h.url, '/api/computed-tables')).body.tables as unknown[]).length).toBe(0);
    expect((await api(h.url, '/api/tables/ticket_summary/rows')).status).toBe(400); // unknown table again
  });

  it('field picker: base columns + relation paths + junction aggregates; 400 on bad bases', async () => {
    const h = await boot();
    const fields = await api(h.url, '/api/computed-tables/fields?base=tickets');
    expect(fields.status).toBe(200);
    const paths = (fields.body.fields as { path: string; via: string }[]).map((f) => f.path);
    expect(paths).toContain('title');
    expect(paths).toContain('assignee.name');
    expect(paths).toContain('ticket_tags.tag');

    expect((await api(h.url, '/api/computed-tables/fields?base=ghost')).status).toBe(400);
    expect((await api(h.url, '/api/computed-tables/fields?base=ticket_tags')).status).toBe(400);
  });

  it('preview dry-runs with no persisted side effects and pendingAi counts', async () => {
    const h = await boot();
    await seedRows(h);
    const preview = await api(h.url, '/api/computed-tables/preview', {
      method: 'POST',
      body: { def: summaryDef, limit: 1 },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.columns).toEqual(['id', 'title', 'who', 'urgent', 'tag_count', 'mood']);
    expect((preview.body.rows as unknown[]).length).toBe(1);
    expect(String(preview.body.sql)).toContain('SELECT');
    // Two distinct status values would need classification.
    expect(preview.body.pendingAi).toEqual({ mood: 2 });
    // Nothing was saved — the list is still empty.
    expect(((await api(h.url, '/api/computed-tables')).body.tables as unknown[]).length).toBe(0);

    const bad = await api(h.url, '/api/computed-tables/preview', {
      method: 'POST',
      body: { def: { base: 'ghost', fields: { x: { kind: 'alias', source: 'title' } } } },
    });
    expect(bad.status).toBe(400);
  });

  it('refresh streams NDJSON per-field progress and a terminal done line', async () => {
    const h = await boot();
    await seedRows(h);
    expect(
      (
        await api(h.url, '/api/computed-tables', {
          method: 'POST',
          body: { name: 'ticket_summary', def: summaryDef },
        })
      ).status,
    ).toBe(200);

    const res = await fetch(`${h.url}/api/computed-tables/ticket_summary/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toMatchObject({ phase: 'field', field: 'mood' });
    const done = lines.find((l) => l.phase === 'field-done');
    // No model provider in this environment → the fill engine reports the
    // per-field error state through the stream (never a crash, never a 500).
    expect(done).toMatchObject({ field: 'mood' });
    expect(String(done?.error)).toContain('No model provider is configured');
    expect(lines[lines.length - 1]).toEqual({ done: true });

    // An unknown table errors INSIDE the stream (headers already sent).
    const missing = await fetch(`${h.url}/api/computed-tables/ghost/refresh`, { method: 'POST' });
    const missingLines = (await missing.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(missingLines[0]).toMatchObject({ phase: 'error' });
  });

  it('delete is refused while another computed table is built on it', async () => {
    const h = await boot();
    await seedRows(h);
    await api(h.url, '/api/computed-tables', {
      method: 'POST',
      body: { name: 'ticket_summary', def: summaryDef },
    });
    await api(h.url, '/api/computed-tables', {
      method: 'POST',
      body: {
        name: 'ticket_brief',
        def: { base: 'ticket_summary', fields: { headline: { kind: 'alias', source: 'title' } } },
      },
    });
    const refused = await api(h.url, '/api/computed-tables/ticket_summary', { method: 'DELETE' });
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toContain('ticket_brief');

    // Entity delete of a SOURCE table is refused naming the computed dependents.
    const sourceDelete = await api(h.url, '/api/schema/entities/users', { method: 'DELETE' });
    expect(sourceDelete.status).toBe(400);
    expect(String(sourceDelete.body.error)).toContain('ticket_summary');
  });
});
