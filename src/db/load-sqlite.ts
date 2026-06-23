import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import type Database from 'better-sqlite3';

// Lazy, self-healing loader for the `better-sqlite3` native module.
//
// `better-sqlite3` is a REQUIRED peer dependency whose compiled binary is
// pinned to the Node ABI (NODE_MODULE_VERSION) present at install time. When
// the consumer's Node changes — e.g. a Homebrew/nvm/Volta bump, or a different
// Node in CI vs. local — the prebuilt binary no longer loads and a static
// `import Database from 'better-sqlite3'` throws a cryptic native-load error
// (`NODE_MODULE_VERSION X … requires Y`) the moment the SQLite path is touched.
//
// The fix mirrors the lazy `createRequire` pattern already used for `pg`
// (see postgres.ts / gui/realtime.ts): the constructor is fetched at runtime,
// not at module-init. On top of that, this loader SELF-HEALS — when it detects
// a native-ABI mismatch it rebuilds `better-sqlite3` for the CURRENT runtime in
// the install root that owns it, then re-requires the freshly built binary
// in-process. An error is surfaced only as a last resort: the module is
// genuinely missing, the rebuild can't complete, or the operator opted out.

/** Constructor type for the runtime `better-sqlite3` default export. */
type DatabaseCtor = typeof Database;

/**
 * Shape of the `better-sqlite3` CommonJS module as required at runtime. The
 * native package exports the constructor as the CJS `module.exports`, which
 * `createRequire(...)('better-sqlite3')` returns directly (interop wrappers
 * also expose it on `.default`).
 */
type BetterSqlite3Module = DatabaseCtor & { default?: DatabaseCtor };

/** Resolve a real runtime `require`, working under both ESM and CJS bundles. */
function runtimeRequire(): NodeJS.Require {
  const importMetaUrl = (import.meta as { url?: string }).url;
  return importMetaUrl
    ? createRequire(importMetaUrl)
    : // CJS fallback — Node provides `require` on every CJS module scope. Under
      // tsup's CJS output `import.meta.url` is rewritten to undefined, so this
      // branch keeps the loader working in the published .cjs bundle.
      require;
}

/** Normalize the CJS export (handles the optional `.default` interop wrapper). */
function asCtor(mod: BetterSqlite3Module): DatabaseCtor {
  return mod.default ?? mod;
}

/**
 * Classify a require() error as a native-ABI mismatch (the recoverable case
 * this loader self-heals) vs. anything else (missing module, syntax error, …).
 *
 * An ABI mismatch is the failure mode where the .node binary loaded but was
 * compiled against a different Node ABI. Node surfaces it in a few shapes
 * across versions/platforms, so we match all of them:
 *   - the message contains `NODE_MODULE_VERSION` (the classic form), or
 *   - `err.code === 'ERR_DLOPEN_FAILED'` (the dlopen wrapper), or
 *   - the message mentions "was compiled against a different Node.js version".
 */
function isAbiMismatch(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown }).code;
  return (
    message.includes('NODE_MODULE_VERSION') ||
    code === 'ERR_DLOPEN_FAILED' ||
    message.includes('was compiled against a different Node.js version')
  );
}

/** A truthy-string check for the opt-out env var. */
function autoRebuildDisabled(): boolean {
  const v = process.env.LATTICE_SQLITE_NO_AUTOREBUILD;
  if (!v) return false;
  const normalized = v.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no';
}

/**
 * The install root that OWNS the `better-sqlite3` install — i.e. the directory
 * whose `node_modules/better-sqlite3` resolves. `npm rebuild` must run there so
 * it rebuilds the same copy this process loads. Resolved from the package.json
 * path: `.../node_modules/better-sqlite3/package.json` → up two levels is the
 * `node_modules` dir, up one more is its owning root.
 */
function installRootFor(req: NodeJS.Require): string {
  const pkgJsonPath = req.resolve('better-sqlite3/package.json');
  // .../<root>/node_modules/better-sqlite3/package.json
  //   dirname → .../<root>/node_modules/better-sqlite3
  //   ../..   → .../<root>
  return path.resolve(path.dirname(pkgJsonPath), '..', '..');
}

/** Result of a rebuild attempt — success or a short human-readable reason. */
type RebuildOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Run `npm rebuild better-sqlite3` synchronously for the current runtime in the
 * given install root. Cross-platform: resolves the npm binary per-platform and
 * spawns without a shell. Output is captured (not inherited) to keep success
 * quiet; on failure the captured stderr feeds the actionable error message.
 */
function defaultRebuild(installRoot: string): RebuildOutcome {
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npmBin, ['rebuild', 'better-sqlite3'], {
    cwd: installRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
  });
  if (res.error) {
    return { ok: false, reason: res.error.message };
  }
  if (res.status !== 0) {
    // `encoding: 'utf8'` makes stderr a string (empty string when the process
    // wrote nothing), so no null-coalescing or .toString() is needed.
    const stderr = res.stderr.trim();
    const tail = stderr ? stderr.slice(-300) : `npm rebuild exited with code ${String(res.status)}`;
    return { ok: false, reason: tail };
  }
  return { ok: true };
}

