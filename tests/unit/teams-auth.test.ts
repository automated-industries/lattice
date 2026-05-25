import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { generateToken, hashToken, extractBearer } from '../../src/teams/server/auth.js';
import { Lattice } from '../../src/lattice.js';
import { CLOUD_INTERNAL_TABLE_DEFS } from '../../src/teams/internal-tables.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-teams-auth-'));
  dirs.push(dir);
  return dir;
}

function writeMinConfig(root: string): { configPath: string; outputDir: string } {
  const outputDir = join(root, 'context');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/cloud.db',
      '',
      'entities:',
      '  items:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text, required: true }',
      '    outputFile: items.md',
    ].join('\n'),
  );
  return { configPath, outputDir };
}

async function fetchStatus(url: string, init?: RequestInit): Promise<number> {
  const res = await fetch(url, init);
  // Drain body so the socket can close — fetch in node sometimes keeps it open.
  await res.text().catch(() => undefined);
  return res.status;
}

async function startCloud(): Promise<{ handle: GuiServerHandle; configPath: string }> {
  const { configPath, outputDir } = writeMinConfig(tempDir());
  const handle = await startGuiServer({
    configPath,
    outputDir,
    port: 0,
    host: '127.0.0.1',
    teamCloud: true,
    openBrowser: false,
  });
  servers.push(handle);
  return { handle, configPath };
}

async function seedUserAndToken(configPath: string): Promise<{ userId: string; rawToken: string }> {
  const db = new Lattice({ config: configPath });
  await db.init();
  for (const [name, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
    await db.defineLate(name, def);
  }
  const now = new Date().toISOString();
  const userId = await db.insert('__lattice_users', {
    email: 'alice@example.com',
    name: 'Alice',
    created_at: now,
    updated_at: now,
  });
  const { raw, hash } = generateToken();
  await db.insert('__lattice_api_tokens', {
    user_id: userId,
    token_hash: hash,
    name: 'test',
    created_at: now,
  });
  db.close();
  return { userId, rawToken: raw };
}

afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('teams auth — token helpers', () => {
  it('generateToken returns a `lat_` prefixed token whose hash matches hashToken', () => {
    const { raw, hash } = generateToken();
    expect(raw).toMatch(/^lat_[0-9a-f]{64}$/);
    expect(hashToken(raw)).toBe(hash);
  });

  it('two generated tokens differ', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  it('extractBearer parses a well-formed Authorization header', () => {
    const headers = { authorization: 'Bearer lat_abc123' };
    const req = { headers } as unknown as Parameters<typeof extractBearer>[0];
    expect(extractBearer(req)).toBe('lat_abc123');
  });

  it('extractBearer rejects missing, wrong-scheme, or wrong-prefix headers', () => {
    const cases = [
      {},
      { authorization: 'Basic lat_x' },
      { authorization: 'Bearer raw_no_prefix' },
      { authorization: 'Bearer ' },
    ];
    for (const headers of cases) {
      const req = { headers } as unknown as Parameters<typeof extractBearer>[0];
      expect(extractBearer(req)).toBeNull();
    }
  });
});

describe('teams auth — server mode', () => {
  it('registers cloud internal tables on boot', async () => {
    const { configPath } = await startCloud();

    // Open the underlying DB independently and confirm the tables exist
    // by querying them (no rows yet — just no schema error).
    const db = new Lattice({ config: configPath });
    await db.init();
    for (const [name, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
      await db.defineLate(name, def);
      const rows = await db.query(name, { limit: 1 });
      expect(rows).toEqual([]);
    }
    db.close();
  });

  it('returns 401 when no Authorization header is present', async () => {
    const { handle } = await startCloud();
    expect(await fetchStatus(`${handle.url}/api/entities`)).toBe(401);
  });

  it('returns 401 when bearer token does not match a stored hash', async () => {
    const { handle } = await startCloud();
    expect(
      await fetchStatus(`${handle.url}/api/entities`, {
        headers: { Authorization: 'Bearer lat_doesnotexist' },
      }),
    ).toBe(401);
  });

  it('returns 401 when Authorization scheme is wrong', async () => {
    const { handle } = await startCloud();
    expect(
      await fetchStatus(`${handle.url}/api/entities`, {
        headers: { Authorization: 'Token lat_abc' },
      }),
    ).toBe(401);
  });

  it('accepts requests with a valid bearer token', async () => {
    const { handle, configPath } = await startCloud();
    const { rawToken } = await seedUserAndToken(configPath);

    expect(
      await fetchStatus(`${handle.url}/api/entities`, {
        headers: { Authorization: `Bearer ${rawToken}` },
      }),
    ).toBe(200);
  });

  it('rejects revoked tokens', async () => {
    const { handle, configPath } = await startCloud();
    const { rawToken } = await seedUserAndToken(configPath);

    // Revoke the token via a fresh Lattice instance.
    const db = new Lattice({ config: configPath });
    await db.init();
    for (const [name, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
      await db.defineLate(name, def);
    }
    const tokens = await db.query('__lattice_api_tokens', {
      filters: [{ col: 'token_hash', op: 'eq', val: hashToken(rawToken) }],
    });
    const tokenId = (tokens[0] as { id: string }).id;
    await db.update('__lattice_api_tokens', tokenId, {
      revoked_at: new Date().toISOString(),
    });
    db.close();

    expect(
      await fetchStatus(`${handle.url}/api/entities`, {
        headers: { Authorization: `Bearer ${rawToken}` },
      }),
    ).toBe(401);
  });

  it('disables the database switcher in team-cloud mode', async () => {
    const { handle, configPath } = await startCloud();
    const { rawToken } = await seedUserAndToken(configPath);

    // Even with a valid token, /api/databases is 403 in team-cloud mode.
    expect(
      await fetchStatus(`${handle.url}/api/databases`, {
        headers: { Authorization: `Bearer ${rawToken}` },
      }),
    ).toBe(403);
  });
});
