// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  humanizeIdentityError,
  humanizeIdentityUnavailable,
  identityStepLabel,
  identityStepOf,
  stripStatusCodes,
} from '../../src/gui/ai/error-humanize.js';
import { IdentityServiceError } from '../../src/gui/identity/service.js';
import { resetIdentityDiscovery } from '../../src/gui/identity/service.js';
import { dispatchIdentityRoute, resetPendingSignIn } from '../../src/gui/identity/routes.js';
import { connectWallJs } from '../../src/gui/app/modules/connect-wall.js';
import { accountMenuJs } from '../../src/gui/app/modules/account-menu.js';
import { appJs } from '../../src/gui/app/modules/index.js';

/**
 * A failed account sign-in is the ONE failure a first-run user cannot route around:
 * it happens on the very first screen, before any workspace exists, so a raw string
 * like "identity service error (500)" is both meaningless and a dead end.
 *
 * Three things are asserted here:
 *   1. the message is humanized by CAUSE and never carries a bare status code;
 *   2. it names WHICH leg of the handshake failed (discovery / start / exchange are
 *      otherwise indistinguishable in a bug report);
 *   3. the connect wall offers a visible route to the two working alternatives
 *      rather than a red line and a Back button.
 */

// ── A 3-digit run that is not part of a word — how a status code leaks into prose.
const BARE_CODE = /(?<![\w.])\d{3}(?![\w.])/;

describe('humanizeIdentityError — by cause, never a bare status code', () => {
  function svcError(step: Parameters<typeof identityStepLabel>[0], status: number | null) {
    return new IdentityServiceError(step, 'https://accounts.example/api/device/start', status, '');
  }

  it('turns a 5xx into a temporarily-unavailable sentence with no status code', () => {
    const msg = humanizeIdentityError(svcError('start', 500));
    expect(msg).not.toMatch(BARE_CODE);
    expect(msg).not.toMatch(/identity service error/i);
    expect(msg).toMatch(/temporarily unavailable/i);
  });

  it('names the failing step, and names a DIFFERENT step differently', () => {
    const start = humanizeIdentityError(svcError('start', 503));
    const discovery = humanizeIdentityError(svcError('discovery', 503));
    const workspaces = humanizeIdentityError(svcError('workspaces', 503));
    expect(start).toContain(identityStepLabel('start'));
    expect(discovery).toContain(identityStepLabel('discovery'));
    expect(workspaces).toContain(identityStepLabel('workspaces'));
    expect(start).not.toBe(discovery);
    expect(start).not.toBe(workspaces);
  });

  it('steers to the working alternatives when asked (the first-run dead end)', () => {
    const msg = humanizeIdentityError(svcError('start', 500), { suggestAlternatives: true });
    expect(msg).toMatch(/claude account/i);
    expect(msg).toMatch(/openai-compatible/i);
    // Not appended where it would be noise (the header menu sign-in).
    expect(humanizeIdentityError(svcError('start', 500))).not.toMatch(/claude account/i);
  });

  it('classifies auth, busy, client, and transport failures distinctly', () => {
    expect(humanizeIdentityError(svcError('workspaces', 401))).toMatch(/rejected your sign-in/i);
    expect(humanizeIdentityError(svcError('start', 429))).toMatch(/busy/i);
    expect(humanizeIdentityError(svcError('start', 400))).toMatch(/refused that request/i);
    const offline = new IdentityServiceError('start', 'https://a.example', null, 'fetch failed');
    expect(humanizeIdentityError(offline)).toMatch(/couldn't reach|could not reach/i);
    for (const s of [401, 429, 400, null] as const) {
      expect(humanizeIdentityError(svcError('start', s))).not.toMatch(BARE_CODE);
    }
  });

  it('reads a 4xx at the exchange step as a bad one-time code', () => {
    const msg = humanizeIdentityError(svcError('exchange', 400));
    expect(msg).toMatch(/code/i);
    expect(msg).toMatch(/expired|already been used/i);
    expect(msg).not.toMatch(BARE_CODE);
  });

  it('keeps a sentence our own code already wrote for a person', () => {
    const own = new Error('No sign-in in progress — start again from the user menu.');
    expect(humanizeIdentityError(own, { step: 'exchange' })).toContain('No sign-in in progress');
  });

  it('scrubs a status code out of any message that still carries one', () => {
    expect(stripStatusCodes('identity service error (500)')).toBe('identity service error');
    expect(stripStatusCodes('upstream said HTTP 502')).toBe('upstream said');
    expect(stripStatusCodes('nothing to strip')).toBe('nothing to strip');
    expect(humanizeIdentityError(new Error('boom (503)'))).not.toMatch(BARE_CODE);
  });

  it('identityStepOf reads the tag off a service failure only', () => {
    expect(identityStepOf(svcError('credential', 500))).toBe('credential');
    expect(identityStepOf(new Error('x'))).toBeNull();
    expect(identityStepOf({ step: 'not-a-step' })).toBeNull();
    expect(identityStepOf(null)).toBeNull();
  });

  it('humanizeIdentityUnavailable names the discovery step and offers alternatives', () => {
    const msg = humanizeIdentityUnavailable(true);
    expect(msg).toContain(identityStepLabel('discovery'));
    expect(msg).toMatch(/claude account/i);
    expect(msg).not.toMatch(BARE_CODE);
  });
});

// ── Server: a stubbed identity service that 500s ────────────────────────────────

const stubs: Server[] = [];
const dirs: string[] = [];
const ENV_KEYS = ['LATTICE_CONFIG_DIR', 'LATTICE_IDENTITY_URL', 'LATTICE_IDENTITY_DISCOVERY'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  const base = mkdtempSync(join(tmpdir(), 'lattice-signin-err-'));
  dirs.push(base);
  process.env.LATTICE_CONFIG_DIR = join(base, '.config-store');
});

