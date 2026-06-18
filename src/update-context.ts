/**
 * Install-context detection + the single npm-install code path shared by the
 * CLI updater, the supervised GUI relaunch, and {@link autoUpdate}.
 *
 * The running process can be reached as a global install, a project-local
 * dependency, an ephemeral `npx` run, or a linked/dev git checkout. Only the
 * first two can be safely upgraded with `npm install`; the others must NOT be
 * touched (a linked checkout would have its working tree clobbered, and an npx
 * run is gone on exit). `detectInstallContext` decides which case applies and
 * `installArgsFor` / `installLatest` centralize the (validated) npm invocation.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { analyticsEnabled } from './framework/user-config.js';

/** How the running copy of the package was installed. */
export type InstallKind = 'global' | 'local' | 'npx' | 'linked-dev' | 'unknown';

export interface InstallContext {
  kind: InstallKind;
  /** True only when an `npm install` may safely upgrade this copy in place. */
  installable: boolean;
  /** Directory to run the install from (the consumer project root for `local`). */
  cwd: string;
  /** Resolved package root of the running copy, if found. */
  packageRoot: string | null;
  /** Human-readable explanation (logged / surfaced in `/api/update/status`). */
  reason: string;
}

/**
 * Accepted published version shape. Validated before it is ever interpolated
 * into an npm argv, so a hostile registry response can't inject a shell token.
 */
export const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

export function isValidVersion(v: string): boolean {
  return SEMVER_RE.test(v);
}

