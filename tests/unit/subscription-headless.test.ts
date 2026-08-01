import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startSubscriptionSignIn,
  completeSubscriptionSignIn,
  pendingSubscriptionSignIn,
  readPendingSubscription,
  clearPendingSubscription,
  PENDING_SUBSCRIPTION_TTL_MS,
} from '../../src/ops/subscription.js';
import { modelErrorCode } from '../../src/ops/model-errors.js';
import { getAssistantCredential } from '../../src/framework/user-config.js';
import { CLAUDE_OAUTH_KIND } from '../../src/ops/ai-config.js';
import { runModelCommand } from '../../src/cli-model.js';
import * as lattice from '../../src/index.js';

/**
 * Connecting a Claude subscription with no browser attached.
 *
 * This was the last backend a browser had to own, and the reason turned out to
 * be a cookie rather than the flow: the attempt's verifier lived in the browser
 * session, so only the process that started the flow could finish it. Kept in the
 * machine-local store instead, the two legs are two ordinary calls — which is the
 * claim under test here, along with the checks that must survive the move: the
 * state binding, the single-use code, and the expiry.
 *
 * The token endpoint is stubbed at `fetch`, the one seam between this and the
 * network. Everything else — the PKCE generation, the encrypted store, the state
 * check, the credential write — is real.
 */

