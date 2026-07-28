import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { currentLatticeCloudCredential } from '../../src/gui/identity/model.js';
import {
  readLatticeCloudConfig,
  activeProviderKind,
  setOpenAiCompatConfig,
} from '../../src/gui/ai/provider-config.js';
import { clearClaudeOAuth } from '../helpers/claude-auth.js';

/**
 * Signing a device out has to cut that device's model access at once.
 *
 * The cloud account's model credential is a spendable token: it is minted from
 * the device session and charged to the account's balance. If it outlives the
 * sign-out, a signed-out device (or a copy of the token that left the machine)
 * keeps spending someone else's money until the token happens to expire. These
 * tests exercise the whole path over the GUI server against a stub account
 * service that also plays the metered proxy.
 *
 * The second half covers the other side of the same account: a session that is
 * signed in but has nothing left to spend is not a usable backend, and must not
 * be reported as connected.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const stubs: Server[] = [];
const ENV_KEYS = [
  'LATTICE_ROOT',
  'LATTICE_CONFIG_DIR',
  'LATTICE_ENCRYPTION_KEY',
  'LATTICE_IDENTITY_URL',
  'LATTICE_IDENTITY_MANIFEST',
  'LATTICE_MANAGED_MODEL_AUTH',
  'ANTHROPIC_API_KEY',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
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

const BEARER = 'lds_test_bearer';

interface StubState {
  /** Model tokens minted and still spendable. */
  live: Set<string>;
  minted: string[];
  sessionRevokes: number;
  /** Status the session-revoke endpoint answers with (200 = revoked). */
  revokeStatus: number;
  /** Status the balance endpoint answers with (200 = a readable balance). */
  balanceStatus: number;
  balanceCents: number;
  /** Requests the proxy accepted (a spend). */
  spends: number;
}

/**
 * A stub account service: the device sign-in handshake, the model-credential mint,
 * the session revoke, plus the metered proxy the minted token spends against
 * (mounted under /proxy on the same loopback origin).
 */
function startStub(overrides: Partial<StubState> = {}): Promise<{ base: string; s: StubState }> {
  const s: StubState = {
    live: new Set<string>(),
    minted: [],
    sessionRevokes: 0,
    revokeStatus: 200,
    balanceStatus: 200,
    balanceCents: 5_00,
    spends: 0,
    ...overrides,
  };
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const send = (code: number, body: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        if (url.pathname === '/api/device/start') {
          send(200, {
            requestId: 'req-1',
            requestSecret: 'secret-1',
            verifyUrl: 'http://account.example/device/approve?rid=req-1',
          });
          return;
        }
        if (url.pathname === '/api/device/exchange') {
          send(200, { token: BEARER, email: 'member@example.com', name: 'Member' });
          return;
        }
        // The background membership sync runs after a sign-in; this account owns
        // no workspaces, which is not what these tests are about.
        if (url.pathname === '/api/me/workspaces') {
          send(200, { workspaces: [] });
          return;
        }
        if (url.pathname === '/api/me/model-credential' && req.method === 'POST') {
          if (bearer !== BEARER) {
            send(401, { error: 'Unauthorized' });
            return;
          }
          const token = 'lat_model_' + String(s.minted.length + 1);
          s.minted.push(token);
          s.live.add(token);
          send(200, {
            token,
            proxyBaseUrl: `http://127.0.0.1:${String(port)}/proxy`,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          });
          return;
        }
        // Revoking the device session invalidates every credential minted from it.
        if (url.pathname === '/api/me/session' && req.method === 'DELETE') {
          if (bearer !== BEARER) {
            send(401, { error: 'Unauthorized' });
            return;
          }
          s.sessionRevokes++;
          if (s.revokeStatus === 200) s.live.clear();
          send(s.revokeStatus, s.revokeStatus === 200 ? { ok: true } : { error: 'revoke failed' });
          return;
        }
        // ── metered proxy ──
        if (url.pathname === '/proxy/v1/balance') {
          if (s.balanceStatus !== 200) {
            send(s.balanceStatus, { error: 'balance unavailable' });
            return;
          }
          send(200, {
            balance_cents: s.balanceCents,
            top_up_url: 'https://account.example/top-up',
          });
          return;
        }
        if (url.pathname === '/proxy/v1/messages') {
          if (!s.live.has(bearer)) {
            send(401, { error: 'this credential was revoked' });
            return;
          }
          s.spends++;
          send(200, { ok: true });
          return;
        }
        send(404, { error: 'not found' });
      });
    });
    let port = 0;
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      stubs.push(srv);
      resolve({ base: `http://127.0.0.1:${String(port)}`, s });
    });
  });
}