/** Walk up from `start` to the nearest dir whose package.json names `pkgName`. */
function findPackageRoot(start: string, pkgName: string): string | null {
  let dir = start;
  for (let depth = 0; depth < 12; depth++) {
    const pkgJson = join(dir, 'package.json');
    if (existsSync(pkgJson)) {
      try {
        const { name } = JSON.parse(readFileSync(pkgJson, 'utf-8')) as { name?: string };
        if (name === pkgName) return dir;
      } catch {
        // unreadable/!json — keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isUnderGlobalPrefix(packageRoot: string, execPath: string): boolean {
  // A global install lives under <prefix>/lib/node_modules (POSIX) or
  // <prefix>/node_modules (Windows), where <prefix> is derived from the Node
  // binary's location. Compare against the execPath's grandparent as a robust,
  // platform-agnostic heuristic, plus the conventional path fragments.
  if (packageRoot.includes(`${sep}lib${sep}node_modules${sep}`)) return true;
  const prefix = dirname(dirname(execPath)); // <prefix>/bin/node -> <prefix>
  return packageRoot.startsWith(prefix + sep) && packageRoot.includes(`node_modules${sep}`);
}

export interface DetectOptions {
  /** Path of the running entry module. Defaults to `process.argv[1]`. */
  modulePath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  pkgName?: string;
}

/**
 * Decide whether/how the running copy may be auto-upgraded. Pure given its
 * inputs (all injectable) so it is exhaustively unit-testable without touching
 * the real filesystem layout.
 */
export function detectInstallContext(opts: DetectOptions = {}): InstallContext {
  const pkgName = opts.pkgName ?? 'latticesql';
  const env = opts.env ?? process.env;
  const execPath = opts.execPath ?? process.execPath;
  const rawCwd = opts.cwd ?? process.cwd();
  const rawModulePath = opts.modulePath ?? process.argv[1] ?? rawCwd;

  // Resolve symlinks BEFORE deriving any path. npm's global (and project-local)
  // bin is a SYMLINK — e.g. `<prefix>/bin/lattice -> ../lib/node_modules/latticesql/
  // dist/cli.js` — and Node leaves `process.argv[1]` as the raw symlink. Without
  // resolving it, findPackageRoot walks up from `<prefix>/bin` (which has no
  // package.json) and returns null, so detection falls through to `unknown`
  // (installable:false) and SILENTLY disables auto-update on the most common
  // surface (global install / desktop icon / CLI). Resolve BOTH the module path
  // and cwd so (a) the package root is found and (b) the local-vs-global compare
  // (`packageRoot === join(cwd, 'node_modules', pkg)`) stays symmetric — cwd can
  // carry symlink components too (macOS `/var -> /private/var`, `/tmp`, symlinked
  // project dirs). Keep the raw value when realpath fails (the path may not exist,
  // e.g. an injected modulePath in tests).
  const resolveReal = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const modulePath = resolveReal(rawModulePath);
  const cwd = resolveReal(rawCwd);

  const packageRoot = findPackageRoot(dirname(modulePath), pkgName);

  // 1. Linked / dev checkout — NEVER install over a working tree. A `.git` at
  //    the package root, or a symlinked node_modules entry, both mean "this is a
  //    development copy"; an `npm install` here would fight the checkout.
  if (packageRoot && existsSync(join(packageRoot, '.git'))) {
    return {
      kind: 'linked-dev',
      installable: false,
      cwd,
      packageRoot,
      reason: 'running from a git checkout — auto-update disabled (dev build)',
    };
  }
  const localLink = join(cwd, 'node_modules', pkgName);
  try {
    if (lstatSync(localLink).isSymbolicLink()) {
      return {
        kind: 'linked-dev',
        installable: false,
        cwd,
        packageRoot: packageRoot ?? localLink,
        reason: 'node_modules entry is a symlink (npm/yarn link) — auto-update disabled',
      };
    }
  } catch {
    // not present — fall through
  }

  // 2. npx — ephemeral; installing wouldn't persist past this run.
  const ua = env.npm_config_user_agent ?? '';
  const npxLike =
    ua.includes('npx') ||
    env.npm_command === 'exec' ||
    (packageRoot?.includes(`${sep}_npx${sep}`) ?? false) ||
    modulePath.includes(`${sep}_npx${sep}`);
  if (npxLike) {
    return {
      kind: 'npx',
      installable: false,
      cwd,
      packageRoot,
      reason: 'ephemeral npx run — nothing to upgrade in place',
    };
  }

  // 3. Project-local dependency — `npm install <pkg>@v` in the consumer's cwd.
  if (packageRoot && packageRoot === localLink) {
    return {
      kind: 'local',
      installable: true,
      cwd,
      packageRoot,
      reason: 'project-local dependency',
    };
  }

  // 4. Global install — `npm install -g <pkg>@v`.
  if (packageRoot && isUnderGlobalPrefix(packageRoot, execPath)) {
    return { kind: 'global', installable: true, cwd, packageRoot, reason: 'global install' };
  }

  return {
    kind: 'unknown',
    installable: false,
    cwd,
    packageRoot,
    reason: 'install location not recognized — auto-update disabled',
  };
}

/**
 * The npm argv for upgrading `pkgName` to `version` in this context, or `null`
 * when this context must not be auto-installed. `version` MUST be validated by
 * the caller (or this throws) so it can never carry a shell token.
 */
export function installArgsFor(
  ctx: InstallContext,
  version: string,
  pkgName = 'latticesql',
): string[] | null {
  if (!ctx.installable) return null;
  if (!isValidVersion(version)) {
    throw new Error(`refusing to install invalid version: ${JSON.stringify(version)}`);
  }
  const spec = `${pkgName}@${version}`;
  if (ctx.kind === 'global') return ['install', '-g', spec];
  if (ctx.kind === 'local') return ['install', spec];
  return null;
}

/**
 * Run the npm install for `version` in `ctx`. Returns true on success, false if
 * the context isn't installable. THROWS on a real install failure so the caller
 * can surface it loudly (never a silent swallow). Honors the analytics opt-out.
 */
export function installLatest(
  ctx: InstallContext,
  version: string,
  opts: { quiet?: boolean; pkgName?: string } = {},
): boolean {
  const args = installArgsFor(ctx, version, opts.pkgName ?? 'latticesql');
  if (!args) return false;
  execFileSync('npm', args, {
    cwd: ctx.cwd,
    stdio: opts.quiet ? 'ignore' : 'inherit',
    timeout: 120_000,
    env: analyticsEnabled() ? process.env : { ...process.env, SCARF_ANALYTICS: 'false' },
  });
  return true;
}
