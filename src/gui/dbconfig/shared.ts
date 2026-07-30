import type { Lattice } from '../../lattice.js';
import { dirname } from 'node:path';
import { findLatticeRoot } from '../../framework/lattice-root.js';
import { normalizeLabel } from '../../framework/db-pointer.js';
import type { CloudWorkspaceCreator } from '../../cloud/join.js';

export interface DbConfigContext {
  db: Lattice;
  configPath: string;
  /**
   * The `.lattice` root this session resolved, or null when the GUI was opened
   * on a plain config outside one. Routes that write to the registry (migrating
   * a workspace to cloud, renaming one) must use THIS, not a root found by
   * searching upward from {@link configPath} — see {@link rootForDbConfig}.
   */
  latticeRoot: string | null;
  pathname: string;
  method: string;
  /** Tables the open-time cloud converge couldn't manage (owner mismatch, etc.),
   *  echoed to the client in GET /api/dbconfig so the UI can show an actionable
   *  warning instead of a silent partial converge. Empty on a clean open. */
  convergeWarnings: { table: string; reason: string }[];
  /**
   * Re-open the same configPath after the YAML has been updated.
   * Closes the current Lattice and replaces it. Caller-owned because
   * the parent server holds the mutable `active` reference.
   */
  swap: () => Promise<void>;
  /**
   * Stop serving the current workspace and fall back to the welcome state.
   *
   * For the one case {@link DbConfigContext.swap} cannot recover from: the store
   * this session holds open is no longer the store the workspace points at, so
   * continuing to serve it would write into a file nothing will ever read again.
   * Closing it makes the next request say so instead.
   */
  retire: () => Promise<void>;
  /**
   * Join a cloud as a NEW workspace: save the credential under `key`, scaffold a
   * new cloud workspace named `displayName` pointing at `${LATTICE_DB:key}`, then
   * open + activate it. Atomic (rolls back on failure). Returns the new workspace
   * id. Used by the member join/redeem path so it never repoints (hijacks) the
   * currently-open workspace.
   */
  createCloudWorkspace: CloudWorkspaceCreator;
}

// The connection-string helpers moved to the cloud layer, where the join and
// invite capabilities can reach them without importing anything that serves
// requests. Re-exported here so every existing importer keeps resolving.
export { buildPostgresUrl, parsePostgresUrl } from '../../cloud/url.js';

// Which database a config points at — the credential key charset, the `db:` line
// rewrite, and the config-relative path resolution — moved to the framework for
// the same reason: repointing a workspace is what a migration does, and a
// migration must be callable with no server in the process.
export {
  rewriteDbLine,
  normalizeLabel,
  resolveRelativeToConfig,
} from '../../framework/db-pointer.js';

export interface SavePostgres {
  type: 'postgres';
  label: string;
  host: string;
  port: number | string;
  dbname: string;
  user: string;
  password: string;
}

export interface SaveSqlite {
  type: 'sqlite';
  path: string;
}

/** The offending field on a parse failure, so the caller can report WHICH input was wrong. */
export type SaveField = 'type' | 'label' | 'host' | 'dbname' | 'user' | 'port' | 'path';

export interface SaveParseError {
  error: string;
  field?: SaveField;
}

export type SaveParseResult =
  | { ok: true; value: SavePostgres | SaveSqlite }
  | ({ ok: false } & SaveParseError);

/**
 * Parse + validate a db-config save body, returning a SPECIFIC reason on failure.
 *
 * A single sentinel (the old `null`) forced every caller to report one generic
 * message, which is how a rejected LABEL surfaced to the user as "Invalid Postgres
 * credentials" before any connection was even attempted. This returns the offending
 * field so a validation failure is never mistaken for a credentials/network fault —
 * that wording is reserved for a real authentication error from the server.
 *
 * The postgres label is NORMALIZED (see {@link normalizeLabel}) rather than rejected,
 * so a label with spaces just works; only a label that normalizes to empty is an error.
 */
export function parseSaveBodyResult(body: Record<string, unknown>): SaveParseResult {
  const type = body.type;
  if (type === 'sqlite') {
    const path = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : '';
    if (!path) return { ok: false, error: 'A database file path is required.', field: 'path' };
    return { ok: true, value: { type: 'sqlite', path } };
  }
  if (type === 'postgres') {
    const rawLabel = typeof body.label === 'string' ? body.label.trim() : '';
    if (!rawLabel) return { ok: false, error: 'A workspace label is required.', field: 'label' };
    const label = normalizeLabel(rawLabel);
    if (!label)
      return {
        ok: false,
        error: 'The label needs at least one letter or number.',
        field: 'label',
      };
    const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : '';
    if (!host) return { ok: false, error: 'A host is required.', field: 'host' };
    const dbname = typeof body.dbname === 'string' && body.dbname.trim() ? body.dbname.trim() : '';
    if (!dbname) return { ok: false, error: 'A database name is required.', field: 'dbname' };
    const user = typeof body.user === 'string' && body.user.trim() ? body.user : '';
    if (!user) return { ok: false, error: 'A user is required.', field: 'user' };
    const password = typeof body.password === 'string' ? body.password : '';
    const port = typeof body.port === 'number' ? body.port : Number(body.port ?? 5432);
    if (Number.isNaN(port))
      return { ok: false, error: 'The port must be a number.', field: 'port' };
    return { ok: true, value: { type: 'postgres', label, host, port, dbname, user, password } };
  }
  return { ok: false, error: 'Unknown config type.', field: 'type' };
}

/**
 * Back-compat wrapper: the parsed config, or null on any failure. Callers that only
 * branch on success keep working; callers that want to tell the user WHAT was wrong
 * (and must not mislabel a validation failure as a credentials error) use
 * {@link parseSaveBodyResult} instead.
 */
export function parseSaveBody(body: Record<string, unknown>): SavePostgres | SaveSqlite | null {
  const r = parseSaveBodyResult(body);
  return r.ok ? r.value : null;
}

/**
 * The root a dbconfig route should write its registry changes to.
 *
 * The session's root wins. Searching upward from the config would pick whatever
 * root sits above it, and an adopted-in-place config can easily live inside a
 * checkout that still holds a leftover `.lattice` — writing this workspace's
 * cloud migration or rename into a registry the session never opened. Upward
 * search remains only as the fallback for an embedder that named no root, which
 * is the same fallback the server itself uses.
 */
export function rootForDbConfig(ctx: {
  latticeRoot: string | null;
  configPath: string;
}): string | null {
  return ctx.latticeRoot ?? findLatticeRoot(dirname(ctx.configPath));
}
