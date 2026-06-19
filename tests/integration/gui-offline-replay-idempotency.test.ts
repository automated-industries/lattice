import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * #3.6 — offline-replay idempotency. The GUI stamps every row write with a stable
 * `x-lattice-edit-id` and REPLAYS the same POST after a reconnect (or when the
 * original response was lost after the row already committed). The server must
 * treat a replayed POST carrying an already-seen edit-id as a no-op — same row,
 * NO duplicate — instead of inserting a second row.
 *
 * Fails before the fix: the server ignored the header, so the replay created a
 * second row (GET returned 2). Runs on SQLite — no Postgres gate, so it also
 * guards the Windows CI job.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-replay-'));
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
  const s = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
  });
  servers.push(s);
  return s;
}

function postRow(
  s: GuiServerHandle,
  body: unknown,
  editId?: string,
  clientTs?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (editId) headers['x-lattice-edit-id'] = editId;
  if (clientTs) headers['x-lattice-client-ts'] = clientTs;
  return fetch(`${s.url}/api/tables/tasks/rows`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function rowCount(s: GuiServerHandle): Promise<number> {
  const j = (await (await fetch(`${s.url}/api/tables/tasks/rows`)).json()) as {
    rows: unknown[];
  };
  return j.rows.length;
}

/** Audit timestamps of every recorded insert, in history order. */
async function insertTimestamps(s: GuiServerHandle): Promise<string[]> {
  const h = (await (await fetch(`${s.url}/api/history?limit=50`)).json()) as {
    entries: { ts: string; operation: string }[];
  };
  return h.entries.filter((e) => e.operation === 'insert').map((e) => e.ts);
}

describe('#3.6 offline-replay idempotency', () => {
  it('a replayed POST with the same edit-id does not create a duplicate row', async () => {
    const s = await boot();
    const editId = randomUUID();

    const first = await postRow(s, { title: 'Ship it', status: 'todo' }, editId);
    expect(first.status).toBe(201);
    const { id: firstId } = (await first.json()) as { id: string };
    expect(firstId).toBeTruthy();

    // Replay: identical body, identical edit-id (the client kept it in its queue).
    const replay = await postRow(s, { title: 'Ship it', status: 'todo' }, editId);
    expect(replay.status).toBe(200); // idempotent no-op, not a fresh 201
    const { id: replayId } = (await replay.json()) as { id: string };
    expect(replayId).toBe(firstId); // resolves to the SAME row

    expect(await rowCount(s)).toBe(1); // exactly one row, no duplicate
  });

  it('distinct edit-ids still create distinct rows (idempotency is per edit)', async () => {
    const s = await boot();
    await postRow(s, { title: 'A', status: 'todo' }, randomUUID());
    await postRow(s, { title: 'B', status: 'todo' }, randomUUID());
    expect(await rowCount(s)).toBe(2);
  });

  it('a POST with no edit-id behaves exactly as before (fresh row each time)', async () => {
    const s = await boot();
    const a = await postRow(s, { title: 'no-id', status: 'todo' });
    expect(a.status).toBe(201);
    const b = await postRow(s, { title: 'no-id', status: 'todo' });
    expect(b.status).toBe(201);
    expect(await rowCount(s)).toBe(2); // no edit-id → no dedup, two rows
  });
});

/**
 * Extended replay guards: dedup is per-edit and survives INTERLEAVING, and the
 * audit/history timestamp is keyed to each edit's true client time — so neither
 * arrival order nor a replay carrying a different client-ts can rewrite history.
 * (deriveRowIdFromEditId makes a replay resolve to the same row, so the second
 * POST no-ops before any change is written — its client-ts is never applied.)
 */
describe('offline-replay ordering + interleaving', () => {
  it('interleaved replays of distinct edit-ids each dedup independently', async () => {
    const s = await boot();
    const a = randomUUID();
    const b = randomUUID();
    const aId = (
      (await (await postRow(s, { title: 'A', status: 'todo' }, a)).json()) as { id: string }
    ).id;
    const bId = (
      (await (await postRow(s, { title: 'B', status: 'todo' }, b)).json()) as { id: string }
    ).id;
    // Replay A then B (interleaved against the two committed rows).
    const a2 = await postRow(s, { title: 'A', status: 'todo' }, a);
    const b2 = await postRow(s, { title: 'B', status: 'todo' }, b);
    expect(a2.status).toBe(200); // idempotent no-op
    expect(b2.status).toBe(200);
    expect(((await a2.json()) as { id: string }).id).toBe(aId); // each resolves to its own row
    expect(((await b2.json()) as { id: string }).id).toBe(bId);
    expect(await rowCount(s)).toBe(2); // exactly two rows despite four POSTs
  });

  it('out-of-order arrival records each edit at its true client time, not arrival/server time', async () => {
    const s = await boot();
    const tLate = '2026-02-01T00:00:00.000Z';
    const tEarly = '2026-01-01T00:00:00.000Z';
    // A was edited LATER but arrives FIRST; B was edited EARLIER but arrives SECOND.
    await postRow(s, { title: 'A', status: 'todo' }, randomUUID(), tLate);
    await postRow(s, { title: 'B', status: 'todo' }, randomUUID(), tEarly);
    // Both true edit times are recorded — not the (≈now) arrival order.
    expect((await insertTimestamps(s)).sort()).toEqual([tEarly, tLate].sort());
  });

  it('a replay carrying a different client-ts does not rewrite the original audit time', async () => {
    const s = await boot();
    const editId = randomUUID();
    const tOriginal = '2026-01-15T00:00:00.000Z';
    const tReplay = '2026-03-20T00:00:00.000Z';
    expect((await postRow(s, { title: 'once', status: 'todo' }, editId, tOriginal)).status).toBe(
      201,
    );
    const replay = await postRow(s, { title: 'once', status: 'todo' }, editId, tReplay);
    expect(replay.status).toBe(200); // idempotent — no second insert
    expect(await insertTimestamps(s)).toEqual([tOriginal]); // history keeps the ORIGINAL edit time
    expect(await rowCount(s)).toBe(1);
  });
});
