/**
 * #4.5 / #4.6 — offline-edit handling at the row routes.
 *
 *  4.5: a write that can NEVER replay (the row is gone / RLS-invisible) returns
 *       409, not a generic 500 — so the client marks the queued edit failed +
 *       surfaces it (dead-letter) instead of retrying it forever.
 *  4.6: the audit/history timestamp honors the originating client's edit time
 *       (`x-lattice-client-ts`) — an offline edit shows when it was MADE, not when
 *       it synced — while a future timestamp is rejected (can't jump the order).
 *
 * Runs on SQLite (no Postgres gate) — covers the route status + audit-ts wiring.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-offedit-'));
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

describe('#4.5 unreplayable writes return 409 (not 500)', () => {
  it('PATCH a non-existent row → 409', async () => {
    const s = await boot();
    const r = await fetch(`${s.url}/api/tables/tasks/rows/nope`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(r.status).toBe(409); // was 500 — the drain loop would retry a 500 forever
  });

  it('DELETE a non-existent row → 409', async () => {
    const s = await boot();
    const r = await fetch(`${s.url}/api/tables/tasks/rows/nope`, { method: 'DELETE' });
    expect(r.status).toBe(409);
  });
});

describe('#4.6 audit timestamp honors the client edit time', () => {
  it('a POST carrying a PAST x-lattice-client-ts records that time in history', async () => {
    const s = await boot();
    const editedAt = '2026-01-02T03:04:05.000Z'; // long before "now"
    const created = await fetch(`${s.url}/api/tables/tasks/rows`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lattice-edit-id': randomUUID(),
        'x-lattice-client-ts': editedAt,
      },
      body: JSON.stringify({ title: 'made offline' }),
    });
    expect(created.status).toBe(201);

    const h = (await (await fetch(`${s.url}/api/history?limit=10`)).json()) as {
      entries: { ts: string; operation: string }[];
    };
    const insert = h.entries.find((e) => e.operation === 'insert');
    expect(insert).toBeDefined();
    expect(insert!.ts).toBe(editedAt); // the edit time, not sync/arrival time
  });

  it('a FUTURE x-lattice-client-ts is rejected (falls back to server now)', async () => {
    const s = await boot();
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // +1 year
    const before = Date.now();
    await fetch(`${s.url}/api/tables/tasks/rows`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lattice-edit-id': randomUUID(),
        'x-lattice-client-ts': future,
      },
      body: JSON.stringify({ title: 'forged future' }),
    });
    const h = (await (await fetch(`${s.url}/api/history?limit=10`)).json()) as {
      entries: { ts: string; operation: string }[];
    };
    const insert = h.entries.find((e) => e.operation === 'insert');
    expect(insert).toBeDefined();
    const recorded = Date.parse(insert!.ts);
    expect(recorded).not.toBe(Date.parse(future)); // forged future not honored
    expect(recorded).toBeGreaterThanOrEqual(before - 1000); // ≈ server now
    expect(recorded).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
