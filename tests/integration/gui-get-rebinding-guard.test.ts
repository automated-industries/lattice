import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * Regression (S5): the anti-DNS-rebinding same-origin check used to run ONLY on mutating
 * methods, leaving every GET data route (`/api/tables/*`, `/api/entities`, `/api/dbconfig`, …)
 * unprotected. A drive-by site that rebinds its hostname to 127.0.0.1 could then issue a
 * "same-origin" GET to the loopback GUI and read the JSON body (data / config / — via the S4 gap
 * — decrypted secrets). The check now runs on GET data routes too, defeated only by a genuine
 * top-level navigation (OAuth callback / a user opening an /api URL), which cannot exfiltrate.
 */
const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-rebind-'));
  dirs.push(cfgDir);
  savedEnv.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
  savedEnv.LATTICE_ENCRYPTION_KEY = process.env.LATTICE_ENCRYPTION_KEY;
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'rebind-test-key';
});
afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function boot(): Promise<{ handle: GuiServerHandle; port: number }> {
  const cfgDir = dirs[dirs.length - 1]!;
  mkdirSync(join(cfgDir, 'data'), { recursive: true });
  const configPath = join(cfgDir, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  items:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '',
    ].join('\n'),
    'utf8',
  );
  const outputDir = join(resolve(configPath, '..'), 'context');
  mkdirSync(outputDir, { recursive: true });
  const handle = await startGuiServer({
    configPath,
    outputDir,
    port: 0,
    host: '127.0.0.1',
    openBrowser: false,
  });
  servers.push(handle);
  const port = Number(new URL(handle.url).port);
  return { handle, port };
}

/** Raw GET so we can set an arbitrary Host header (a rebinding attacker's own hostname) and
 *  Sec-Fetch-* — Node fetch forbids overriding Host. */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  return new Promise((res, rej) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (r) => {
      r.resume();
      r.on('end', () => {
        res({ status: r.statusCode ?? 0 });
      });
    });
    req.on('error', rej);
    req.end();
  });
}

describe('GET data routes are protected against DNS rebinding (S5)', () => {
  it('BLOCKS a rebound-Host data fetch (attacker hostname in Host)', async () => {
    const { port } = await boot();
    const r = await rawGet(port, '/api/entities', {
      host: 'evil.example.com:' + port, // DNS-rebound hostname — not a bound authority
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin', // the browser thinks it's same-origin post-rebind
    });
    expect(r.status).toBe(403);
  });

  it('BLOCKS a cross-site sub-resource fetch (Sec-Fetch-Site: cross-site)', async () => {
    const { port } = await boot();
    const r = await rawGet(port, '/api/entities', {
      host: '127.0.0.1:' + port,
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'cross-site',
    });
    expect(r.status).toBe(403);
  });

  it('ALLOWS a legitimate same-origin data fetch', async () => {
    const { port } = await boot();
    const r = await rawGet(port, '/api/entities', {
      host: '127.0.0.1:' + port,
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    });
    expect(r.status).toBe(200);
  });

  it('ALLOWS a cross-site TOP-LEVEL NAVIGATION (OAuth callback / pasted URL) — cannot exfiltrate', async () => {
    const { port } = await boot();
    const r = await rawGet(port, '/api/entities', {
      host: '127.0.0.1:' + port,
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-site': 'cross-site',
    });
    expect(r.status).not.toBe(403); // navigation is exempt (200)
  });

  it('BLOCKS an iframe/object/embed sub-frame navigation (round-2: mode=navigate but dest=iframe)', async () => {
    // A sub-frame navigation ALSO carries Sec-Fetch-Mode: navigate, so exempting on mode would
    // let a rebound-Host iframe return JSON the same-origin parent reads. Only dest=document is
    // exempt now.
    const { port } = await boot();
    for (const dest of ['iframe', 'object', 'embed']) {
      const r = await rawGet(port, '/api/entities', {
        host: '127.0.0.1:' + port,
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': dest,
        'sec-fetch-site': 'cross-site',
      });
      expect(r.status).toBe(403);
    }
  });

  it('sets frame- + opener-blocking headers on API JSON responses (defense in depth)', async () => {
    const { port } = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/api/entities`);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  it('BLOCKS a rebound-Host TOP-LEVEL navigation — window.open exfil (round-3)', async () => {
    // A `window.open('http://evil:PORT/api/…')` is a dest=document navigation, so exempting on
    // dest alone let it through — but its Host is the attacker's rebound name (not a bound
    // authority), and the opener stays same-origin post-rebind and reads the JSON. The exemption
    // now ALSO requires a bound Host, so this is blocked.
    const { port } = await boot();
    const r = await rawGet(port, '/api/tables/items/rows', {
      host: 'evil.example.com:' + port, // rebound attacker hostname
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-site': 'cross-site',
    });
    expect(r.status).toBe(403);
  });

  it('still ALLOWS a top-level document navigation to a BOUND host (OAuth callback)', async () => {
    const { port } = await boot();
    const r = await rawGet(port, '/api/entities', {
      host: '127.0.0.1:' + port, // a bound authority
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-site': 'cross-site',
    });
    expect(r.status).not.toBe(403);
  });

  it('ALLOWS a non-browser client (no Sec-Fetch / Origin, matching Host) — curl / tooling', async () => {
    const { port } = await boot();
    const r = await rawGet(port, '/api/entities', { host: '127.0.0.1:' + port });
    expect(r.status).toBe(200);
  });
});
