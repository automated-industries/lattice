import { describe, it, expect, vi } from 'vitest';
import { createUpdateService } from '../../src/gui/update-service.js';
import type { InstallContext } from '../../src/update-context.js';

const installable: InstallContext = {
  kind: 'global',
  installable: true,
  cwd: '/x',
  packageRoot: '/x',
  reason: 'global install',
};
const notInstallable: InstallContext = {
  kind: 'linked-dev',
  installable: false,
  cwd: '/x',
  packageRoot: '/x',
  reason: 'dev build',
};
const desktop: InstallContext = {
  kind: 'desktop',
  installable: false,
  cwd: '/x',
  packageRoot: null,
  reason: 'desktop app',
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('createUpdateService', () => {
  it('installs, broadcasts update-applied, and requests a relaunch on a newer version', async () => {
    const emit = vi.fn();
    const install = vi.fn(() => true);
    const requestRestart = vi.fn();
    const svc = createUpdateService({
      currentVersion: '1.0.0',
      context: installable,
      emit,
      selfUpdate: true,
      check: () => Promise.resolve('2.0.0'),
      install,
      requestRestart,
      restartGraceMs: 0,
    });
    const status = await svc.checkNow(true);
    await tick();
    expect(install).toHaveBeenCalledWith(installable, '2.0.0');
    expect(emit).toHaveBeenCalledWith('update-applied', { to: '2.0.0', from: '1.0.0' });
    expect(requestRestart).toHaveBeenCalledTimes(1);
    expect(status.action).toBe('upgrade-in-place');
  });

  it('surfaces an install FAILURE loudly and does NOT relaunch', async () => {
    const emit = vi.fn();
    const requestRestart = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const svc = createUpdateService({
      currentVersion: '1.0.0',
      context: installable,
      emit,
      selfUpdate: true,
      check: () => Promise.resolve('2.0.0'),
      install: () => {
        throw new Error('npm exploded');
      },
      requestRestart,
      restartGraceMs: 0,
    });
    const status = await svc.checkNow(true);
    await tick();
    expect(emit).toHaveBeenCalledWith('update-error', {
      phase: 'install',
      message: 'npm exploded',
    });
    expect(requestRestart).not.toHaveBeenCalled();
    expect(status.lastError).toBe('npm exploded');
    errSpy.mockRestore();
  });

  it('never installs in a non-installable context (notify-only)', async () => {
    const emit = vi.fn();
    const install = vi.fn(() => true);
    const requestRestart = vi.fn();
    const svc = createUpdateService({
      currentVersion: '1.0.0',
      context: notInstallable,
      emit,
      check: () => Promise.resolve('2.0.0'),
      install,
      requestRestart,
    });
    const status = await svc.checkNow(true);
    expect(install).not.toHaveBeenCalled();
    expect(requestRestart).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('update-applied', expect.anything());
    expect(status.latest).toBe('2.0.0'); // still surfaced in status
    expect(status.installable).toBe(false);
    expect(status.action).toBe('none'); // dev/linked build offers no apply action
  });

  it('desktop: auto-downloads the installer on a newer version, emits progress + ready, offers install-and-restart', async () => {
    const emit = vi.fn();
    const install = vi.fn(() => true);
    const requestRestart = vi.fn();
    const downloadUpdate = vi.fn(
      async (_v: string, onProgress: (d: number, t: number | null) => void) => {
        onProgress(0, 100);
        onProgress(50, 100);
        onProgress(100, 100);
      },
    );
    const svc = createUpdateService({
      currentVersion: '1.0.0',
      context: desktop,
      emit,
      check: () => Promise.resolve('2.0.0'),
      install,
      requestRestart,
      downloadUpdate,
    });
    await svc.checkNow(true);
    await tick();
    expect(install).not.toHaveBeenCalled(); // desktop never npm-installs
    expect(requestRestart).not.toHaveBeenCalled();
    expect(downloadUpdate).toHaveBeenCalledWith('2.0.0', expect.any(Function));
    expect(emit).toHaveBeenCalledWith('update-progress', {
      version: '2.0.0',
      done: 50,
      total: 100,
    });
    expect(emit).toHaveBeenCalledWith('update-ready', { version: '2.0.0' });
    const s = svc.status();
    expect(s.phase).toBe('ready');
    expect(s.stagedVersion).toBe('2.0.0');
    expect(s.action).toBe('install-and-restart');
    expect(s.latest).toBe('2.0.0');
  });

  it('desktop: no click action while still downloading (progress via events, a bar not a spinner)', async () => {
    const emit = vi.fn();
    let resolveDownload: () => void = () => undefined;
    const downloadUpdate = vi.fn(
      (_v: string, onProgress: (d: number, t: number | null) => void) =>
        new Promise<void>((resolve) => {
          onProgress(10, 100);
          resolveDownload = resolve;
        }),
    );
    const svc = createUpdateService({
      currentVersion: '1.0.0',
      context: desktop,
      emit,
      check: () => Promise.resolve('2.0.0'),
      downloadUpdate,
    });
    await svc.checkNow(true);
    await tick();
    const mid = svc.status();
    expect(mid.phase).toBe('downloading');
    expect(mid.action).toBe('none'); // downloading ⇒ no click action, the GUI shows a bar
    expect(mid.downloadedBytes).toBe(10);
    expect(mid.totalBytes).toBe(100);
    resolveDownload();
    await tick();
    expect(svc.status().phase).toBe('ready');
    expect(svc.status().action).toBe('install-and-restart');
  });

  it('desktop: a failed download surfaces loudly (update-error, phase:error, never an endless spinner)', async () => {
    const emit = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const downloadUpdate = vi.fn(() => Promise.reject(new Error('network down')));
    const svc = createUpdateService({
      currentVersion: '1.0.0',
      context: desktop,
      emit,
      check: () => Promise.resolve('2.0.0'),
      downloadUpdate,
    });
    await svc.checkNow(true);
    await tick();
    const s = svc.status();
    expect(s.phase).toBe('error');
    expect(s.lastError).toBe('network down');
    expect(s.action).toBe('none'); // no install action — the GUI offers a manual download
    expect(emit).toHaveBeenCalledWith('update-error', {
      phase: 'download',
      message: 'network down',
    });
    errSpy.mockRestore();
  });

  it('autoUpdate:false never checks and reports action:none / autoUpdate:false', async () => {
    const emit = vi.fn();
    const check = vi.fn(() => Promise.resolve('2.0.0'));
    const svc = createUpdateService({
      currentVersion: '1.0.0',
      context: installable,
      emit,
      autoUpdate: false,
      selfUpdate: true,
      check,
      install: () => true,
    });
    svc.start();
    const status = await svc.checkNow(true);
    await tick();
    expect(check).not.toHaveBeenCalled(); // master switch off — zero network activity
    expect(status.autoUpdate).toBe(false);
    expect(status.latest).toBeNull();
    expect(status.action).toBe('none');
  });

  it('does nothing when already up to date', async () => {
    const emit = vi.fn();
    const install = vi.fn(() => true);
    const svc = createUpdateService({
      currentVersion: '2.0.0',
      context: installable,
      emit,
      check: () => Promise.resolve(null),
      install,
    });
    const status = await svc.checkNow(true);
    expect(install).not.toHaveBeenCalled();
    expect(status.latest).toBeNull();
  });

  it('start() runs an immediate check and stop() clears the timer', async () => {
    const emit = vi.fn();
    const check = vi.fn(() => Promise.resolve(null));
    const svc = createUpdateService({
      currentVersion: '1.0.0',
      context: installable,
      emit,
      check,
      install: () => true,
    });
    svc.start();
    await tick();
    expect(check).toHaveBeenCalled(); // immediate on-load check
    svc.stop(); // must not throw / leak
  });
});
