import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Pick the directory the GUI should treat as the rendered-context root.
 *
 * Default render output is `./context`, but many projects render into the
 * project root (`.`) or a sibling dir. To avoid the failure mode where the
 * user runs `lattice gui` and sees "no rendered context" because the
 * manifest lives somewhere else, scan a small set of candidate directories
 * for an existing `.lattice/manifest.json` and pick the first hit.
 *
 * Behaviour:
 *   - If the user passed `--output` explicitly (any value other than the
 *     default `./context`), trust their choice unconditionally.
 *   - Otherwise, probe these in order:
 *       1. `./context` (the default)
 *       2. `.` (project root — common when `outputDir` is omitted from
 *          `lattice render`)
 *       3. `./generated`
 *     and return the first whose manifest exists. If none exist, return
 *     the default so `lattice render` later creates one.
 *
 * @param baseDir what the relative candidates are relative TO. Defaults to the
 *   process's working directory, which is right when the workspace being opened
 *   is the one the shell is standing in. It is NOT right for a workspace named
 *   by path from somewhere else — a probe rooted at the shell can then answer
 *   with a DIFFERENT workspace's rendered tree, and a reconciliation pointed at
 *   that tree renders one workspace into it and sweeps the other's contexts out
 *   of it. A caller that knows where the workspace lives passes that.
 */
export function discoverOutputDir(
  explicitOutput: string,
  explicit: boolean,
  baseDir?: string,
): string {
  if (explicit) return explicitOutput;
  const base = baseDir ?? process.cwd();
  const candidates = ['./context', '.', './generated'];
  for (const dir of candidates) {
    const resolved = resolve(base, dir);
    if (existsSync(join(resolved, '.lattice', 'manifest.json'))) {
      return baseDir === undefined ? dir : resolved;
    }
  }
  return baseDir === undefined ? explicitOutput : resolve(base, explicitOutput);
}
