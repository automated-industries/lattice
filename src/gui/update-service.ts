/**
 * In-GUI auto-update service (runs inside the served server process).
 *
 * Responsibilities while the GUI is open:
 *  - poll the npm registry for a newer published version (best-effort/quiet),
 *  - when one lands AND this copy is installable, install it silently, tell the
 *    connected browsers an update was applied, and ask the supervisor to relaunch
 *    by exiting with {@link GUI_RESTART_EXIT_CODE},
 *  - surface an install FAILURE loudly (broadcast + console.error) — never a
 *    silent swallow.
 *
 * The supervisor ({@link ../supervisor}) catches the restart exit and respawns
 * the server on the same port; the browser's `/api/stream` reconnect notices the
 * version bumped and reloads onto the new code. The registry *check* is quiet
 * (network blips just retry next tick); only the *install* is loud.
 */
import { checkForUpdate } from '../update-check.js';
import { detectInstallContext, installLatest, type InstallContext } from '../update-context.js';

/** Exit code the server uses to ask its supervisor to relaunch it. */
export const GUI_RESTART_EXIT_CODE = 75;

/** Default registry poll cadence while the GUI is open (3h). */
const DEFAULT_POLL_MS = 3 * 60 * 60 * 1000;

export interface UpdateStatus {
  current: string;
  latest: string | null;
  kind: InstallContext['kind'];
  installable: boolean;
  checking: boolean;
  installing: boolean;
  lastError: string | null;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  /** Broadcast helper — pushes `{type,data}` to every connected `/api/stream`. */
  emit: (type: string, data: unknown) => void;
  context?: InstallContext;
  pollIntervalMs?: number;
  /** Test seam: override the registry check. */
  check?: (force: boolean) => Promise<string | null>;
  /** Test seam: override the install. Returns true on success, throws on failure. */
  install?: (ctx: InstallContext, version: string) => boolean;
  /** Test seam: override the relaunch request (default: process.exit). */
  requestRestart?: () => void;
  /** Delay between `update-applied` broadcast and the relaunch (lets clients see it). */
  restartGraceMs?: number;
}

export interface UpdateService {
  start(): void;
  stop(): void;
  status(): UpdateStatus;
  /** Run a check now (and install if applicable). Returns the resulting status. */
  checkNow(force?: boolean): Promise<UpdateStatus>;
}

export function createUpdateService(opts: UpdateServiceOptions): UpdateService {
  const ctx = opts.context ?? detectInstallContext();
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const restartGraceMs = opts.restartGraceMs ?? 1500;
  const check =
    opts.check ??
    ((force: boolean) => checkForUpdate('latticesql', opts.currentVersion, { force }));
  const install = opts.install ?? ((c, v) => installLatest(c, v, { quiet: true }));
  const requestRestart =
    opts.requestRestart ??
    (() => {
      process.exit(GUI_RESTART_EXIT_CODE);
    });

  let timer: ReturnType<typeof setInterval> | null = null;
  let checking = false;
  let installing = false;
  let latest: string | null = null;
  let lastError: string | null = null;

  const status = (): UpdateStatus => ({
    current: opts.currentVersion,
    latest,
    kind: ctx.kind,
    installable: ctx.installable,
    checking,
    installing,
    lastError,
  });

  const applyUpdate = (version: string): void => {
    if (installing) return;
    installing = true;
    try {
      install(ctx, version);
      // Files on disk are now the new version; tell clients then relaunch.
      opts.emit('update-applied', { to: version, from: opts.currentVersion });
      setTimeout(() => {
        requestRestart();
      }, restartGraceMs).unref();
    } catch (err) {
      installing = false;
      lastError = err instanceof Error ? err.message : String(err);
      // Loud — an install that fails must not be hidden from the user.
      console.error(`[latticesql] auto-update install failed: ${lastError}`);
      opts.emit('update-error', { phase: 'install', message: lastError });
    }
  };

  const runCheck = async (force: boolean): Promise<void> => {
    if (checking || installing) return;
    checking = true;
    try {
      const found = await check(force);
      latest = found;
      if (found && ctx.installable) applyUpdate(found);
    } catch {
      // Best-effort: a failed registry check is silent and simply retried next
      // tick (the check, unlike the install, is not a user-facing operation).
    } finally {
      checking = false;
    }
  };

  return {
    start(): void {
      if (timer) return;
      void runCheck(true); // immediate check on GUI load
      timer = setInterval(() => void runCheck(true), pollMs);
      timer.unref();
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    status,
    async checkNow(force = true): Promise<UpdateStatus> {
      await runCheck(force);
      return status();
    },
  };
}