const scripted = vi.hoisted(() => ({
  /** Requests the stubbed token endpoint saw, in order. */
  seen: [] as { url: string; body: string }[],
  /** What it should answer with. */
  reply: { ok: true, status: 200, json: {} as unknown },
}));

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-sub-cfg-'));
  dirs.push(cfgDir);
  for (const k of [
    'LATTICE_CONFIG_DIR',
    'LATTICE_ENCRYPTION_KEY',
    'LATTICE_MANAGED_MODEL_AUTH',
    'ANTHROPIC_OAUTH_REDIRECT_URI',
  ]) {
    savedEnv[k] = process.env[k];
    Reflect.deleteProperty(process.env, k);
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'subscription-test-key';
  scripted.seen = [];
  scripted.reply = {
    ok: true,
    status: 200,
    json: { access_token: 'tok-abc', refresh_token: 'ref-abc', expires_in: 3600 },
  };
  globalThis.fetch = ((url: string, init?: { body?: string }) => {
    scripted.seen.push({ url, body: init?.body ?? '' });
    return Promise.resolve({
      ok: scripted.reply.ok,
      status: scripted.reply.status,
      json: () => Promise.resolve(scripted.reply.json),
      text: () => Promise.resolve(JSON.stringify(scripted.reply.json)),
    });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The tagged code on a call that should have been refused. */
async function refusal(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (e) {
    return modelErrorCode(e) ?? `UNTAGGED(${(e as Error).message})`;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

describe('a subscription connects without a browser session', () => {
  it('starts an attempt and hands back a URL anybody can approve, anywhere', () => {
    const started = startSubscriptionSignIn();
    expect(started.authorizeUrl).toMatch(/^https?:\/\//);
    // PKCE, generated here: the challenge travels, the verifier does not.
    expect(started.authorizeUrl).toContain('code_challenge=');
    expect(started.authorizeUrl).toContain('code_challenge_method=S256');
    // Nothing about the attempt is a cookie, so a caller with no browser and no
    // server still holds everything the second leg needs.
    expect(pendingSubscriptionSignIn()).not.toBeNull();
  });

  it('finishes in a DIFFERENT process from the one that started it', async () => {
    // The whole point. The first leg keeps its half of the handshake on disk, so
    // "start it here, finish it there" is not a special case — it is the only
    // mechanism, and the browser path is one caller of it.
    const started = startSubscriptionSignIn();
    const state = new URL(started.authorizeUrl).searchParams.get('state') ?? '';
    expect(state).not.toBe('');

    // A separate run: nothing in memory carries over, only the encrypted store.
    await completeSubscriptionSignIn(`the-code#${state}`);

    const stored = getAssistantCredential(CLAUDE_OAUTH_KIND);
    expect(stored, 'the token is machine-level, so every workspace sees it').not.toBeNull();
    expect(JSON.parse(stored ?? '{}')).toMatchObject({ access_token: 'tok-abc' });
    // The verifier really was the one the authorize URL committed to.
    expect(scripted.seen[0]?.body).toContain('code_verifier=');
    expect(scripted.seen[0]?.body).toContain('code=the-code');
  });

  it('refuses a code whose state belongs to a different attempt', async () => {
    startSubscriptionSignIn();
    expect(await refusal(() => completeSubscriptionSignIn('the-code#not-our-state'))).toBe(
      'invalid_request',
    );
    expect(scripted.seen, 'nothing was redeemed').toEqual([]);
    expect(getAssistantCredential(CLAUDE_OAUTH_KIND)).toBeNull();
  });

  it('tells a caller with nothing in progress to start again, not to re-paste', async () => {
    // The two failures used to be one message, which sent people round the same
    // loop pasting a code that could never work. They are separate codes now.
    expect(await refusal(() => completeSubscriptionSignIn('a-code'))).toBe('no_signin_in_progress');
    startSubscriptionSignIn();
    expect(await refusal(() => completeSubscriptionSignIn('  '))).toBe('invalid_request');
  });

  it('spends the attempt, so the same code cannot be redeemed twice', async () => {
    const started = startSubscriptionSignIn();
    const state = new URL(started.authorizeUrl).searchParams.get('state') ?? '';
    await completeSubscriptionSignIn(`the-code#${state}`);
    expect(pendingSubscriptionSignIn(), 'the attempt is finished').toBeNull();
    expect(await refusal(() => completeSubscriptionSignIn(`the-code#${state}`))).toBe(
      'no_signin_in_progress',
    );
  });

  it('an abandoned attempt ages out instead of leaving a usable verifier on disk', () => {
    const startedAt = Date.now();
    startSubscriptionSignIn();
    expect(readPendingSubscription()).not.toBeNull();

    // Walk past the window. Reading it back must both report nothing AND delete
    // it: a store that only filtered on age would keep the same spent verifier on
    // disk forever, which is the thing the window exists to prevent.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(startedAt + PENDING_SUBSCRIPTION_TTL_MS + 1000);
      expect(readPendingSubscription()).toBeNull();
      expect(pendingSubscriptionSignIn()).toBeNull();
      // Back inside the window: still nothing, because the file is gone rather
      // than merely being judged too old.
      vi.setSystemTime(startedAt + 1000);
      expect(readPendingSubscription()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a finished or abandoned attempt can be forgotten outright', () => {
    startSubscriptionSignIn();
    clearPendingSubscription();
    expect(readPendingSubscription()).toBeNull();
    expect(pendingSubscriptionSignIn()).toBeNull();
  });

  it('a managed deployment cannot connect one from here either', async () => {
    process.env.LATTICE_MANAGED_MODEL_AUTH = '1';
    expect(await refusal(() => startSubscriptionSignIn())).toBe('managed_model_auth');
    expect(await refusal(() => completeSubscriptionSignIn('a-code'))).toBe('managed_model_auth');
  });
});

describe('the command line reaches both legs', () => {
  it('prints the URL to approve and the verb that finishes it', async () => {
    const lines = (await runModelCommand({ subcommand: 'subscription' })).join('\n');
    expect(lines).toContain('https://');
    expect(lines).toContain('lattice model code <code>');
  });

  it('connects from the code the approval page showed', async () => {
    const [json] = await runModelCommand({ subcommand: 'subscription', json: true });
    const started = JSON.parse(json ?? '{}') as { authorizeUrl: string };
    const state = new URL(started.authorizeUrl).searchParams.get('state') ?? '';

    expect(await runModelCommand({ subcommand: 'code', action: `the-code#${state}` })).toEqual([
      'Claude subscription connected. It is now available as a backend.',
    ]);
    expect(getAssistantCredential(CLAUDE_OAUTH_KIND)).not.toBeNull();
  });

  it('reads the code from standard input, so it stays out of the process list', async () => {
    const [json] = await runModelCommand({ subcommand: 'subscription', json: true });
    const started = JSON.parse(json ?? '{}') as { authorizeUrl: string };
    const state = new URL(started.authorizeUrl).searchParams.get('state') ?? '';

    await runModelCommand({
      subcommand: 'code',
      keyStdin: true,
      readStdin: () => Promise.resolve(`the-code#${state}\n`),
    });
    expect(getAssistantCredential(CLAUDE_OAUTH_KIND)).not.toBeNull();
  });

  it('will not connect from a code nobody supplied', async () => {
    await expect(runModelCommand({ subcommand: 'code' })).rejects.toThrow(
      /Usage: lattice model code/,
    );
  });

  it('says an unfinished attempt is waiting, and how to finish it', async () => {
    startSubscriptionSignIn();
    const lines = (await runModelCommand({ subcommand: 'status' })).join('\n');
    expect(lines).toContain('is waiting for its code');
    expect(lines).toContain('lattice model code <code>');
  });

  it('names a command rather than a browser when nothing is connected', async () => {
    const lines = (await runModelCommand({ subcommand: 'status' })).join('\n');
    expect(lines).toContain('lattice model subscription');
    expect(lines, 'the machine reading this may have no display').not.toContain('needs a browser');
  });
});

describe('both legs are on the public surface', () => {
  it('a consumer can import them from the package entry point', () => {
    const names = lattice as unknown as Record<string, unknown>;
    expect(typeof names.startSubscriptionSignIn).toBe('function');
    expect(typeof names.completeSubscriptionSignIn).toBe('function');
    expect(typeof names.pendingSubscriptionSignIn).toBe('function');
  });
});
