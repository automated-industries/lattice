import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * 1.16.2 GUI fixes (1.16.1 demo follow-up):
 *  B — audit `ts` is set explicitly at insert (a valid ISO string) instead of
 *      relying on the SQLite-only strftime DEFAULT, so cloud/Postgres history
 *      stops rendering "Invalid Date". (Meaningful under the Postgres gate, but
 *      asserts the ISO contract on both adapters.)
 *  C — the file-system "simple" view ships a create tile + create-form modal.
 *  D2/D3 — the cloud Database panel ships the Invite-member flow with a
 *      redacted connection string, and the Danger Zone has Disconnect / Leave.
 *  E — the db lists make rows clickable (data-switch-path) with no Switch button.
 *  (A — dashboard no longer returns `recent` — covered by gui-dashboard.test.ts.)
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const j = (r: Response) => r.json();
const post = (s: GuiServerHandle, path: string, body?: unknown) =>
  fetch(`${s.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-1162-'));
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

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

describe('1.16.2 — B: audit entries carry a valid ISO timestamp', () => {
  it('a row insert and a schema op both record a parseable ISO ts', async () => {
    const s = await boot();
    expect((await post(s, '/api/tables/tasks/rows', { title: 'x', status: 'todo' })).status).toBe(
      201,
    );
    expect((await post(s, '/api/schema/entities', { name: 'widgets' })).status).toBe(200);
    const h = (await j(await fetch(`${s.url}/api/history?limit=50`))) as {
      entries: { ts: string; operation: string }[];
    };
    expect(h.entries.length).toBeGreaterThanOrEqual(2);
    for (const e of h.entries) {
      expect(e.ts, `ts for ${e.operation}`).toMatch(ISO);
      expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
    }
  });
});

describe('1.16.2 — C/D/E: served bundle ships the new UI', () => {
  it('includes the simple-view create form, cloud member/invite/danger UI, and clickable db rows', async () => {
    const s = await boot();
    const html = await (await fetch(`${s.url}/`)).text();
    // C — create tile + modal + dashed tile style.
    expect(html).toContain('data-fs-create');
    expect(html).toContain('openFsCreateModal');
    expect(html).toContain('fs-tile-create');
    // D2 — invite-member flow + redacted connection string block.
    expect(html).toContain('Invite member');
    expect(html).toContain('copy-conn');
    // D3 — Danger Zone disconnect (owner) / leave (member).
    expect(html).toContain('Disconnect from cloud');
    expect(html).toContain('Leave team');
    // E — clickable rows, no per-row Switch button.
    expect(html).toContain('data-switch-path');
    expect(html).not.toContain('>Switch</button>');
  });
});
