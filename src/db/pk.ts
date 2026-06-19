/**
 * Pure primary-key serialization — the single source of truth for the canonical
 * `pk` string used by the ACL bookkeeping (`__lattice_owners` / `__lattice_row_grants`),
 * the change-log key, and the cloud-RLS SQL that reconstructs it. A single-column
 * key serializes to the bare value (so all pre-2.2.1 single-`id` data stays valid);
 * a composite key encodes EVERY pk column in declared order, joined by a TAB.
 *
 * Dependency-free leaf: it imports nothing and takes the resolved `pkCols` per
 * call (symmetrical with {@link pkSqlExpr}), so it couples to neither the schema
 * manager nor the column cache — the same shape as the pure-constant
 * `db/lock-ids.ts` leaf. lattice.ts and cloud/rls.ts both import FROM here.
 */

/**
 * Structural mirror of lattice.ts's exported `PkLookup` — redeclared locally
 * rather than imported, to keep this module a true leaf with zero outgoing edges
 * (the same technique `changelog/service.ts` uses to dodge a circular import).
 */
export type PkLookup = string | Record<string, unknown>;

/** The canonical pk separator: a literal TAB (U+0009). SQL counterpart is `chr(9)`. */
export const PK_SEP = '\t';

/**
 * Canonical ACL / change-log `pk` string for a row (the WRITE side —
 * insert/upsert). Empty `pkCols` falls back to `['id']`; a null/undefined cell
 * serializes to '' (NOT the string 'null'/'undefined').
 */
export function serializeRowPk(pkCols: readonly string[], row: Record<string, unknown>): string {
  const cols = pkCols.length > 0 ? pkCols : ['id'];
  return cols
    .map((c) => {
      const v = row[c];
      return v != null ? String(v as string | number) : '';
    })
    .join(PK_SEP);
}

/**
 * Canonical `pk` string for a {@link PkLookup} (the READ/address side —
 * update/delete/observe), so a row addressed by lookup keys its change-log
 * entry identically to the way {@link serializeRowPk} keyed it at insert time.
 *
 * Two asymmetries vs {@link serializeRowPk}, both load-bearing: a string `id` is
 * returned VERBATIM before any column lookup (single-column key → bare value),
 * and the empty-`pkCols` fallback is `JSON.stringify(id)`, not `['id']`.
 */
export function serializePkLookup(pkCols: readonly string[], id: PkLookup): string {
  if (typeof id === 'string') return id; // single-column key — the bare value
  if (pkCols.length === 0) return JSON.stringify(id);
  return pkCols
    .map((c) => {
      const v = id[c];
      return v != null ? String(v as string | number) : '';
    })
    .join(PK_SEP);
}

/**
 * Canonical pk SQL expression with a caller-chosen column prefix: `''` for a
 * policy row context (`CAST("id" AS TEXT)`), or `NEW.`/`OLD.` for a trigger
 * (`CAST(NEW."id" AS TEXT)`). Single column → bare (no separator). The TAB is
 * `chr(9)` (Postgres — the only dialect that runs cloud RLS).
 */
export function pkSqlExpr(pkCols: readonly string[], prefix: string): string {
  if (pkCols.length === 0) {
    throw new Error('cloud RLS: cannot key a table with no primary key column');
  }
  return pkCols.map((c) => `CAST(${prefix}"${c}" AS TEXT)`).join(` || chr(9) || `);
}
