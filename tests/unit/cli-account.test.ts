import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readAccountStatus,
  pendingAccountSignIn,
  startAccountSignIn,
  completeAccountSignIn,
  signOutAccount,
  syncAccountMemberships,
  listManagedMembers,
  inviteToManagedWorkspace,
  revokeManagedMembership,
  createManagedWorkspace,
} from '../../src/ops/account.js';
import { accountErrorCode } from '../../src/ops/account-errors.js';
import { runAccountCommand, formatAccountStatus, formatSyncResult } from '../../src/cli-account.js';
import { resetIdentityDiscovery } from '../../src/gui/identity/service.js';
import {
  readIdentitySession,
  readPendingSignIn,
  writePendingSignIn,
  PENDING_SIGNIN_TTL_MS,
} from '../../src/gui/identity/store.js';
import { readIdentity } from '../../src/framework/user-config.js';

/**
 * Signing a machine in to an account, with no browser on it.
 *
 * The claim under test is not "a command exists". It is that the handshake can be
 * STARTED in one run and FINISHED in another — which is the only shape that works
 * on a machine nobody is sitting at, and the shape a module-level variable cannot
 * support. So the central test starts a sign-in, throws away every module this
 * process has loaded, and finishes it from a fresh one. If the half-finished
 * handshake ever moves back into memory, that test fails and no other one does.
 *
 * Everything runs against a throwaway config directory and stub services, so
 * nothing here can see or touch the machine's real account, and nothing leaves
 * the loopback.
 */

const dirs: string[] = [];
const stubs: Server[] = [];
const ENV_KEYS = [
  'LATTICE_ROOT',
  'LATTICE_CONFIG_DIR',
  'LATTICE_ENCRYPTION_KEY',
  'LATTICE_IDENTITY_URL',
  'LATTICE_IDENTITY_MANIFEST',
  'LATTICE_MANAGED_WORKSPACES_URL',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    Reflect.deleteProperty(process.env, k);
  }
  const base = mkdtempSync(join(tmpdir(), 'lattice-account-cli-'));
  dirs.push(base);
  process.env.LATTICE_CONFIG_DIR = join(base, '.config-store');
  process.env.LATTICE_ENCRYPTION_KEY = 'account-cli-test-key';
  // Discovery must never fall through to a real manifest fetch.
  process.env.LATTICE_IDENTITY_MANIFEST = 'http://127.0.0.1:1/nowhere';
  resetIdentityDiscovery();
});