afterEach(async () => {
  for (const s of stubs.splice(0)) await new Promise((r) => s.close(r));
  // Both resets BEFORE the environment goes back: a half-finished sign-in is a
  // file in the config directory now, so clearing one after LATTICE_CONFIG_DIR
  // has been restored would be reaching into the developer's real store.
  resetIdentityDiscovery();
  resetPendingSignIn();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

/** A stub identity service; `fail` picks which leg answers 500. */
function startFailingStub(fail: 'start' | 'exchange'): Promise<string> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const send = (code: number, body: unknown): void => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        const path = (req.url ?? '').split('?')[0];
        if (path === '/api/device/start') {
          if (fail === 'start') {
            send(500, {}); // no body at all — the worst case
          } else {
            send(200, {
              requestId: 'req-1',
              requestSecret: 'secret-1',
              verifyUrl: 'https://accounts.example/device/approve?rid=req-1',
            });
          }
          return;
        }
        if (path === '/api/device/exchange') {
          send(500, {});
          return;
        }
        send(404, { error: 'not found' });
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      stubs.push(srv);
      resolve(`http://127.0.0.1:${String(typeof addr === 'object' && addr ? addr.port : 0)}`);
    });
  });
}

interface Captured {
  status: number;
  body: { error?: string; step?: string; suggestAlternatives?: boolean };
}

/** Drive one identity route with a fake req/res pair and capture the JSON reply. */
async function callRoute(
  pathname: string,
  body: Record<string, unknown>,
): Promise<Captured | null> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    url: pathname,
    method: 'POST',
    headers: { host: '127.0.0.1:4317' },
  }) as unknown as IncomingMessage;
  let captured: Captured | null = null;
  const res = {
    writeHead(status: number) {
      captured = { status, body: {} };
      return res;
    },
    end(payload: string) {
      if (captured) captured.body = JSON.parse(payload) as Captured['body'];
    },
    setHeader() {
      /* not used by sendJson */
    },
  } as unknown as ServerResponse;
  const handled = await dispatchIdentityRoute(req, res, {
    pathname,
    method: 'POST',
    createCloudWorkspace: () => Promise.resolve('ws-x'),
    probeCloud: () => Promise.resolve({ reachable: false, isCloud: false }),
  });
  expect(handled).toBe(true);
  return captured;
}

describe('sign-in routes — a 500 from the identity service reaches the user humanized', () => {
  it('the START leg: no bare status code, names the step, steers to alternatives', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.LATTICE_IDENTITY_URL = await startFailingStub('start');
    const out = await callRoute('/api/identity/signin/start', { purpose: 'model' });
    expect(out?.status).toBe(502);
    const err = out?.body.error ?? '';
    expect(err).not.toMatch(BARE_CODE);
    expect(err).not.toMatch(/identity service error/i);
    expect(err).toContain(identityStepLabel('start'));
    expect(err).toMatch(/claude account/i);
    expect(out?.body.step).toBe('start');
    expect(out?.body.suggestAlternatives).toBe(true);
  });

  it('logs the resolved endpoint + status server-side so a report is diagnosable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const base = await startFailingStub('start');
    process.env.LATTICE_IDENTITY_URL = base;
    await callRoute('/api/identity/signin/start', {});
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain(`${base}/api/device/start`);
    expect(logged).toContain('500');
    expect(logged).toContain('start');
  });

  it('the EXCHANGE leg reports a DIFFERENT step than the start leg', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.LATTICE_IDENTITY_URL = await startFailingStub('exchange');
    const started = await callRoute('/api/identity/signin/start', { purpose: 'model' });
    expect(started?.status).toBe(200); // start succeeded; only exchange 500s
    const out = await callRoute('/api/identity/signin/complete', {
      code: 'code-1',
      purpose: 'model',
    });
    const err = out?.body.error ?? '';
    expect(out?.body.step).toBe('exchange');
    expect(err).not.toMatch(BARE_CODE);
    expect(err).toContain(identityStepLabel('exchange'));
    expect(err).not.toContain(identityStepLabel('start'));
  });

  it('an unreachable service (no endpoints) is humanized, not a bare refusal', async () => {
    process.env.LATTICE_IDENTITY_DISCOVERY = 'off';
    Reflect.deleteProperty(process.env, 'LATTICE_IDENTITY_URL');
    const out = await callRoute('/api/identity/signin/start', { purpose: 'model' });
    expect(out?.status).toBe(503);
    const err = out?.body.error ?? '';
    expect(err).toContain(identityStepLabel('discovery'));
    expect(err).toMatch(/claude account/i);
    expect(out?.body.step).toBe('discovery');
  });
});

