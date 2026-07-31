// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { appJs } from '../../src/gui/app/script.js';
import { suggestedDisplayName, readIdentity } from '../../src/framework/user-config.js';
import { dispatchUserConfigRoute } from '../../src/gui/userconfig-routes.js';
import type { Lattice } from '../../src/lattice.js';

/**
 * The first screen of the product asked for a name and would not continue
 * without one. It is a label on your own edits, changeable afterwards from the
 * account menu, and on most machines the operating system already knows a
 * perfectly good answer — so stopping the launch over it made the very first
 * thing the product does be a form to satisfy.
 *
 * The name is now offered: the server hands back a suggestion drawn from the
 * machine account, the field arrives filled in, and clearing it does not block
 * anything. It is stored as the identity because the person left it there.
 *
 * Both halves are driven the way the product wires them. The server half goes
 * through the real route dispatcher. The client half runs the SHIPPED wizard,
 * sliced out of the composed application script rather than re-implemented, in a
 * real DOM — a re-implementation would only prove the test's copy behaves.
 */

/* ── the server half ─────────────────────────────────────────────────────── */

describe('the server offers a name to start from', () => {
  let cfgDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), 'lattice-onboard-'));
    saved.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
    saved.LATTICE_USER_NAME = process.env.LATTICE_USER_NAME;
    process.env.LATTICE_CONFIG_DIR = cfgDir;
    delete process.env.LATTICE_USER_NAME;
  });

  afterEach(() => {
    if (saved.LATTICE_CONFIG_DIR === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = saved.LATTICE_CONFIG_DIR;
    if (saved.LATTICE_USER_NAME === undefined) delete process.env.LATTICE_USER_NAME;
    else process.env.LATTICE_USER_NAME = saved.LATTICE_USER_NAME;
    rmSync(cfgDir, { recursive: true, force: true });
  });

  it('reads a name off the machine account and makes it presentable', () => {
    // Whatever account this runs under, the suggestion is a display name: no
    // separators left in it, and each word capitalized.
    const s = suggestedDisplayName();
    if (s !== '') {
      expect(s).not.toMatch(/[._-]/);
      expect(s[0]).toBe(s[0]?.toUpperCase());
    }
    // It is a SUGGESTION, never the stored identity — an unset name still reads
    // as unset, which is what every other consumer of the identity relies on.
    expect(readIdentity().display_name).toBe('');
  });

  it('the route that first-run onboarding calls carries the suggestion', async () => {
    const req = Readable.from(['']) as unknown as IncomingMessage;
    let raw = '';
    const res = {
      writeHead() {
        return this;
      },
      end(chunk?: string) {
        raw = chunk ?? '';
      },
    } as unknown as ServerResponse;
    const handled = await dispatchUserConfigRoute(req, res, {
      pathname: '/api/userconfig/identity',
      method: 'GET',
      db: null as unknown as Lattice,
      configPath: join(cfgDir, 'lattice.config.yaml'),
    } as Parameters<typeof dispatchUserConfigRoute>[2]);
    expect(handled).toBe(true);
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body, 'the field exists so the client can fill from it').toHaveProperty(
      'suggested_display_name',
    );
    expect(body.suggested_display_name).toBe(suggestedDisplayName());
    expect(body.display_name, 'and it did not become the stored name').toBe('');
  });
});

/* ── the client half ─────────────────────────────────────────────────────── */

interface Wizard {
  showOnboardingWizard: (mode: string) => void;
}

/** The shipped wizard, taken verbatim out of the composed application script. */
function loadShippedWizard(identity: Record<string, unknown>, posts: unknown[]): Wizard {
  const from = appJs.indexOf('function showOnboardingWizard');
  const to = appJs.indexOf('function slugifyName');
  expect(from, 'found the onboarding wizard in the app script').toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const source = appJs.slice(from, to);

  const w = globalThis as unknown as Record<string, unknown>;
  w.fetchJson = (url: string) =>
    url === '/api/userconfig/identity' ? Promise.resolve(identity) : Promise.resolve({});
  const ENTITIES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  w.escapeHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
  w.state = {};
  w.withBusy = (_el: unknown, fn: () => unknown) => fn();
  w.postgresFormHtml = () => '';
  w.slugifyName = (s: string) => s.toLowerCase();
  w.fetch = (url: string, init: { body?: string }) => {
    posts.push({ url, body: JSON.parse(init.body ?? '{}') as unknown });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };

  // Indirect eval so the wizard runs against the SAME globals the browser gives
  // it — the real document, the stubs above. A fresh VM context would hand it a
  // world with no DOM in it, which is not the world it ships into.
  (0, eval)(`${source}\nglobalThis.__shippedWizard = showOnboardingWizard;`);
  return { showOnboardingWizard: w.__shippedWizard as (mode: string) => void };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function nameField(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('#ob-name');
  if (!el) throw new Error('the name field was not rendered');
  return el;
}

function clickNext(): void {
  document.querySelector<HTMLElement>('[data-act="ok"]')!.click();
}

function message(): string {
  return document.querySelector('#ob-msg')?.textContent ?? '';
}

describe('the first screen does not stop over a name', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('location', { reload: () => undefined });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('arrives with the suggested name already filled in', async () => {
    loadShippedWizard(
      { display_name: '', email: '', suggested_display_name: 'Ada Lovelace' },
      [],
    ).showOnboardingWizard('create');
    await flush();
    expect(nameField().value).toBe('Ada Lovelace');
  });

  it('a stored name still wins over the suggestion', async () => {
    loadShippedWizard(
      { display_name: 'Grace Hopper', email: '', suggested_display_name: 'Ada Lovelace' },
      [],
    ).showOnboardingWizard('create');
    await flush();
    expect(nameField().value).toBe('Grace Hopper');
  });

  it('clearing the name and continuing works — it falls back and moves on', async () => {
    const posts: unknown[] = [];
    loadShippedWizard(
      { display_name: '', email: '', suggested_display_name: 'Ada Lovelace' },
      posts,
    ).showOnboardingWizard('create');
    await flush();

    nameField().value = '';
    clickNext();
    await flush();

    expect(message(), 'it does not refuse').toBe('');
    expect(posts, 'the identity was saved and the wizard went on').toEqual([
      {
        url: '/api/userconfig/identity',
        body: { display_name: 'Ada Lovelace', email: '' },
      },
    ]);
    // The next step is on screen, which is the proof it did not stay put.
    expect(document.querySelector('#ob-wsname'), 'advanced to naming the workspace').not.toBeNull();
  });

  it('with nothing to suggest either, it still continues', async () => {
    const posts: unknown[] = [];
    loadShippedWizard(
      { display_name: '', email: '', suggested_display_name: '' },
      posts,
    ).showOnboardingWizard('create');
    await flush();

    expect(nameField().value).toBe('');
    clickNext();
    await flush();

    expect(message()).toBe('');
    expect(posts).toHaveLength(1);
    expect(document.querySelector('#ob-wsname')).not.toBeNull();
  });

  it('a typed name is what gets stored', async () => {
    const posts: unknown[] = [];
    loadShippedWizard(
      { display_name: '', email: '', suggested_display_name: 'Ada Lovelace' },
      posts,
    ).showOnboardingWizard('create');
    await flush();

    nameField().value = 'Katherine Johnson';
    document.querySelector<HTMLInputElement>('#ob-email')!.value = 'kj@example.test';
    clickNext();
    await flush();

    expect(posts).toEqual([
      {
        url: '/api/userconfig/identity',
        body: { display_name: 'Katherine Johnson', email: 'kj@example.test' },
      },
    ]);
  });
});
