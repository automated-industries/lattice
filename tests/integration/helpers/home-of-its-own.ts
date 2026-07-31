import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Give a command a test runs its own home directory, and answer the update check
 * from disk so it never reaches the network.
 *
 * Pointing `LATTICE_ROOT` and `LATTICE_CONFIG_DIR` at a scratch tree is not
 * enough on its own. The update check resolves its cache as `<home>/.lattice/`
 * from the home directory alone — no environment override reaches it — so a
 * command a test runs reads, and whenever that cache has gone stale rewrites, a
 * file in whatever home the test process inherited, and asks the package registry
 * for the answer over the network. Both are observable: run the same command with
 * a home of its own and the cache file appears there instead, holding the version
 * the registry named.
 *
 * So the home is the thing that has to move. Seeding the cache with a version
 * that cannot be newer than the one running means the check is answered from that
 * file, no request is made, and no upgrade notice is printed — which is what
 * keeps a run independent of the registry, and of there being a network at all.
 *
 * Returns the environment entries to merge into the child's `env`. `USERPROFILE`
 * is set alongside `HOME` because that is where the home directory is read from
 * on Windows.
 */
export function homeOfItsOwn(dir: string): { HOME: string; USERPROFILE: string } {
  const cacheDir = join(dir, '.lattice');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, 'update-check-latticesql.json'),
    JSON.stringify({ latest: '0.0.0', checked: Date.now() }),
  );
  return { HOME: dir, USERPROFILE: dir };
}
