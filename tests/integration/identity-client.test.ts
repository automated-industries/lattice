import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Lattice,
  ensureLatticeRoot,
  addWorkspace,
  resolveWorkspacePaths,
} from '../../src/index.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { resetIdentityDiscovery } from '../../src/gui/identity/service.js';
import { resetPendingSignIn } from '../../src/gui/identity/routes.js';
import {
  clearIdentitySession,
  readIdentitySession,
  writeIdentitySession,
} from '../../src/gui/identity/store.js';
import { syncMemberships } from '../../src/gui/identity/sync.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';

/**
 * The workspace-identity client, provider-generic: sign-in handshake, encrypted
 * session store, membership sync, and managed-workspace mode. A stub identity
 * service / workspace manager stands in for any real deployment.
 */

const dirs: string[] = [];
const dbs: Lattice[] = [];
const servers: GuiServerHandle[] = [];
const stubs: Server[] = [];
const ENV_KEYS = [
  'LATTICE_ROOT',
  'LATTICE_CONFIG_DIR',
  'LATTICE_ENCRYPTION_KEY',
  'LATTICE_IDENTITY_URL',
  'LATTICE_IDENTITY_MANIFEST',
  'LATTICE_MANAGED_WORKSPACES_URL',
  'ANTHROPIC_API_KEY',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const db of dbs.splice(0)) db.close();
  for (const s of stubs.splice(0)) await new Promise((r) => s.close(r));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  resetIdentityDiscovery();
  resetPendingSignIn();
});

function isolateConfig(): string {
  const base = mkdtempSync(join(tmpdir(), 'lattice-identity-'));
  dirs.push(base);
  process.env.LATTICE_CONFIG_DIR = join(base, '.config-store');
  return base;
}

/** A stub identity service implementing start/exchange/workspaces/credential. */
function startIdentityStub(opts?: {
  credentialUrl?: string;
  reject401?: boolean;
}): Promise<{ base: string; state: { exchanges: number; credentialCalls: number } }> {
  const state = { exchanges: 0, credentialCalls: 0 };
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const send = (code: number, body: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        if (url.pathname === '/api/device/start') {
          send(200, {
            requestId: 'req-1',
            requestSecret: 'secret-1',
            verifyUrl: 'http://identity.example/device/approve?rid=req-1',
            expiresInSeconds: 900,
          });
          return;
        }
        if (url.pathname === '/api/device/exchange') {
          const body = JSON.parse(raw || '{}') as Record<string, string>;
          state.exchanges++;
          if (
            body.requestId === 'req-1' &&
            body.requestSecret === 'secret-1' &&
            body.code === 'code-1'
          ) {
            send(200, { token: 'lds_test_bearer', email: 'member@example.com', name: 'Member' });
          } else {
            send(400, { error: 'invalid code' });
          }
          return;
        }
        if (url.pathname === '/api/me/workspaces') {
          if (opts?.reject401) {
            send(401, { error: 'Unauthorized' });
            return;
          }
          send(200, {
            workspaces: [
              {
                id: 'acct-1',
                name: 'Team Alpha',
                status: 'active',
                membershipId: 'mem-1',
                role: 'member',
                membershipStatus: 'active',
              },
              {
                id: 'acct-2',
                name: 'Old Team',
                status: 'active',
                membershipId: 'mem-2',
                role: 'member',
                membershipStatus: 'revoked',
              },
            ],
          });
          return;
        }
        if (url.pathname === '/api/me/workspaces/acct-1/credential') {
          state.credentialCalls++;
          send(200, {
            connUrl: opts?.credentialUrl ?? 'postgres://member:pw@127.0.0.1:1/tenant',
            role: 'member',
            workspaceName: 'Team Alpha',
          });
          return;
        }
        send(404, { error: 'not found' });
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      stubs.push(srv);
      resolve({ base: `http://127.0.0.1:${String(port)}`, state });
    });
  });
}

