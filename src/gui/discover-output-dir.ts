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
 */
export function discoverOutputDir(explicitOutput: string, explicit: boolean): string {
  if (explicit) return explicitOutput;
  const candidates = ['./context', '.', './generated'];
  for (const dir of candidates) {
    if (existsSync(join(resolve(dir), '.lattice', 'manifest.json'))) return dir;
  }
  return explicitOutput;
}
