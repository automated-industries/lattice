import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rootConfigDir } from './lattice-root.js';

/**
 * Non-destructive migration of the legacy machine-local config (`~/.lattice`
 * or `LATTICE_CONFIG_DIR`) into a `.lattice` root's `.config/`. Originals are
 * left intact so an older Lattice binary keeps working; nothing is moved or
 * deleted. Only runs when the legacy location has a `master.key` and the root's
 * `.config/` does not yet — so it never clobbers an already-initialized root.
 */
export interface MigrateResult {
  /** True when at least one legacy file was copied in. */
  migrated: boolean;
  /** The legacy directory that was read from (when migrated). */
  from?: string;
  /** Names of the entries copied (files/dirs). */
  copied: string[];
}

const LEGACY_ENTRIES = [
  'master.key',
  'identity.json',
  'preferences.json',
  'db-credentials.enc',
  'keys',
] as const;

export function importLegacyUserConfig(root: string): MigrateResult {
  const legacy = process.env.LATTICE_CONFIG_DIR ?? join(homedir(), '.lattice');
  const dest = rootConfigDir(root);
  const copied: string[] = [];

  // Nothing to migrate unless the legacy store actually holds a key.
  if (!existsSync(join(legacy, 'master.key'))) return { migrated: false, copied };
  // Never overwrite an already-initialized root config (also guards legacy===dest).
  if (existsSync(join(dest, 'master.key'))) return { migrated: false, copied };

  mkdirSync(dest, { recursive: true });
  for (const entry of LEGACY_ENTRIES) {
    const src = join(legacy, entry);
    if (existsSync(src)) {
      cpSync(src, join(dest, entry), { recursive: true });
      copied.push(entry);
    }
  }

  return copied.length > 0 ? { migrated: true, from: legacy, copied } : { migrated: false, copied };
}
