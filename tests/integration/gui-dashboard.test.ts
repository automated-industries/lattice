import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * GET /api/dashboard — workspace overview: per-entity counts + freshness
 * (MAX of created_at/updated_at/ts) + recent activity (the GUI audit log).
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-dash-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY']) savedEnv[k] = process.env[k];
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'dash-test-key';
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-dash-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  widgets:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      body: { type: text }',
      '      created_at: { type: text }',
      '    outputFile: widgets.md',
      '',
    ].join('\n'),
  );
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    host: '127.0.0.1',
    teamCloud: false,
    openBrowser: false,
  });
  servers.push(server);
  return server;
}

async function postRow(url: string, table: string, row: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${url}/api/tables/${table}/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(row),
  });
  expect(r.status).toBeLessThan(300);
}

interface DashboardResponse {
  generatedAt: string;
  staleDays: number;
  totals: { entities: number; rows: number; stale: number };
  entities: {
    name: string;
    rowCount: number | null;
    lastUpdatedAt: string | null;
    stale: boolean;
  }[];
}

describe('GET /api/dashboard', () => {
  it('returns counts + freshness (no recent-activity section as of 1.16.2)', async () => {
    const s = await boot();
    const recent = new Date().toISOString();
    await postRow(s.url, 'widgets', { body: 'first', created_at: recent });
    await postRow(s.url, 'widgets', { body: 'second', created_at: recent });

    const res = await fetch(`${s.url}/api/dashboard`);
    expect(res.status).toBe(200);
    const d = (await res.json()) as DashboardResponse;

    expect(d.staleDays).toBe(14);
    const widgets = d.entities.find((e) => e.name === 'widgets');
    expect(widgets).toBeTruthy();
    expect(widgets?.rowCount).toBe(2);
    expect(widgets?.lastUpdatedAt).toBe(recent); // MAX(created_at)
    expect(widgets?.stale).toBe(false);

    expect(d.totals.entities).toBeGreaterThanOrEqual(1);
    expect(d.totals.rows).toBeGreaterThanOrEqual(2);

    // The Recent Activity section was removed in 1.16.2 — the payload no longer
    // carries `recent` (Version History covers the audit log).
    expect((d as { recent?: unknown }).recent).toBeUndefined();
  });

  it('flags a stale entity when its newest row is older than the window', async () => {
    const s = await boot();
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString(); // 30 days ago
    await postRow(s.url, 'widgets', { body: 'ancient', created_at: old });

    const res = await fetch(`${s.url}/api/dashboard`);
    const d = (await res.json()) as DashboardResponse;
    const widgets = d.entities.find((e) => e.name === 'widgets');
    expect(widgets?.lastUpdatedAt).toBe(old);
    expect(widgets?.stale).toBe(true);
    expect(d.totals.stale).toBeGreaterThanOrEqual(1);
  });
});
