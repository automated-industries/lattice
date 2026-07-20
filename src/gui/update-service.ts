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
  /** Master switch — false when auto-update is disabled for this server. */
  autoUpdate: boolean;
  /**
   * What the user can DO about an available update on THIS surface:
   *  - `upgrade-in-place`: an npm install can upgrade this copy now (the GUI's
   *    manual "Upgrade" fallback to the background poll).
   *  - `restart-to-update`: a newer version exists and the bundled desktop
   *    updater can apply it on relaunch ("Restart to update").
   *  - `none`: nothing to offer — already current, auto-update disabled, or a
   *    surface that can't self-update (a dev/linked checkout, where `latest` is
   *    still reported for information but there is no apply action).
   */
  action: 'upgrade-in-place' | 'restart-to-update' | 'none';
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
  /**
   * Master switch (default true). When false the service never polls, never
   * installs, and reports `action:'none'` / `autoUpdate:false` — so a caller can
   * disable ALL update activity for testing while the status route still answers.
   */
  autoUpdate?: boolean;
  /**
   * Whether THIS process performs the npm install-and-relaunch when a newer
   * installable version lands (default false). Set only for the supervised CLI
   * child, which has a supervisor to respawn it after the restart-exit. Desktop
   * and dev builds leave this off — they report `latest` but never npm-install.
   */
  selfUpdate?: boolean;
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
  const autoUpdate = opts.autoUpdate ?? true;
  const selfUpdate = opts.selfUpdate ?? false;
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

  // What the user can DO about an available update on this surface. `latest` is
  // surfaced for information on every surface (even dev), but the apply action
  // depends on how this copy can actually be upgraded.
  const computeAction = (): UpdateStatus['action'] => {
    if (!autoUpdate) return 'none';
    if (!latest || latest === opts.currentVersion) return 'none';
    if (ctx.installable && selfUpdate) return 'upgrade-in-place'; // npm install + relaunch
    if (ctx.kind === 'desktop') return 'restart-to-update'; // bundled updater applies on relaunch
    return 'none'; // linked-dev / npx / unknown — informational only
  };

  const status = (): UpdateStatus => ({
    current: opts.currentVersion,
    latest,
    kind: ctx.kind,
    installable: ctx.installable,
    autoUpdate,
    action: computeAction(),
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
    if (!autoUpdate) return; // master switch off — no network activity at all
    if (checking || installing) return;
    checking = true;
    try {
      const found = await check(force);
      latest = found;
      // Auto-install only on the supervised npm surface; other surfaces still
      // record `latest` so the GUI can surface it (desktop → restart-to-update;
      // dev → informational), but never npm-install here.
      if (found && ctx.installable && selfUpdate) applyUpdate(found);
    } catch {
      // Best-effort: a failed registry check is silent and simply retried next
      // tick (the check, unlike the install, is not a user-facing operation).
    } finally {
      checking = false;
    }
  };

  return {
    start(): void {
      if (!autoUpdate) return; // disabled — never poll the network
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
      await runCheck(force); // no-ops when autoUpdate is off
      return status();
    },
  };
}
