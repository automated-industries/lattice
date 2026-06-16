/**
 * Workspace logo on a secured cloud (HTTP round-trip + permission model):
 *   - owner POSTs a square PNG → 200 + content etag;
 *   - GET serves the bytes with the right Content-Type + ETag; If-None-Match → 304;
 *   - /api/dbconfig surfaces the logoEtag;
 *   - owner POST empty → removes (GET → 404);
 *   - non-square upload → 400;
 *   - a scoped MEMBER cannot set it (the SECURITY DEFINER setter RAISEs).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const dirs: string[] = [];
const dbs: Lattice[] = [];
const servers: GuiServerHandle[] = [];
const pools: pg.Pool[] = [];
const schemas: string[] = [];
const roles: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}
function memberPool(schema: string, role: string, password: string): pg.Pool {
  const u = new URL(PG_URL!);
  u.username = role;
  u.password = password;
  u.searchParams.set('options', `-c search_path=${schema}`);
  const p = new pg.Pool({ connectionString: u.toString(), max: 1 });
  pools.push(p);
  return p;
}
function pngUri(w: number, h: number): string {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(0x0000000d, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return 'data:image/png;base64,' + b.toString('base64');
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
  for (const p of pools.splice(0)) await p.end();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('workspace logo on a secured cloud', () => {
  async function ownerServer(schema: string): Promise<GuiServerHandle> {
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    // Secure the cloud first (installs RLS + the cloud-settings helpers).
    const o = new Lattice(schemaUrl(schema), { encryptionKey: 'logo-test-key' });
    dbs.push(o);
    registerNativeEntities(o);
    await o.init();
    await secureCloud(o);
    o.close();
    dbs.pop();
    // Then start the GUI server on the same schema (connects as the owner role).
    const root = mkdtempSync(join(tmpdir(), 'lattice-logo-cloud-'));
    dirs.push(root);
    mkdirSync(join(root, 'context'), { recursive: true });
    const configPath = join(root, 'lattice.config.yml');
    writeFileSync(
      configPath,
      [
        `db: ${schemaUrl(schema)}`,
        '',
        'entities:',
        '  notes:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      title: { type: text }',
        '    outputFile: notes.md',
        '',
      ].join('\n'),
    );
    const server = await startGuiServer({
      configPath,
      outputDir: join(root, 'context'),
      port: 0,
      openBrowser: false,
    });
    servers.push(server);
    return server;
  }

  it('owner sets, serves (with ETag/304), reports, and removes the logo', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `logo_${tag}`;
    schemas.push(schema);
    const s = await ownerServer(schema);

    // Set.
    const post = await fetch(`${s.url}/api/cloud/workspace-logo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logo: pngUri(64, 64) }),
    });
    expect(post.status).toBe(200);
    const { logoEtag } = (await post.json()) as { logoEtag: string };
    expect(typeof logoEtag).toBe('string');

    // /api/dbconfig surfaces the etag.
    const cfg = (await fetch(`${s.url}/api/dbconfig`).then((r) => r.json())) as {
      logoEtag: string;
    };
    expect(cfg.logoEtag).toBe(logoEtag);

    // GET serves the bytes with the right type + ETag.
    const get = await fetch(`${s.url}/api/cloud/workspace-logo`);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    expect((get.headers.get('etag') ?? '').replace(/"/g, '')).toBe(logoEtag);

    // If-None-Match short-circuits to 304.
    const not = await fetch(`${s.url}/api/cloud/workspace-logo`, {
      headers: { 'if-none-match': `"${logoEtag}"` },
    });
    expect(not.status).toBe(304);

    // Remove → GET 404, dbconfig null.
    const del = await fetch(`${s.url}/api/cloud/workspace-logo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logo: '' }),
    });
    expect(del.status).toBe(200);
    expect((await fetch(`${s.url}/api/cloud/workspace-logo`)).status).toBe(404);
    const cfg2 = (await fetch(`${s.url}/api/dbconfig`).then((r) => r.json())) as {
      logoEtag: string | null;
    };
    expect(cfg2.logoEtag).toBeNull();
  });

  it('rejects a non-square upload with 400', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `logo_${tag}`;
    schemas.push(schema);
    const s = await ownerServer(schema);
    const post = await fetch(`${s.url}/api/cloud/workspace-logo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logo: pngUri(64, 32) }),
    });
    expect(post.status).toBe(400);
  });

  it('a scoped member cannot set the logo (owner-only SECURITY DEFINER)', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `logo_${tag}`;
    const member = `lm_logo_${tag}`;
    schemas.push(schema);
    roles.push(member);
    const s = await ownerServer(schema);
    // Provision a member against the same schema via a fresh owner Lattice.
    const o = new Lattice(schemaUrl(schema), { encryptionKey: 'logo-test-key' });
    dbs.push(o);
    registerNativeEntities(o);
    await o.init();
    const pw = generateMemberPassword();
    await provisionMemberRole(o, member, pw);
    const M = memberPool(schema, member, pw);
    await expect(
      M.query(`SELECT lattice_set_cloud_setting('workspace_logo', $1)`, [pngUri(64, 64)]),
    ).rejects.toThrow(/only a cloud owner/i);
    // Sanity: the GUI server (owner) can still set it.
    expect(
      (
        await fetch(`${s.url}/api/cloud/workspace-logo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ logo: pngUri(32, 32) }),
        })
      ).status,
    ).toBe(200);
  });
});
