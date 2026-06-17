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
      check: () => Promise.resolve('2.0.0'),
      install,
      requestRestart,
      restartGraceMs: 0,
    });
    await svc.checkNow(true);
    await tick();
    expect(install).toHaveBeenCalledWith(installable, '2.0.0');
    expect(emit).toHaveBeenCalledWith('update-applied', { to: '2.0.0', from: '1.0.0' });
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it('surfaces an install FAILURE loudly and does NOT relaunch', async () => {
    const emit = vi.fn();
    const requestRestart = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const svc = createUpdateService({
      currentVersion: '1.0.0',
      context: installable,
      emit,
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
