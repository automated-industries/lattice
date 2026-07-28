import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_SUBDIR,
  ROOT_DIRNAME,
  discoverLatticeRootUpward,
  homeLatticeRoot,
  registryPath,
  resolveSessionRoot,
} from '../../src/framework/lattice-root.js';
import { ensureRootForGui } from '../../src/framework/gui-bootstrap.js';
import { addWorkspace, listWorkspaces } from '../../src/framework/workspace.js';

/**
 * A session must never inherit a root just because one happens to sit above the
 * directory it was launched from.
 *
 * The incident this pins: a GUI started deep inside a checkout resolved its root
 * by searching UPWARD, found a stray development registry left there months
 * earlier, and opened one of its workspaces — a cloud workspace belonging to
 * someone else, complete with working key material. Nothing about the launch
 * named that root; the search simply found it.
 *
 * The rule now: a session uses the HOME root unless a root was named explicitly
 * (`--root`, or the LATTICE_ROOT environment override). Upward search is still
 * available as a primitive for callers that have a concrete anchor (a config
 * file's directory), but it is no longer how a session picks its data.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function tmp(prefix = 'lattice-session-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Point `homedir()` at a throwaway directory (POSIX reads HOME, Windows USERPROFILE). */
function useHome(dir: string): void {
  vi.stubEnv('HOME', dir);
  vi.stubEnv('USERPROFILE', dir);
}

/** A root with a `.config` marker and one registered workspace. */
function makeRootWithWorkspace(base: string, displayName: string, db?: string): string {
  const root = join(base, ROOT_DIRNAME);
  mkdirSync(join(root, CONFIG_SUBDIR), { recursive: true });
  addWorkspace(root, { displayName, ...(db !== undefined ? { db } : {}) });
  return root;
}

describe('session root resolution', () => {
  it('a session deep inside a tree with a parent registry uses the HOME root, not the discovered one', () => {
    const checkout = tmp('lattice-checkout-');
    const stray = makeRootWithWorkspace(checkout, 'Someone Elses Cloud', '${LATTICE_DB:foreign}');
    const deep = join(checkout, 'packages', 'app', 'src');
    mkdirSync(deep, { recursive: true });

    const home = tmp('lattice-home-');
    useHome(home);

    const resolved = resolveSessionRoot({ startDir: deep });

    expect(resolved.root).toBe(join(home, ROOT_DIRNAME));
    expect(resolved.source).toBe('home');
    // The upward search still SEES the stray root — it just no longer wins.
    expect(discoverLatticeRootUpward(deep)).toBe(stray);
    expect(resolved.shadowed).toBe(stray);
  });

  it('an explicitly named root is still honoured', () => {
    const checkout = tmp('lattice-checkout-');
    const named = makeRootWithWorkspace(checkout, 'Deliberate');
    const home = tmp('lattice-home-');
    useHome(home);

    const resolved = resolveSessionRoot({ explicitRoot: named, startDir: home });

    expect(resolved.root).toBe(named);
    expect(resolved.source).toBe('explicit');
    // Nothing was silently swapped, so there is nothing to warn about.
    expect(resolved.shadowed).toBeNull();
  });

  it('the LATTICE_ROOT environment override still wins and is used verbatim', () => {
    const checkout = tmp('lattice-checkout-');
    makeRootWithWorkspace(checkout, 'Stray');
    const deep = join(checkout, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    const home = tmp('lattice-home-');
    useHome(home);

    const override = join(tmp('lattice-override-'), ROOT_DIRNAME);
    vi.stubEnv('LATTICE_ROOT', override);

    const resolved = resolveSessionRoot({ startDir: deep });
    expect(resolved.root).toBe(override);
    expect(resolved.source).toBe('env');
    expect(resolved.shadowed).toBeNull();
  });

  it('reports nothing to migrate when the upward search would have found the same root', () => {
    const home = tmp('lattice-home-');
    useHome(home);
    mkdirSync(join(home, ROOT_DIRNAME, CONFIG_SUBDIR), { recursive: true });
    const deep = join(home, 'projects', 'thing');
    mkdirSync(deep, { recursive: true });

    const resolved = resolveSessionRoot({ startDir: deep });
    expect(resolved.root).toBe(homeLatticeRoot());
    expect(resolved.shadowed).toBeNull();
  });

  it('reports nothing to migrate when there is no root above the start directory', () => {
    const bare = tmp('lattice-bare-');
    const home = tmp('lattice-home-');
    useHome(home);

    expect(resolveSessionRoot({ startDir: bare }).shadowed).toBeNull();
  });
});

describe('GUI bootstrap never adopts a foreign registry', () => {
  it('opens the home root and none of the stray registry’s workspaces', () => {
    const checkout = tmp('lattice-checkout-');
    const stray = makeRootWithWorkspace(checkout, 'Someone Elses Cloud', '${LATTICE_DB:foreign}');
    const deep = join(checkout, 'packages', 'app');
    mkdirSync(deep, { recursive: true });

    const home = tmp('lattice-home-');
    useHome(home);

    const boot = ensureRootForGui({
      startDir: deep,
      configPath: join(deep, 'lattice.config.yml'),
      explicitConfig: false,
    });

    expect(boot.root).toBe(join(home, ROOT_DIRNAME));
    expect(boot.root).not.toBe(stray);
    // The session's registry is the home one, and it never learned about the
    // stray root's workspaces.
    expect(registryPath(boot.root).startsWith(join(home, ROOT_DIRNAME))).toBe(true);
    expect(listWorkspaces(boot.root).map((w) => w.displayName)).not.toContain(
      'Someone Elses Cloud',
    );
    // And the stray registry itself is untouched — this is a resolution change,
    // not a cleanup.
    expect(listWorkspaces(stray).map((w) => w.displayName)).toContain('Someone Elses Cloud');
  });

  it('names the root the old upward search would have used, exactly once, without blocking', () => {
    const checkout = tmp('lattice-checkout-');
    const stray = makeRootWithWorkspace(checkout, 'Older Work');
    const deep = join(checkout, 'nested');
    mkdirSync(deep, { recursive: true });
    const home = tmp('lattice-home-');
    useHome(home);

    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const first = ensureRootForGui({
      startDir: deep,
      configPath: join(deep, 'lattice.config.yml'),
      explicitConfig: false,
    });
    expect(first.shadowedRoot).toBe(stray);

    const notices = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(stray));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(first.root);

    // Second launch from the same place must not repeat itself.
    ensureRootForGui({
      startDir: deep,
      configPath: join(deep, 'lattice.config.yml'),
      explicitConfig: false,
    });
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(stray))).toHaveLength(
      1,
    );
  });

  it('opens a repo-local root when it is explicitly asked for', () => {
    const checkout = tmp('lattice-checkout-');
    const local = makeRootWithWorkspace(checkout, 'Repo Local');
    const home = tmp('lattice-home-');
    useHome(home);

    const boot = ensureRootForGui({
      startDir: checkout,
      root: local,
      configPath: join(checkout, 'lattice.config.yml'),
      explicitConfig: false,
    });

    expect(boot.root).toBe(local);
    expect(listWorkspaces(boot.root).map((w) => w.displayName)).toContain('Repo Local');
    expect(boot.shadowedRoot).toBeNull();
  });
});