describe('identity session store', () => {
  it('round-trips encrypted — the bearer never touches disk in plaintext', () => {
    const base = isolateConfig();
    writeIdentitySession({
      token: 'lds_super_secret',
      email: 'me@example.com',
      name: 'Me',
      serviceBase: 'http://identity.example',
      linkedAt: '2026-01-01T00:00:00Z',
      materialized: { 'mem-1': 'ws-1' },
      revoked: [],
    });
    const back = readIdentitySession();
    expect(back?.token).toBe('lds_super_secret');
    expect(back?.email).toBe('me@example.com');
    expect(back?.materialized).toEqual({ 'mem-1': 'ws-1' });
    // Encrypted at rest: no file under the config dir contains the raw bearer.
    const cfgDir = process.env.LATTICE_CONFIG_DIR ?? '';
    for (const f of readdirSync(cfgDir)) {
      const content = readFileSync(join(cfgDir, f), 'utf8');
      expect(content).not.toContain('lds_super_secret');
      expect(content).not.toContain('me@example.com');
    }
    clearIdentitySession();
    expect(readIdentitySession()).toBeNull();
    void base;
  });
});

describe('membership sync', () => {
  function linkSession(serviceBase: string): void {
    writeIdentitySession({
      token: 'lds_test_bearer',
      email: 'member@example.com',
      name: 'Member',
      serviceBase,
      linkedAt: new Date().toISOString(),
      materialized: {},
      revoked: [],
    });
  }

  it('materializes an active membership exactly once and surfaces revoked ones', async () => {
    isolateConfig();
    const stub = await startIdentityStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    linkSession(stub.base);
    const created: string[] = [];
    const deps = {
      createCloudWorkspace: (name: string): Promise<string> => {
        created.push(name);
        return Promise.resolve('ws-' + String(created.length));
      },
      probeCloud: () => Promise.resolve({ reachable: true, isCloud: true }),
    };
    const first = await syncMemberships(deps);
    expect(first.linked).toBe(true);
    expect(first.added).toEqual([{ workspaceId: 'ws-1', name: 'Team Alpha' }]);
    expect(first.revoked).toEqual(['Old Team']); // surfaced, never silently hidden
    // Idempotent: the second sync creates nothing new.
    const second = await syncMemberships(deps);
    expect(second.added).toEqual([]);
    expect(second.skipped).toBe(1);
    expect(created).toEqual(['Team Alpha']);
    expect(stub.state.credentialCalls).toBe(1); // no re-issuance for materialized rows
  });

  it('an unreachable tenant collects an error and does not abort the sync', async () => {
    isolateConfig();
    const stub = await startIdentityStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    linkSession(stub.base);
    const result = await syncMemberships({
      createCloudWorkspace: () => Promise.resolve('ws-x'),
      probeCloud: () => Promise.resolve({ reachable: false, isCloud: false, error: 'refused' }),
    });
    expect(result.added).toEqual([]);
    expect(result.errors.join(' ')).toContain('refused');
  });

  it('a 401 clears the session and reports it as expired — never a silent no-op', async () => {
    isolateConfig();
    const stub = await startIdentityStub({ reject401: true });
    process.env.LATTICE_IDENTITY_URL = stub.base;
    linkSession(stub.base);
    const result = await syncMemberships({
      createCloudWorkspace: () => Promise.resolve('ws-x'),
      probeCloud: () => Promise.resolve({ reachable: true, isCloud: true }),
    });
    expect(result.sessionExpired).toBe(true);
    expect(readIdentitySession()).toBeNull();
  });
});

