/**
 * Postgres connection-string helpers.
 *
 * These are pure string functions with no imports at all, which is why they sit
 * here rather than beside the connection form that first needed them: joining a
 * cloud, inviting a member, and probing a candidate database all have to turn
 * host/port/database/user/password into a URL and back, and none of those should
 * have to reach into a request-handling module to do it.
 */

/**
 * True iff `url` parses as a `postgres://` / `postgresql://` URL. Used by
 * the GUI to distinguish a cloud (shared Postgres) connection from a local
 * SQLite file path.
 */
export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url);
}

/** Build a Postgres URL from form fields. Percent-encodes user + password. */
export function buildPostgresUrl(params: {
  host: string;
  port: number;
  dbname: string;
  user: string;
  password: string;
}): string {
  const u = encodeURIComponent(params.user);
  const p = encodeURIComponent(params.password);
  return `postgres://${u}:${p}@${params.host}:${String(params.port)}/${params.dbname}`;
}

/** Parse a Postgres URL back into its component fields (no password). */
export function parsePostgresUrl(url: string): {
  host: string;
  port: number;
  dbname: string;
  user: string;
} | null {
  try {
    const u = new URL(url);
    if (!/^postgres(ql)?:$/i.test(u.protocol)) return null;
    const dbname = u.pathname.replace(/^\//, '');
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      dbname,
      user: decodeURIComponent(u.username),
    };
  } catch {
    return null;
  }
}