// ── Client: the wall must not dead-end ──────────────────────────────────────────

interface WallGlobals extends Record<string, unknown> {
  BRAND_SVG: string;
  fetchJson: (url: string, opts?: { method?: string; body?: string }) => Promise<unknown>;
  showConnectWall: (onConnected?: () => void) => void;
  hideConnectWall: () => void;
}
const w = globalThis as unknown as WallGlobals;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('connect wall — a failed cloud sign-in offers the working alternatives', () => {
  let calls: string[];

  beforeEach(() => {
    document.body.innerHTML = '';
    calls = [];
    w.BRAND_SVG = '<svg></svg>';
    w.fetchJson = (url: string): Promise<unknown> => {
      calls.push(url);
      if (url === '/api/identity/status') {
        return Promise.resolve({ linked: false, serviceAvailable: true });
      }
      if (url === '/api/identity/signin/start') {
        // Exactly what the fixed server now returns for a 500 at the start leg.
        return Promise.reject(
          new Error(
            'Lattice Cloud sign-in is temporarily unavailable — it failed while ' +
              identityStepLabel('start') +
              '. Try again shortly. You can connect a Claude account or your own ' +
              'OpenAI-compatible endpoint instead.',
          ),
        );
      }
      return Promise.resolve({});
    };
    // Indirect eval installs showConnectWall (+ helpers) on the global, same as the
    // composed client script does at runtime.
    (0, eval)(connectWallJs as string);
  });

  afterEach(() => {
    w.hideConnectWall();
    document.body.innerHTML = '';
  });

  async function reachCloudFailure(): Promise<HTMLElement> {
    w.showConnectWall();
    const cloud = document.querySelector<HTMLElement>('.cw-choice[data-method="cloud"]');
    expect(cloud).not.toBeNull();
    cloud?.click();
    const start = document.getElementById('cw-cloud-start');
    expect(start).not.toBeNull();
    start?.click();
    await flush();
    await flush();
    await flush();
    const wall = document.getElementById('connect-wall');
    expect(wall).not.toBeNull();
    return wall!;
  }

  it('shows the humanized message with no bare status code', async () => {
    const wall = await reachCloudFailure();
    const status = wall.querySelector('#cw-status');
    expect(status?.textContent ?? '').not.toMatch(BARE_CODE);
    expect(status?.textContent ?? '').toMatch(/temporarily unavailable/i);
    expect(status?.textContent ?? '').not.toMatch(/^Sign-in failed: /);
  });

  it('renders VISIBLE buttons for the two alternatives instead of a dead end', async () => {
    const wall = await reachCloudFailure();
    const claude = wall.querySelector('#cw-alt-claude');
    const other = wall.querySelector('#cw-alt-other');
    expect(claude, 'a Claude-account escape hatch must be offered').not.toBeNull();
    expect(other, 'an OpenAI-compatible escape hatch must be offered').not.toBeNull();
  });

  it('the alternative button actually switches the wall to that setup screen', async () => {
    const wall = await reachCloudFailure();
    wall.querySelector<HTMLElement>('#cw-alt-other')?.click();
    const base = document.getElementById('cw-base');
    expect(base, 'clicking the alternative must open the endpoint form').not.toBeNull();
  });

  it('asks the server for the model-connect wording (so it steers, not just fails)', async () => {
    await reachCloudFailure();
    expect(calls).toContain('/api/identity/signin/start');
  });
});

describe('client segments stay composition-safe and code-free', () => {
  it('neither client module contains a backtick (it would terminate the script)', () => {
    expect(connectWallJs).not.toContain('`');
    expect(accountMenuJs).not.toContain('`');
  });

  it('no client path prefixes a raw error with a "Sign-in failed:" label any more', () => {
    expect(connectWallJs).not.toContain("'Sign-in failed: '");
    expect(accountMenuJs).not.toContain("'Sign-in failed: '");
  });

  it('the whole composed client script still parses', () => {
    // Wrapped in an uncalled function expression: this PARSES the composed script
    // (which is what a stray backtick or unbalanced quote breaks) without running it.
    expect(() => (0, eval)('(function () {' + appJs + '\n})')).not.toThrow();
  });

  it('the shared scrub is declared once and reachable from the account menu', () => {
    // Both segments land in the same IIFE, so the account menu resolves the helper
    // by hoisting — but only while there is exactly one declaration of it.
    const declarations = (connectWallJs + accountMenuJs).match(/function connectErrorText\(/g);
    expect(declarations).toHaveLength(1);
    expect(connectWallJs).toContain('function connectErrorText(');
    expect(accountMenuJs).toContain('connectErrorText(');
  });
});