async function bootServer(): Promise<string> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-signout-'));
  dirs.push(base);
  process.env.LATTICE_ROOT = join(base, '.lattice');
  process.env.LATTICE_CONFIG_DIR = join(base, '.config-store');
  process.env.LATTICE_ENCRYPTION_KEY = 'signout-test-key';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LATTICE_MANAGED_MODEL_AUTH;
  // No Claude subscription: the cloud account is the ONLY backend, so `connected`
  // reflects it alone.
  clearClaudeOAuth();
  const root = ensureLatticeRoot(base);
  const ws = addWorkspace(root, { displayName: 'Signout' });
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
  return `http://127.0.0.1:${String(server.port)}`;
}

/** Sign in over the loopback hand-back and activate the cloud model credential. */
async function signInAndActivate(origin: string): Promise<void> {
  await fetch(`${origin}/api/identity/signin/start`, { method: 'POST' });
  const cb = await fetch(`${origin}/lattice/device-code?rid=req-1&code=code-1`);
  expect(cb.status).toBe(200);
  const act = await fetch(`${origin}/api/assistant/provider/lattice-cloud`, { method: 'POST' });
  expect(((await act.json()) as { ok?: boolean }).ok).toBe(true);
}

/** Try to spend the token against the stub proxy. */
async function spend(base: string, token: string): Promise<number> {
  const r = await fetch(`${base}/proxy/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  return r.status;
}

describe('signing a device out revokes its model credential', () => {
  it('kills the minted token locally AND at the service — a leaked copy stops spending', async () => {
    const stub = await startStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    const origin = await bootServer();
    await signInAndActivate(origin);

    // The device holds a spendable token, and it spends.
    const minted = readLatticeCloudConfig();
    expect(minted?.token).toBe('lat_model_1');
    expect(await spend(stub.base, minted!.token)).toBe(200);
    expect(stub.s.spends).toBe(1);

    const out = (await (
      await fetch(`${origin}/api/identity/signout`, { method: 'POST' })
    ).json()) as { ok?: boolean; modelAccess?: string; error?: string | null };
    expect(out.ok).toBe(true);
    expect(out.modelAccess).toBe('revoked');
    expect(stub.s.sessionRevokes).toBe(1);

    // 1. The device no longer holds a credential and cannot resolve one.
    expect(readLatticeCloudConfig()).toBeNull();
    expect(await currentLatticeCloudCredential()).toBeNull();
    expect(activeProviderKind()).toBe('anthropic');

    // 2. The token that already left the machine is dead at the proxy.
    expect(await spend(stub.base, minted!.token)).toBe(401);
    expect(stub.s.spends).toBe(1); // no further spend landed

    // 3. The server's own view agrees: nothing is connected any more.
    const cfg = (await (await fetch(`${origin}/api/assistant/config`)).json()) as {
      connected?: boolean;
      latticeCloud?: { configured?: boolean };
    };
    expect(cfg.latticeCloud?.configured).toBe(false);
    expect(cfg.connected).toBe(false);
  });

  it('reports honestly when the service will not confirm the revoke', async () => {
    // The local credential is destroyed either way — but claiming the account-side
    // token was revoked when the service refused would hide a live credential.
    const stub = await startStub({ revokeStatus: 500 });
    process.env.LATTICE_IDENTITY_URL = stub.base;
    const origin = await bootServer();
    await signInAndActivate(origin);
    const minted = readLatticeCloudConfig();

    const res = await fetch(`${origin}/api/identity/signout`, { method: 'POST' });
    const out = (await res.json()) as { ok?: boolean; modelAccess?: string; error?: string | null };
    expect(res.status).toBe(200); // the device IS signed out; that part is true
    expect(out.modelAccess).toBe('not-confirmed');
    expect(out.error ?? '').toMatch(/revok/i);

    // Local access is gone regardless.
    expect(readLatticeCloudConfig()).toBeNull();
    expect(await currentLatticeCloudCredential()).toBeNull();
    // And the still-live token is NOT reported as revoked — the stub still honors it.
    expect(await spend(stub.base, minted!.token)).toBe(200);
  });

  it('does not move a user off their own endpoint when no cloud model was in use', async () => {
    const stub = await startStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    const origin = await bootServer();
    await fetch(`${origin}/api/identity/signin/start`, { method: 'POST' });
    await fetch(`${origin}/lattice/device-code?rid=req-1&code=code-1`);
    // The user's own OpenAI-compatible endpoint is the active backend.
    setOpenAiCompatConfig({ baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'm' });
    expect(activeProviderKind()).toBe('openai_compat');

    await fetch(`${origin}/api/identity/signout`, { method: 'POST' });
    expect(activeProviderKind()).toBe('openai_compat');
  });
});

describe('a signed-in account with no balance left is not connected', () => {
  it('reports connected:false with the reason, so boot can route to top-up', async () => {
    const stub = await startStub({ balanceCents: 0 });
    process.env.LATTICE_IDENTITY_URL = stub.base;
    const origin = await bootServer();
    await signInAndActivate(origin);

    const cfg = (await (await fetch(`${origin}/api/assistant/config`)).json()) as {
      connected?: boolean;
      modelAccessBlocked?: string | null;
      balanceCents?: number | null;
      balanceUnavailable?: boolean;
      topUpUrl?: string | null;
      latticeCloud?: { configured?: boolean };
    };
    expect(cfg.latticeCloud?.configured).toBe(true); // the account IS signed in
    expect(cfg.balanceCents).toBe(0);
    expect(cfg.balanceUnavailable).toBe(false);
    expect(cfg.topUpUrl).toBe('https://account.example/top-up');
    // …but every turn would fail, so the app must not boot as if it were usable.
    expect(cfg.connected).toBe(false);
    expect(cfg.modelAccessBlocked).toBe('cloud_balance_exhausted');
  });

  it('an UNREADABLE balance is not treated as an empty one', async () => {
    // Unknown is not zero: a proxy hiccup must not lock a paid-up account out of
    // its own app. It is reported as unreadable so the menu can say so.
    const stub = await startStub({ balanceStatus: 500 });
    process.env.LATTICE_IDENTITY_URL = stub.base;
    const origin = await bootServer();
    await signInAndActivate(origin);

    const cfg = (await (await fetch(`${origin}/api/assistant/config`)).json()) as {
      connected?: boolean;
      modelAccessBlocked?: string | null;
      balanceCents?: number | null;
      balanceUnavailable?: boolean;
    };
    expect(cfg.balanceCents).toBeNull();
    expect(cfg.balanceUnavailable).toBe(true);
    expect(cfg.connected).toBe(true);
    expect(cfg.modelAccessBlocked).toBeNull();
  });

  it('still counts as connected while there is a balance to spend', async () => {
    const stub = await startStub({ balanceCents: 250 });
    process.env.LATTICE_IDENTITY_URL = stub.base;
    const origin = await bootServer();
    await signInAndActivate(origin);
    const cfg = (await (await fetch(`${origin}/api/assistant/config`)).json()) as {
      connected?: boolean;
      modelAccessBlocked?: string | null;
    };
    expect(cfg.connected).toBe(true);
    expect(cfg.modelAccessBlocked).toBeNull();
  });
});
