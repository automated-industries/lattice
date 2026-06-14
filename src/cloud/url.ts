/**
 * True iff `url` parses as a `postgres://` / `postgresql://` URL. Used by
 * the GUI to distinguish a cloud (shared Postgres) connection from a local
 * SQLite file path.
 */
export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url);
}
