/**
 * GUI supervisor — the thin parent process that makes auto-update seamless.
 *
 * `lattice gui`, when launched from an installable copy, becomes this supervisor.
 * It (1) silently installs the latest published version BEFORE spawning, so the
 * GUI loads on the newest code with no first-paint flash; (2) spawns the real
 * server as a child (marked `LATTICE_GUI_SUPERVISED=1` so it runs directly and
 * runs its in-process update poll); (3) when the child asks to relaunch (exit
 * {@link GUI_RESTART_EXIT_CODE} after installing a background update), respawns it
 * on the same port — the browser's `/api/stream` reconnect then reloads onto the
 * new version with no manual refresh; (4) forwards Ctrl+C / SIGTERM to the child.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { checkForUpdate } from '../update-check.js';
import { detectInstallContext, installLatest } from '../update-context.js';
import { GUI_RESTART_EXIT_CODE } from './update-service.js';

export interface SuperviseOptions {
  /** Path to the CLI entry to respawn (the running `dist/cli.js`). */
  cliPath: string;
  /** Arguments to pass through to the child (typically `process.argv.slice(2)`). */
  childArgs: string[];
  currentVersion: string;
}

export async function superviseGui(opts: SuperviseOptions): Promise<void> {
  const ctx = detectInstallContext();

  // Initial silent install so the GUI loads on the latest version. Best-effort:
  // a failed check/install just runs whatever is already installed (loud on the
  // terminal — there is no browser to toast yet at this point).
  if (ctx.installable) {
    try {
      const latest = await checkForUpdate('latticesql', opts.currentVersion, { force: true });
      if (latest) {
        console.log(`Lattice: updating ${opts.currentVersion} → ${latest}…`);
        installLatest(ctx, latest, { quiet: true });
      }
    } catch (err) {
      console.error('[latticesql] startup auto-update failed:', (err as Error).message);
    }
  }

  let stopping = false;
  let child: ChildProcess | null = null;
  let firstSpawn = true;

  const spawnChild = (): void => {
    const args = [opts.cliPath, ...opts.childArgs];
    // Only the very first spawn may open the browser; a relaunch must not pop a
    // second tab — the existing one reconnects and reloads itself. Port stays the
    // requested one: the prior child has fully exited, so it is free to rebind.
    if (!firstSpawn && !args.includes('--no-open')) args.push('--no-open');
    firstSpawn = false;
    child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, LATTICE_GUI_SUPERVISED: '1' },
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) {
        process.exit(0);
        return;
      }
      if (code === GUI_RESTART_EXIT_CODE) {
        spawnChild();
        return;
      }
      // Child exited on its own (a crash, or a non-restart exit) — mirror it.
      process.exit(code ?? (signal ? 1 : 0));
    });
  };

  const forward = (sig: NodeJS.Signals): void => {
    stopping = true;
    if (child) child.kill(sig);
    else process.exit(0);
  };
  process.on('SIGINT', () => {
    forward('SIGINT');
  });
  process.on('SIGTERM', () => {
    forward('SIGTERM');
  });

  spawnChild();
}