afterEach(async () => {
  for (const s of stubs.splice(0)) await new Promise((r) => s.close(r));
  resetIdentityDiscovery();
  // Config dir first, env after: a cleanup that restored the environment before
  // touching the store would be operating on the developer's real one.
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

/** The one-time code the approval page hands a person, in these tests. */
const APPROVED_CODE = 'code-1';

interface StubState {
  starts: number;
  exchanges: number;
  sessionRevokes: number;
}

/** A stub account service: start / exchange / workspaces / credential / session. */
function startAccountStub(opts?: {
  workspaces?: unknown[];
  refuseRevoke?: boolean;
}): Promise<{ base: string; state: StubState }> {
  const state: StubState = { starts: 0, exchanges: 0, sessionRevokes: 0 };
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const send = (code: number, body: unknown): void => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (path === '/api/device/start') {
          state.starts++;
          send(200, {
            requestId: 'req-1',
            requestSecret: 'secret-1',
            verifyUrl: 'https://accounts.example/device/approve?rid=req-1',
            expiresInSeconds: 900,
          });
          return;
        }
        if (path === '/api/device/exchange') {
          state.exchanges++;
          const body = JSON.parse(raw || '{}') as Record<string, string>;
          if (
            body.requestId === 'req-1' &&
            body.requestSecret === 'secret-1' &&
            body.code === APPROVED_CODE
          ) {
            send(200, { token: 'lds_test_bearer', email: 'ops@example.com', name: 'Ops' });
          } else {
            send(400, { error: 'invalid code' });
          }
          return;
        }
        if (path === '/api/me/workspaces') {
          send(200, { workspaces: opts?.workspaces ?? [] });
          return;
        }
        if (path === '/api/me/session') {
          state.sessionRevokes++;
          if (opts?.refuseRevoke) send(500, { error: 'revoke failed' });
          else send(200, { ok: true });
          return;
        }
        if (/^\/api\/me\/workspaces\/[^/]+\/credential$/.test(path)) {
          send(200, {
            connUrl: 'postgres://member:pw@127.0.0.1:1/tenant',
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

/** A stub workspace manager: records what it was asked, answers plainly. */
function startManagerStub(opts?: {
  refuse?: string;
}): Promise<{ base: string; calls: { path: string; body: unknown }[] }> {
  const calls: { path: string; body: unknown }[] = [];
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        calls.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : null });
        if (opts?.refuse) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: opts.refuse }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        if ((req.url ?? '').endsWith('/members')) {
          res.end(
            JSON.stringify({
              members: [
                { id: 'mem-1', email: 'owner@example.com', role: 'owner', status: 'active' },
                { id: 'mem-2', email: 'invitee@example.com', role: 'member', status: 'invited' },
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
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      stubs.push(srv);
      resolve({ base: `http://127.0.0.1:${String(port)}`, calls });
    });
  });
}

describe('signing in without a browser on this machine', () => {
  it('starts in one run and finishes in another, with nothing kept in memory between', async () => {
    // The whole point. `vi.resetModules()` throws away every module instance this
    // process has loaded, so the second half runs against freshly-imported code
    // with no variables surviving from the first — the closest a single process
    // gets to being a second `lattice` invocation. A handshake held in a
    // module-level variable cannot survive it, which is exactly why it is here.
    const stub = await startAccountStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;

    const started = await runAccountCommand({ subcommand: 'signin' });
    expect(started.join('\n')).toContain('https://accounts.example/device/approve?rid=req-1');
    expect(stub.state.starts).toBe(1);

    vi.resetModules();
    const fresh = await import('../../src/cli-account.js');
    const done = await fresh.runAccountCommand({ subcommand: 'code', action: APPROVED_CODE });

    expect(done).toEqual(['Signed in as ops@example.com (Ops).']);
    expect(readIdentitySession()?.email).toBe('ops@example.com');
    expect(stub.state.exchanges).toBe(1);
  });

  it('reads the code from standard input, so it stays out of argv and shell history', async () => {
    const stub = await startAccountStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    await startAccountSignIn();

    const lines = await runAccountCommand({
      subcommand: 'code',
      codeStdin: true,
      readStdin: () => Promise.resolve(`  ${APPROVED_CODE}\n`),
    });
    expect(lines[0]).toContain('Signed in as ops@example.com');
  });

  it('adopts the account identity where the machine had none, so writes are attributed', async () => {
    const stub = await startAccountStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    await startAccountSignIn();
    await completeAccountSignIn(APPROVED_CODE);

    expect(readIdentity().email).toBe('ops@example.com');
    expect(readIdentity().display_name).toBe('Ops');
  });

  it('keeps the half-finished handshake encrypted — the request secret never hits disk in the clear', async () => {
    const stub = await startAccountStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    await startAccountSignIn();

    expect(readPendingSignIn()?.requestSecret).toBe('secret-1');
    const cfgDir = process.env.LATTICE_CONFIG_DIR ?? '';
    for (const f of readdirSync(cfgDir)) {
      expect(readFileSync(join(cfgDir, f), 'utf8')).not.toContain('secret-1');
    }
  });

  it('refuses to finish a sign-in that was never started', async () => {
    const stub = await startAccountStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    await expect(completeAccountSignIn(APPROVED_CODE)).rejects.toMatchObject({
      code: 'no_signin_in_progress',
    });
    expect(stub.state.exchanges, 'nothing was sent to the service').toBe(0);
  });

  it('an abandoned sign-in expires rather than leaving a usable secret behind', async () => {
    const stub = await startAccountStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    const pending = (await startAccountSignIn(), readPendingSignIn());
    expect(pending).not.toBeNull();

    // Age it past the window the store allows.
    writePendingSignIn({ ...pending!, startedAt: Date.now() - PENDING_SIGNIN_TTL_MS - 1000 });
    expect(readPendingSignIn(), 'an expired attempt reads as no attempt').toBeNull();
    await expect(completeAccountSignIn(APPROVED_CODE)).rejects.toMatchObject({
      code: 'no_signin_in_progress',
    });
  });

  it('says "no service" when there is none to find, rather than failing some other way', async () => {
    // No direct base, and the discovery manifest points at nothing that answers.
    // There is no failing leg to name here — nobody was ever reached.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(startAccountSignIn()).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(readPendingSignIn(), 'no half-started attempt was recorded').toBeNull();
  });

  it('a service that is found but does not answer keeps the leg it failed at', async () => {
    // The opposite case, and the reason the two are not one code: a reachable-but-
    // broken service has a step to name, and flattening it to "unavailable" would
    // throw away the only thing that makes a report diagnosable.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.LATTICE_IDENTITY_URL = 'http://127.0.0.1:1'; // nothing listening
    const err = await startAccountSignIn().then(
      () => null,
      (e: unknown) => e,
    );
    expect(accountErrorCode(err), 'not one of ours — it belongs to the sign-in client').toBe(
      undefined,
    );
    expect((err as { step?: string }).step).toBe('start');
    expect(readPendingSignIn()).toBeNull();
  });

  it('reports what is waiting, so a stuck sign-in is distinguishable from no sign-in', async () => {
    const stub = await startAccountStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    expect(pendingAccountSignIn()).toBeNull();
    await startAccountSignIn();
    expect(pendingAccountSignIn()?.requestId).toBe('req-1');

    const lines = formatAccountStatus(await readAccountStatus(), pendingAccountSignIn());
    expect(lines.join('\n')).toContain('waiting for its code');
    expect(lines.join('\n'), 'the secret is not something to print').not.toContain('secret-1');
  });
});

describe('signing out', () => {
  it('revokes at the service, and forgets the sign-in that was still in flight', async () => {
    const stub = await startAccountStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    await startAccountSignIn();
    await completeAccountSignIn(APPROVED_CODE);
    await startAccountSignIn(); // a second attempt, left half-finished

    const lines = await runAccountCommand({ subcommand: 'signout' });
    expect(lines[0]).toContain('Signed out');
    expect(stub.state.sessionRevokes, 'the service was told to kill the session').toBe(1);
    expect(readIdentitySession()).toBeNull();
    expect(readPendingSignIn(), 'a pending attempt would still be exchangeable').toBeNull();
  });

  it('signing out when nothing is signed in calls nothing and claims nothing', async () => {
    // No session means nothing was ever minted against one, so there is no
    // account-side credential to kill — and no call to make.
    const stub = await startAccountStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    expect(await signOutAccount()).toEqual({ revoked: true });
    expect(stub.state.sessionRevokes).toBe(0);
  });

  it('fails loudly when the service will not confirm the revoke', async () => {
    // The device is signed out locally either way — but a token that already left
    // the machine may still be spending, and a zero exit code would say otherwise.
    const stub = await startAccountStub({ refuseRevoke: true });
    process.env.LATTICE_IDENTITY_URL = stub.base;
    await startAccountSignIn();
    await completeAccountSignIn(APPROVED_CODE);

    await expect(runAccountCommand({ subcommand: 'signout' })).rejects.toThrow(
      /did not confirm|could not be reached/i,
    );
    expect(readIdentitySession(), 'local sign-out still happened').toBeNull();
  });
});

describe('pulling down the workspaces an account was invited to', () => {
  it('materializes an active membership and reports a revoked one', async () => {
    const stub = await startAccountStub({
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
    process.env.LATTICE_IDENTITY_URL = stub.base;
    await startAccountSignIn();
    await completeAccountSignIn(APPROVED_CODE);

    const created: string[] = [];
    const result = await syncAccountMemberships({
      createCloudWorkspace: (name) => {
        created.push(name);
        return Promise.resolve('ws-1');
      },
      probeCloud: () => Promise.resolve({ reachable: true, isCloud: true }),
    });
    expect(created).toEqual(['Team Alpha']);
    expect(result.added).toEqual([{ workspaceId: 'ws-1', name: 'Team Alpha' }]);
    expect(result.revoked).toEqual(['Old Team']);
    expect(formatSyncResult(result).join('\n')).toContain('Access revoked: Old Team');
  });

  it('exits non-zero when a membership did not arrive, carrying the whole report', async () => {
    // The credential points at a port nothing is listening on, so the real probe
    // refuses it. A command that printed "no new workspaces" and exited zero would
    // be reporting a clean pass over a failed one.
    const stub = await startAccountStub({
      workspaces: [
        {
          id: 'acct-1',
          name: 'Team Alpha',
          status: 'active',
          membershipId: 'mem-1',
          role: 'member',
          membershipStatus: 'active',
        },
      ],
    });
    process.env.LATTICE_IDENTITY_URL = stub.base;
    await startAccountSignIn();
    await completeAccountSignIn(APPROVED_CODE);

    await expect(runAccountCommand({ subcommand: 'sync' })).rejects.toThrow(
      /Some memberships did not arrive[\s\S]*Team Alpha/,
    );
  });

  it('says to sign in first rather than reporting an empty success', async () => {
    const lines = await runAccountCommand({ subcommand: 'sync' });
    expect(lines[0]).toContain('Not signed in');
  });
});

describe('administering a hosted workspace from a command line', () => {
  it('forwards members, invite, revoke, and create to the workspace manager', async () => {
    const manager = await startManagerStub();
    process.env.LATTICE_MANAGED_WORKSPACES_URL = `${manager.base}/managed/tok`;

    const listed = await runAccountCommand({ subcommand: 'members' });
    expect(listed).toEqual([
      'owner@example.com — owner (active)',
      'invitee@example.com — member (invited)',
    ]);
    expect(await runAccountCommand({ subcommand: 'invite', email: 'new@example.com' })).toEqual([
      'Invited new@example.com.',
    ]);
    expect(await runAccountCommand({ subcommand: 'revoke', action: 'mem-2' })).toEqual([
      'Removed membership mem-2.',
    ]);
    expect(
      await runAccountCommand({ subcommand: 'create-workspace', displayName: 'New WS' }),
    ).toEqual(['Created hosted workspace "New WS".']);

    expect(manager.calls.map((c) => c.path)).toEqual([
      '/managed/tok/members',
      '/managed/tok/invite',
      '/managed/tok/revoke',
      '/managed/tok/create',
    ]);
    expect(manager.calls[1]?.body).toEqual({ email: 'new@example.com' });
    expect(manager.calls[2]?.body).toEqual({ membershipId: 'mem-2' });
    expect(manager.calls[3]?.body).toEqual({ name: 'New WS' });
  });

  it("passes the manager's own refusal through instead of inventing one", async () => {
    const manager = await startManagerStub({ refuse: 'Member limit reached.' });
    process.env.LATTICE_MANAGED_WORKSPACES_URL = `${manager.base}/managed/tok`;
    await expect(inviteToManagedWorkspace('new@example.com')).rejects.toThrow(
      'Member limit reached.',
    );
  });

  it('refuses plainly where there is no manager, without calling anything', async () => {
    for (const call of [
      () => listManagedMembers(),
      () => inviteToManagedWorkspace('a@example.com'),
      () => revokeManagedMembership('mem-1'),
      () => createManagedWorkspace('WS'),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'not_managed' });
    }
    await expect(runAccountCommand({ subcommand: 'members' })).rejects.toThrow(
      /No workspace manager/,
    );
  });

  it('refuses an empty invite before it reaches the network', async () => {
    const manager = await startManagerStub();
    process.env.LATTICE_MANAGED_WORKSPACES_URL = `${manager.base}/managed/tok`;
    await expect(inviteToManagedWorkspace('   ')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(manager.calls, 'nothing was sent').toEqual([]);
  });
});

describe('the command surface itself', () => {
  it('rejects an unknown verb by name, listing the ones that exist', async () => {
    await expect(runAccountCommand({ subcommand: 'teleport' })).rejects.toThrow(
      /Unknown account subcommand: teleport/,
    );
  });

  it('refuses --json on a verb with nothing to parse rather than ignoring it', async () => {
    await expect(runAccountCommand({ subcommand: 'signout', json: true })).rejects.toThrow(
      /--json applies to/,
    );
  });

  it('reports status as data when asked for data', async () => {
    const parsed = JSON.parse(
      (await runAccountCommand({ subcommand: 'status', json: true }))[0] ?? '{}',
    ) as { linked: boolean; pendingSignIn: unknown };
    expect(parsed.linked).toBe(false);
    expect(parsed.pendingSignIn).toBeNull();
  });

  it('every verb that names something refuses to run without it', async () => {
    for (const args of [
      { subcommand: 'code' },
      { subcommand: 'invite' },
      { subcommand: 'revoke' },
      { subcommand: 'create-workspace' },
    ]) {
      const err = await runAccountCommand(args).then(
        () => null,
        (e: unknown) => e,
      );
      expect(accountErrorCode(err), `${args.subcommand} should refuse`).toBe('invalid_request');
      expect((err as Error).message).toContain('Usage: lattice account');
    }
  });
});

describe('a corrupt pending file is a fact, not a silent "no sign-in"', () => {
  it('warns and reports nothing waiting, rather than pretending it was never started', async () => {
    const stub = await startAccountStub();
    process.env.LATTICE_IDENTITY_URL = stub.base;
    await startAccountSignIn();

    const cfgDir = process.env.LATTICE_CONFIG_DIR ?? '';
    const file = readdirSync(cfgDir).find((f) => f.includes('identity-pending'));
    expect(file, 'the pending sign-in is a file').toBeDefined();
    writeFileSync(join(cfgDir, file!), 'not-encrypted-anything\n');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readPendingSignIn()).toBeNull();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('could not be read');
  });
});
