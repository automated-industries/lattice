import { basename, dirname, join, resolve } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { parseDocument } from 'yaml';
import { parseConfigFile } from '../config/parser.js';
import { isPostgresUrl } from '../cloud/url.js';

/**
 * Config-file discovery + path resolution + create/delete helpers, extracted
 * from server.ts. Pure file/path utilities with no workspace-lifecycle (open/
 * reopen) dependency — they sit at the bottom of the config layer; openConfig and
 * the route handlers import FROM here.
 */

/**
 * Resolve the rendered-context root for a SPECIFIC config, probing relative to
 * that config's own directory (not the GUI launch cwd). Used when the GUI
 * switches to / creates a different database so each DB's rendered-context view
 * reflects its own render — never a stale launch-directory manifest. Returns an
 * absolute path; when no co-located manifest exists, returns `<configDir>/context`
 * (which has no manifest → the GUI shows no manifest-sourced entities for that
 * DB, instead of showing another DB's rendered files).
 */
export function resolveOutputDirForConfig(configPath: string): string {
  const base = dirname(resolve(configPath));
  for (const dir of ['context', '.', 'generated']) {
    const abs = resolve(base, dir);
    if (existsSync(join(abs, '.lattice', 'manifest.json'))) return abs;
  }
  return resolve(base, 'context');
}

/**
 * Friendly display name for a YAML config: prefer the `name:` key when
 * the user has set one (via Database Settings → rename), fall back to
 * the config file's basename minus the .yml extension. Pure function —
 * safe to use anywhere the GUI renders a DB label.
 */
export function friendlyConfigName(parsedName: string | undefined, configPath: string): string {
  if (parsedName && parsedName.trim().length > 0) return parsedName.trim();
  return basename(configPath).replace(/\.(ya?ml)$/, '');
}

/**
 * List sibling YAML configs in the same directory as the currently active
 * config. Each entry includes the parsed `db:` value when available so the
 * UI can show the underlying DB filename.
 */
export interface ListedConfig {
  path: string;
  name: string;
  label: string;
  dbFile: string;
  active: boolean;
  /** Per-row connection kind so the dropdown can tag each entry without probing. */
  kind: 'local' | 'cloud';
}

export function listConfigs(activeConfigPath: string): ListedConfig[] {
  const dir = dirname(activeConfigPath);
  const entries: ListedConfig[] = [];
  for (const fname of readdirSync(dir)) {
    if (!fname.endsWith('.yml') && !fname.endsWith('.yaml')) continue;
    const full = join(dir, fname);
    try {
      const parsed = parseConfigFile(full);
      entries.push({
        path: full,
        // `name` stays as the filename basename for compatibility with
        // existing callers that key by it (URL fragments, sort order).
        name: fname.replace(/\.(ya?ml)$/, ''),
        // `label` is the friendly DB name — what the user sees in the
        // dropdown + settings. Falls back to the basename when unset.
        label: friendlyConfigName(parsed.name, full),
        dbFile: basename(parsed.dbPath),
        active: full === activeConfigPath,
        // `${LATTICE_DB:...}` and postgres:// configs resolve to a
        // postgres URL; everything else is a local SQLite file. This
        // lets inactive rows show the correct Cloud/Local tag instead
        // of defaulting every non-active row to Local.
        kind: /^postgres(ql)?:\/\//i.test(parsed.dbPath) ? 'cloud' : 'local',
      });
    } catch {
      // Not a valid lattice config — skip silently.
    }
  }
  return entries.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Write a starter YAML config + an empty SQLite DB. The workspace starts with
 * NO entities (no example `items` table as of 1.16.3) — the user defines their
 * own schema via the Data Model editor or by editing the YAML.
 */
export function createBlankConfig(activeConfigPath: string, dbName: string): string {
  const dir = dirname(activeConfigPath);
  // Slug the user-provided name into a safe filename.
  const slug = dbName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Workspace name must contain at least one alphanumeric character');
  const configPath = join(dir, `${slug}.config.yml`);
  if (existsSync(configPath)) throw new Error(`Config already exists: ${slug}.config.yml`);
  const yaml = `db: ./data/${slug}.db\n\nentities: {}\n`;
  writeFileSync(configPath, yaml, 'utf8');
  // Ensure the data dir exists so opening the new config doesn't fail.
  mkdirSync(join(dir, 'data'), { recursive: true });
  return configPath;
}

/**
 * The on-disk db file behind a local SQLite config, or null when the config
 * points at a Postgres URL / `${LATTICE_DB:label}` / `:memory:` / `file:` (in
 * which case there is no local file for us to remove). Classifies from the raw
 * `db:` YAML line — deliberately NOT via parseConfigFile, so a cloud config
 * with a missing saved credential still classifies as cloud instead of throwing.
 */
export function sqliteFileForConfig(configPath: string): string | null {
  const dbVal = parseDocument(readFileSync(configPath, 'utf8')).get('db');
  const raw = (typeof dbVal === 'string' ? dbVal : '').trim();
  if (!raw) return null;
  if (isPostgresUrl(raw) || raw.startsWith('${LATTICE_DB:')) return null;
  if (raw === ':memory:' || raw.startsWith('file:')) return null;
  return resolve(dirname(configPath), raw);
}

/**
 * Permanently delete a database: its YAML config and — for a local SQLite DB —
 * the underlying `.db` file plus its `-wal`/`-shm`/`-journal` siblings.
 * Destructive + irreversible; the caller is responsible for confirmation and
 * (when deleting the active DB) switching away first so the file handle is
 * released before we unlink. For cloud configs only the local YAML is removed —
 * the remote Postgres database is shared and is never touched from here.
 */
export function deleteDatabaseFiles(targetConfigPath: string): {
  deletedConfig: string;
  deletedDbFile: string | null;
} {
  const sqliteFile = sqliteFileForConfig(targetConfigPath);
  unlinkSync(targetConfigPath);
  let deletedDbFile: string | null = null;
  if (sqliteFile && existsSync(sqliteFile)) {
    unlinkSync(sqliteFile);
    deletedDbFile = sqliteFile;
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = sqliteFile + suffix;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
  }
  return { deletedConfig: basename(targetConfigPath), deletedDbFile };
}
