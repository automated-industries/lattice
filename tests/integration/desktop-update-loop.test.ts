import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateService } from '../../src/gui/update-service.js';
import { checkManifestForUpdate } from '../../src/update-check.js';
import type { InstallContext } from '../../src/update-context.js';

/**
 * Regression harness for the desktop auto-update INFINITE LOOP:
 * "Downloading update vN → Install & restart → (swap fails, old app relaunches) →
 * Downloading update vN → …" forever.
 *
 * The macOS bundle swap itself can't run in CI (no signed app / Gatekeeper), so we
 * exercise the loop-BREAKING contract that is environment-independent: the update
 * service's persisted apply-attempt marker. Each "restart" is modeled by tearing
 * down the service and constructing a fresh one over the SAME state dir with a new
 * running version — exactly what a real relaunch is (a fresh process reading the
 * marker on disk). The manifest is a real local HTTP server whose advertised
 * version we flip between checks, driven through the REAL `checkManifestForUpdate`.
 *
 * The load-bearing assertion is downloads-per-stuck-version: a failed apply must
 * download the target AT MOST ONCE and then stop — never the endless re-download.
 */

const desktop: InstallContext = {
  kind: 'desktop',
  installable: false,
  cwd: '/x',
  packageRoot: null,
  reason: 'desktop app',
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

interface Manifest {
  baseUrl: string;
  setVersion: (v: string) => void;
  close: () => Promise<void>;
}

function manifestServer(): Promise<Manifest> {
  let version = '0.0.0';
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      if (req.url === '/latest.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version, assets: {} }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${String(port)}/`,
        setVersion: (v: string) => {
          version = v;
        },
        close: () =>
          new Promise<void>((r) => {
            srv.close(() => {
              r();
            });
          }),
      });
    });
  });
}

describe('desktop auto-update — no infinite re-download loop on a failed apply', () => {
  const dirs: string[] = [];
  let mf: Manifest | null = null;

  afterEach(async () => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (mf) {
      await mf.close();
      mf = null;
    }
  });

  function freshStateDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'lattice-upd-'));
    dirs.push(d);
    return d;
  }

  // A desktop update service wired to the manifest server + a counting downloader.
  // `applyDownloadedUpdate` is a no-op: the "OS install" outcome is modeled by what
  // `currentVersion` the NEXT boot is constructed with (same version = swap failed).
  function boot(currentVersion: string, stateDir: string) {
    const emit = vi.fn();
    let downloads = 0;
    const svc = createUpdateService({
      currentVersion,
      context: desktop,
      emit,
      stateDir,
      manualDownloadUrl: 'https://latticesql.com/install',
      check: () => checkManifestForUpdate(mf!.baseUrl, currentVersion),
      downloadUpdate: async (_v, onProgress) => {
        downloads += 1;
        onProgress(10, 10);
      },
      applyDownloadedUpdate: () => {
        /* OS install simulated by the next boot's currentVersion */
      },
    });
    return { svc, emit, downloads: () => downloads };
  }

  it('successful apply + restart stops after ONE download (no loop)', async () => {
    mf = await manifestServer();
    mf.setVersion('5.1.3');
    const stateDir = freshStateDir();

    // Boot on 5.1.2 → sees 5.1.3 → downloads once → user applies (marker written).
    const b1 = boot('5.1.2', stateDir);
    await b1.svc.checkNow();
    await tick();
    expect(b1.svc.status().phase).toBe('ready');
    expect(b1.svc.status().stagedVersion).toBe('5.1.3');
    expect(b1.downloads()).toBe(1);
    b1.svc.apply();
    b1.svc.stop();

    // Restart on 5.1.3 (swap SUCCEEDED). Manifest 5.1.3 is not newer → nothing to do.
    const b2 = boot('5.1.3', stateDir);
    const st = await b2.svc.checkNow();
    await tick();
    expect(b2.downloads()).toBe(0);
    expect(st.action).toBe('none');
    expect(st.phase).toBe('idle');
    b2.svc.stop();
  });

  it('FAILED apply surfaces a one-time error and NEVER re-downloads the stuck version', async () => {
    mf = await manifestServer();
    mf.setVersion('5.1.3');
    const stateDir = freshStateDir();

    const b1 = boot('5.1.2', stateDir);
    await b1.svc.checkNow();
    await tick();
    expect(b1.downloads()).toBe(1);
    b1.svc.apply(); // marker { version: 5.1.3, fromVersion: 5.1.2 }
    b1.svc.stop();

    // Restart STILL on 5.1.2 (the swap failed to persist) — the exact loop repro.
    // Poll repeatedly the way the running app does; pre-fix this re-downloaded every tick.
    const b2 = boot('5.1.2', stateDir);
    for (let i = 0; i < 5; i++) {
      await b2.svc.checkNow();
      await tick();
    }
    const st = b2.svc.status();
    expect(b2.downloads()).toBe(0); // the fix: the stuck version is never re-downloaded
    expect(st.phase).toBe('error');
    expect(st.action).toBe('none');
    expect(st.lastError).toMatch(/install didn't complete/);
    expect(st.lastError).toContain('https://latticesql.com/install');
    // Loud exactly ONCE, not once per poll.
    const errs = b2.emit.mock.calls.filter((c) => c[0] === 'update-error');
    expect(errs.length).toBe(1);
    b2.svc.stop();
  });

  it('a NEWER release supersedes a stuck version and downloads fresh', async () => {
    mf = await manifestServer();
    mf.setVersion('5.1.3');
    const stateDir = freshStateDir();

    const b1 = boot('5.1.2', stateDir);
    await b1.svc.checkNow();
    await tick();
    b1.svc.apply();
    b1.svc.stop();

    // Stuck on 5.1.2 with a failed 5.1.3 apply → no re-download.
    const b2 = boot('5.1.2', stateDir);
    await b2.svc.checkNow();
    await tick();
    expect(b2.downloads()).toBe(0);
    expect(b2.svc.status().phase).toBe('error');

    // A newer release lands — the guard clears and the fresh version downloads.
    mf.setVersion('5.1.4');
    await b2.svc.checkNow();
    await tick();
    expect(b2.downloads()).toBe(1);
    expect(b2.svc.status().phase).toBe('ready');
    expect(b2.svc.status().stagedVersion).toBe('5.1.4');
    b2.svc.stop();
  });

  it('with no prior attempt, a first-time desktop update downloads normally (guard never over-blocks)', async () => {
    mf = await manifestServer();
    mf.setVersion('5.1.3');
    const stateDir = freshStateDir();

    const b = boot('5.1.2', stateDir);
    await b.svc.checkNow();
    await tick();
    expect(b.downloads()).toBe(1);
    expect(b.svc.status().phase).toBe('ready');
    b.svc.stop();
  });
});
