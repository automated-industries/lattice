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
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (editId) headers['x-lattice-edit-id'] = editId;
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