describe('the config-dir resolver follows the session root', () => {
  it('does not adopt a stray root’s .config by searching upward', async () => {
    const checkout = tmp('lattice-checkout-');
    const strayConfig = join(checkout, ROOT_DIRNAME, CONFIG_SUBDIR);
    mkdirSync(strayConfig, { recursive: true });
    writeFileSync(join(strayConfig, 'master.key'), 'c3RyYXkta2V5\n', 'utf8');
    const deep = join(checkout, 'a', 'b');
    mkdirSync(deep, { recursive: true });

    const home = tmp('lattice-home-');
    useHome(home);
    // The test harness pins LATTICE_CONFIG_DIR; clear it so the real resolution
    // order runs.
    vi.stubEnv('LATTICE_CONFIG_DIR', '');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(deep);

    const { configDir } = await import('../../src/framework/user-config.js');
    expect(configDir()).not.toBe(strayConfig);
    expect(configDir()).toBe(join(home, ROOT_DIRNAME, CONFIG_SUBDIR));
    cwd.mockRestore();
  });
});

describe('runtime routes write to the session’s registry', () => {
  it('uses the root the session resolved, not one found above the active config', async () => {
    const { rootForDbConfig } = await import('../../src/gui/dbconfig/shared.js');

    const checkout = tmp('lattice-checkout-');
    const stray = makeRootWithWorkspace(checkout, 'Stray');
    // An adopted-in-place config living inside that checkout: searching upward
    // from it lands on the stray root, which is how a migrate-to-cloud or a
    // rename used to write into a registry the session never opened.
    const configPath = join(checkout, 'project', 'lattice.config.yml');
    mkdirSync(join(checkout, 'project'), { recursive: true });
    writeFileSync(configPath, 'name: Project\ndb: ./data.db\nentities: {}\n', 'utf8');

    const home = tmp('lattice-home-');
    useHome(home);
    const sessionRoot = join(home, ROOT_DIRNAME);
    mkdirSync(join(sessionRoot, CONFIG_SUBDIR), { recursive: true });

    expect(discoverLatticeRootUpward(join(checkout, 'project'))).toBe(stray);
    expect(rootForDbConfig({ latticeRoot: sessionRoot, configPath })).toBe(sessionRoot);
  });

  it('falls back to the config’s own root only when the caller named none', async () => {
    const { rootForDbConfig } = await import('../../src/gui/dbconfig/shared.js');

    const checkout = tmp('lattice-checkout-');
    const own = makeRootWithWorkspace(checkout, 'Embedded');
    const configPath = join(checkout, 'lattice.config.yml');
    const home = tmp('lattice-home-');
    useHome(home);

    expect(rootForDbConfig({ latticeRoot: null, configPath })).toBe(own);
  });
});
