/**
 * #4.9 — the row-list endpoint bounds + validates its page params. An unbounded
 * `limit` is a full-table egress on a cloud hot path, and `Number('abc')` was
 * silently becoming `LIMIT NaN`. Non-numeric → 400; a huge limit is clamped (the
 * request still succeeds, just capped). Runs on SQLite.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-rowsbound-'));
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

const rows = (s: GuiServerHandle, qs: string) => fetch(`${s.url}/api/tables/tasks/rows${qs}`);

describe('#4.9 row-list page-param bounds', () => {
  it('rejects a non-numeric limit / offset with 400 (not LIMIT NaN)', async () => {
    const s = await boot();
    expect((await rows(s, '?limit=abc')).status).toBe(400);
    expect((await rows(s, '?offset=-1')).status).toBe(400);
    expect((await rows(s, '?limit=1.5')).status).toBe(400);
  });

  it('accepts a sane limit and clamps an enormous one (request still succeeds)', async () => {
    const s = await boot();
    expect((await rows(s, '?limit=10')).status).toBe(200);
    const huge = await rows(s, '?limit=99999999');
    expect(huge.status).toBe(200); // clamped server-side, not rejected
    const body = (await huge.json()) as { rows: unknown[] };
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it('defaults when params are absent', async () => {
    const s = await boot();
    expect((await rows(s, '')).status).toBe(200);
  });
});

// The /api/system-tables/:table/rows endpoint reads an internal table directly
// (interpolating limit into the SELECT). It previously used `Number(limit ?? 500)`
// with no clamp + no NaN guard, so a client could request an unbounded slice or
// turn it into `LIMIT NaN`. It now shares parsePageParam with /api/tables/:t/rows.
const sysRows = (s: GuiServerHandle, qs: string) =>
  fetch(`${s.url}/api/system-tables/_lattice_gui_meta/rows${qs}`);

describe('system-tables row read — bounded page params', () => {
  it('rejects a non-numeric limit with 400 (not LIMIT NaN)', async () => {
    const s = await boot();
    expect((await sysRows(s, '?limit=abc')).status).toBe(400);
    expect((await sysRows(s, '?limit=1.5')).status).toBe(400);
  });

  it('clamps an enormous limit instead of issuing an unbounded read', async () => {
    const s = await boot();
    const huge = await sysRows(s, '?limit=99999999');
    expect(huge.status).toBe(200); // clamped server-side, not rejected
    const body = (await huge.json()) as { rows: unknown[] };
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it('succeeds with no limit param (default page size)', async () => {
    const s = await boot();
    expect((await sysRows(s, '')).status).toBe(200);
  });
});