/** Injectable seams so the loader's logic is unit-testable without a real broken binary. */
export interface LoadSqliteOptions {
  /** Require implementation. Defaults to a runtime `require` rooted at this module. */
  require?: NodeJS.Require;
  /** Rebuild implementation. Defaults to `npm rebuild better-sqlite3` via spawnSync. */
  rebuild?: (installRoot: string) => RebuildOutcome;
  /** Resolve the install root that owns better-sqlite3. Defaults to package.json resolution. */
  installRoot?: (req: NodeJS.Require) => string;
  /** stderr logger for the one-line self-heal notice. Defaults to console.error. */
  log?: (msg: string) => void;
}

const PEER_DEP_MISSING_MESSAGE =
  'better-sqlite3 is a required peer dependency of latticesql — install it (npm install better-sqlite3).';

/**
 * Core loader logic, fully injectable for testing. Throws on unrecoverable
 * failure; otherwise returns the better-sqlite3 constructor.
 *
 * Note: callers must NOT cache the first (failed) require — only the
 * successfully resolved ctor. A fresh `require` after the rebuild is what loads
 * the newly built binary in-process (Node's module cache never recorded the
 * failed attempt, so the second require re-reads the .node file from disk).
 */
export function resolveSqliteCtor(options: LoadSqliteOptions = {}): DatabaseCtor {
  const req = options.require ?? runtimeRequire();
  const rebuild = options.rebuild ?? defaultRebuild;
  const resolveInstallRoot = options.installRoot ?? installRootFor;
  const log = options.log ?? ((msg: string) => process.stderr.write(msg + '\n'));

  let firstError: unknown;
  try {
    return asCtor(req('better-sqlite3') as BetterSqlite3Module);
  } catch (err) {
    firstError = err;
  }

  // Not an ABI mismatch → not something a rebuild fixes. The common case is a
  // genuinely-missing module (MODULE_NOT_FOUND); surface the peer-dep guidance
  // rather than attempting a rebuild of a package that isn't installed.
  if (!isAbiMismatch(firstError)) {
    throw new Error(PEER_DEP_MISSING_MESSAGE);
  }

  // ABI mismatch. Self-heal unless the operator opted out.
  if (autoRebuildDisabled()) {
    throw new Error(
      rebuildFailedMessage('automatic rebuild is disabled (LATTICE_SQLITE_NO_AUTOREBUILD)'),
    );
  }

  // Emit a single concise notice so a long rebuild isn't a silent hang.
  log('[latticesql] SQLite engine built for a different Node runtime — rebuilding better-sqlite3…');

  let installRoot: string;
  try {
    installRoot = resolveInstallRoot(req);
  } catch (err) {
    throw new Error(
      rebuildFailedMessage(
        'could not locate the better-sqlite3 install root (' +
          (err instanceof Error ? err.message : String(err)) +
          ')',
      ),
    );
  }

  const outcome = rebuild(installRoot);
  if (!outcome.ok) {
    throw new Error(rebuildFailedMessage(outcome.reason));
  }

  // Re-require after the rebuild. The first require did not cache (it threw),
  // so this reads the freshly built binary off disk in-process.
  try {
    return asCtor(req('better-sqlite3') as BetterSqlite3Module);
  } catch (err) {
    throw new Error(
      rebuildFailedMessage(
        'the rebuilt module still failed to load (' +
          (err instanceof Error ? err.message : String(err)) +
          ')',
      ),
    );
  }
}

/**
 * The single, system-agnostic, actionable error surfaced when self-heal can't
 * complete. Deliberately mentions NO specific Node version and NO machine path
 * — it must read identically on every system — and always names the manual
 * recovery command.
 */
function rebuildFailedMessage(reason: string): string {
  return (
    'latticesql: the better-sqlite3 native module doesn’t match this Node runtime ' +
    'and an automatic rebuild did not complete (' +
    reason +
    '). Run `npm rebuild better-sqlite3` (or reinstall) and retry.'
  );
}

// Module-level cache: load once, reuse the resolved constructor thereafter.
let _ctor: DatabaseCtor | null = null;

/**
 * Lazily load (and self-heal, if needed) the `better-sqlite3` constructor.
 * The successfully resolved constructor is cached for the process lifetime; a
 * failed load is never cached, so a subsequent call after a fixed install
 * succeeds.
 */
export function loadSqlite(): DatabaseCtor {
  if (_ctor) return _ctor;
  _ctor = resolveSqliteCtor();
  return _ctor;
}

/** Test-only: reset the module-level cache between cases. */
export function _resetSqliteCtorForTest(): void {
  _ctor = null;
}
