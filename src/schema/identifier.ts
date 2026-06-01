/**
 * SQL identifier safety.
 *
 * Lattice quotes table and column names with double quotes when it builds
 * DDL (`CREATE TABLE "x" ("c" ...)`), but quoting alone is not a security
 * boundary: a name containing a double-quote, semicolon, or whitespace can
 * still terminate the quoted identifier and inject arbitrary SQL. Some DDL is
 * emitted with an empty parameter array, so the Postgres driver uses the
 * simple-query protocol — where a single `;` stacks a second statement. The
 * only robust defense is to constrain the identifier grammar before it ever
 * reaches a SQL string.
 *
 * `assertSafeIdentifier` is the universal last line of defense, called from
 * the schema manager's `_ensureTable` and `Lattice.addColumn` so every
 * CREATE/ALTER is covered regardless of caller. `assertExternalIdentifier`
 * adds reserved-prefix rejection for names that arrive from outside the
 * trust boundary (e.g. a Team share spec received over the network), so an
 * attacker cannot target Lattice's own `__lattice_*` bookkeeping tables.
 */

/** A bare SQL identifier: letter/underscore start, then letters/digits/underscore. */
export const SAFE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isSafeIdentifier(name: unknown): name is string {
  return typeof name === 'string' && SAFE_IDENTIFIER_RE.test(name);
}

/**
 * Throw unless `name` is a safe bare SQL identifier. Internal Lattice tables
 * (`__lattice_*`) pass — they match the grammar — so this is safe to call on
 * every DDL path without breaking framework bookkeeping.
 */
export function assertSafeIdentifier(
  name: unknown,
  kind: 'table' | 'column' | 'identifier' = 'identifier',
): string {
  if (!isSafeIdentifier(name)) {
    throw new Error(
      `Invalid ${kind} name: ${JSON.stringify(name)} — must match ${SAFE_IDENTIFIER_RE.source}`,
    );
  }
  return name;
}

/**
 * Throw unless `name` is a safe identifier AND does not use a reserved
 * `_lattice_` / `__lattice_` prefix. Use at trust boundaries where the name
 * is supplied by a remote party (Team object sharing), so a malicious peer
 * cannot create, alter, or shadow Lattice's internal tables.
 */
export function assertExternalIdentifier(
  name: unknown,
  kind: 'table' | 'column' | 'identifier' = 'identifier',
): string {
  const safe = assertSafeIdentifier(name, kind);
  const lower = safe.toLowerCase();
  if (lower.startsWith('__lattice_') || lower.startsWith('_lattice_')) {
    throw new Error(
      `Reserved ${kind} name: ${JSON.stringify(name)} — the "_lattice_"/"__lattice_" prefix is reserved for internal use`,
    );
  }
  return safe;
}
