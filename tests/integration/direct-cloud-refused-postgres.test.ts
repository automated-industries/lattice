/**
 * 2.2.3 — a cloud is reachable ONLY through a user-authenticated server. A
 * regular GUI pointed straight at a cloud's `postgres://` connection is the
 * deprecated, insecure path (anyone with the string reads everything), so the
 * GUI must REFUSE to open it: serve no team context and no tables, and signal
 * a reconnect through a server. A solo (non-team) Postgres backend has no
 * `__lattice_team_identity` and keeps working directly.
 *
 * Postgres-gated; runs in CI's ubuntu+postgres job, skipped locally without
 * LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import {
  CLOUD_INTERNAL_TABLE_DEFS,
  installRowPermsSchema,
} from '../../src/teams/internal-tables.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const pools: pg.Pool[] = [];
const schemas: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

function writeDirectCloudConfig(url: string): { configPath: string; outputDir: string } {
  const root = mkdtempSync(join(tmpdir(), `direct-cloud-${randomBytes(3).toString('hex')}-`));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  // A raw postgres:// db: line — the direct connection the GUI must refuse for
  // a cloud and accept for a solo backend.
  writeFileSync(configPath, `db: ${url}\n\nentities: {}\n`);
  const outputDir = join(root, 'context');
  mkdirSync(outputDir, { recursive: true });
  return { configPath, outputDir };
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const p of pools.splice(0)) await p.end();
});

describe.skipIf(!PG_URL)('GUI refuses a direct postgres:// CLOUD connection (2.2.3)', () => {
  it('refuses to open a team cloud directly — no team context, no tables, reconnect signalled', async () => {
    const schema = `direct_cloud_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    const url = schemaUrl(schema);

    // Seed a real cloud: team identity + a shared table with a row.
    const seed = new Lattice(url);
    seed.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'tasks.md',
    });
    await seed.init();
    for (const [t, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) await seed.defineLate(t, def);
    await installRowPermsSchema(seed);
    const now = new Date().toISOString();
    await seed.upsert('__lattice_team_identity', {
      id: 'singleton',
      team_id: 'team-x',
      team_name: 'x',
      creator_email: 'c@example.com',
      created_at: now,
    });
    await seed.upsert('tasks', { id: 't1', title: 'secret task' });
    seed.close();

    const { configPath, outputDir } = writeDirectCloudConfig(url);
    // teamCloud defaults to false → this is a regular GUI, which must refuse.
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const cfg = (await fetch(`${server.url}/api/dbconfig`).then((r) => r.json())) as {
      cloudReconnectRequired?: boolean;
    };
    expect(cfg.cloudReconnectRequired).toBe(true);

    // No cloud tables are served, and the seeded row is unreachable.
    const entities = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: { name: string }[];
    };
    expect(entities.tables.map((t) => t.name)).not.toContain('tasks');

    const rows = await fetch(`${server.url}/api/tables/tasks/rows`);
    expect(rows.status).not.toBe(200); // refused — the cloud is not served directly
  });

  it('still opens a SOLO (non-team) Postgres backend directly', async () => {
    const schema = `solo_pg_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    const url = schemaUrl(schema);

    // A plain Postgres backend: a user table, NO __lattice_team_identity.
    const seed = new Lattice(url);
    seed.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    await seed.init();
    await seed.upsert('notes', { id: 'n1', body: 'mine' });
    seed.close();

    const { configPath, outputDir } = writeDirectCloudConfig(url);
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const cfg = (await fetch(`${server.url}/api/dbconfig`).then((r) => r.json())) as {
      cloudReconnectRequired?: boolean;
    };
    expect(cfg.cloudReconnectRequired).toBe(false); // solo backend is fine

    const entities = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: { name: string }[];
    };
    expect(entities.tables.map((t) => t.name)).toContain('notes');
    const rows = await fetch(`${server.url}/api/tables/notes/rows`);
    expect(rows.status).toBe(200); // served normally
  });

  afterEach(async () => {
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
    await admin.end();
  });
});