describe('identity + managed routes over the GUI server', () => {
  async function bootServer(): Promise<{ origin: string; base: string }> {
    const base = mkdtempSync(join(tmpdir(), 'lattice-identity-srv-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    process.env.LATTICE_CONFIG_DIR = join(base, '.config-store');
    process.env.LATTICE_ENCRYPTION_KEY = 'identity-test-key';
    delete process.env.ANTHROPIC_API_KEY;
    seedClaudeOAuth();
    const root = ensureLatticeRoot(base);
    const ws = addWorkspace(root, { displayName: 'Identity' });
    (await Lattice.openWorkspace({ root, workspaceId: ws.id })).close();
    const paths = resolveWorkspacePaths(root, ws);
    const server = await startGuiServer({
      configPath: paths.configPath,
      outputDir: paths.contextDir,
      latticeRoot: root,
      port: 0,
      openBrowser: false,
    });
    servers.push(server);
    return { origin: `http://127.0.0.1:${String(server.port)}`, base };
  }

  it('start → loopback device-code → status shows the linked identity', async () => {
    const stub = await startIdentityStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    const { origin } = await bootServer();

    const start = (await (
      await fetch(`${origin}/api/identity/signin/start`, { method: 'POST' })
    ).json()) as { ok?: boolean; verifyUrl?: string };
    expect(start.ok).toBe(true);
    expect(start.verifyUrl).toContain('rid=req-1');

    // The browser hands the one-time code back over the loopback.
    const cb = await fetch(`${origin}/lattice/device-code?rid=req-1&code=code-1`);
    expect(cb.status).toBe(200);
    expect(((await cb.json()) as { email?: string }).email).toBe('member@example.com');

    const status = (await (await fetch(`${origin}/api/identity/status`)).json()) as {
      linked?: boolean;
      email?: string;
    };
    expect(status.linked).toBe(true);
    expect(status.email).toBe('member@example.com');

    // Sign out reverts cleanly.
    await fetch(`${origin}/api/identity/signout`, { method: 'POST' });
    const after = (await (await fetch(`${origin}/api/identity/status`)).json()) as {
      linked?: boolean;
    };
    expect(after.linked).toBe(false);
  });

  it('a wrong or replayed loopback code is refused', async () => {
    const stub = await startIdentityStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    const { origin } = await bootServer();
    await fetch(`${origin}/api/identity/signin/start`, { method: 'POST' });
    const bad = await fetch(`${origin}/lattice/device-code?rid=req-1&code=WRONG`);
    expect(bad.status).toBe(400);
    // No session was stored.
    const status = (await (await fetch(`${origin}/api/identity/status`)).json()) as {
      linked?: boolean;
    };
    expect(status.linked).toBe(false);
  });

  it('managed mode: /api/cloud/invite is refused — no shadow member can be minted (6b)', async () => {
    process.env.LATTICE_MANAGED_WORKSPACES_URL = 'http://127.0.0.1:9/managed/tok';
    const { origin } = await bootServer();
    const res = await fetch(`${origin}/api/cloud/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? '').toContain('managed');
  });

  it('managed proxy forwards invite/members/create to the manager verbatim', async () => {
    // A stub manager records what it was asked.
    const calls: { path: string; body: unknown }[] = [];
    const manager = await new Promise<{ base: string }>((resolve) => {
      const srv = createServer((req, res) => {
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString()));
        req.on('end', () => {
          calls.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : null });
          res.writeHead(200, { 'content-type': 'application/json' });
          if ((req.url ?? '').endsWith('/members')) {
            res.end(
              JSON.stringify({
                members: [
                  { id: 'mem-1', email: 'o@example.com', role: 'owner', status: 'active' },
                  { id: 'mem-2', email: 'i@example.com', role: 'member', status: 'invited' },
                ],
              }),
            );
          } else {
            res.end(JSON.stringify({ ok: true }));
          }
        });
      });
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        stubs.push(srv);
        resolve({
          base: `http://127.0.0.1:${String(typeof addr === 'object' && addr ? addr.port : 0)}`,
        });
      });
    });
    process.env.LATTICE_MANAGED_WORKSPACES_URL = `${manager.base}/managed/tok`;
    const { origin } = await bootServer();

    const inv = await fetch(`${origin}/api/cloud/managed/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    expect(inv.status).toBe(200);
    const members = (await (await fetch(`${origin}/api/cloud/managed/members`)).json()) as {
      members?: { status: string }[];
    };
    // Pending INVITED rows are visible — the thing the token flow could never show.
    expect(members.members?.some((m) => m.status === 'invited')).toBe(true);
    await fetch(`${origin}/api/cloud/managed/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New WS' }),
    });
    expect(calls.map((c) => c.path)).toEqual([
      '/managed/tok/invite',
      '/managed/tok/members',
      '/managed/tok/create',
    ]);
    expect(calls[0]?.body).toEqual({ email: 'new@example.com' });
  });

  it('without the seam, managed routes 404 and the config payload omits the mode', async () => {
    delete process.env.LATTICE_MANAGED_WORKSPACES_URL;
    const { origin } = await bootServer();
    const res = await fetch(`${origin}/api/cloud/managed/members`);
    expect(res.status).toBe(404);
    const cfg = (await (await fetch(`${origin}/api/assistant/config`)).json()) as {
      managedWorkspaces?: boolean;
    };
    expect(cfg.managedWorkspaces).toBe(false);
  });
});
