import { randomBytes } from 'node:crypto';
import type { Lattice } from '../lattice.js';
import { runAsyncOrSync, allAsyncOrSync, getAsyncOrSync } from '../db/adapter.js';
import { MEMBER_GROUP } from './rls.js';
import { cloudRlsInstalled } from '../framework/cloud-connect.js';

/**
 * Cloud member provisioning. A "member" is a scoped, non-superuser Postgres LOGIN
 * role that connects to the shared cloud database DIRECTLY — there is no server.
 * The member inherits schema / connect / table privileges from the {@link
 * MEMBER_GROUP} group, while Postgres RLS (see ./rls.ts) confines it to the rows
 * it owns or has been granted: even with its own `psql` it cannot read another
 * member's data.
 *
 * Provisioning runs as the cloud OWNER connection, which must hold `CREATEROLE`
 * (the human DBA may instead pre-create roles and skip this). Members are created
 * `NOSUPERUSER NOCREATEDB NOCREATEROLE`, so the credential a member holds is a
 * dead end for privilege escalation.
 */

// A safe Postgres role name: starts with a letter/underscore, then word chars,
// max 63 bytes (Postgres identifier limit). Validated before interpolation.
const ROLE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
// A member password is hex (from generateMemberPassword) so it is always safe to
// interpolate into CREATE/ALTER ROLE — DDL can't bind a parameter for it.
const HEX_PW_RE = /^[0-9a-f]{16,}$/;

function assertPg(db: Lattice): void {
  if (db.getDialect() !== 'postgres') {
    throw new Error(
      'lattice: cloud members require a Postgres cloud (SQLite is single-user/local)',
    );
  }
}

/** A URL-safe random password (48 hex chars) for a new member role. */
export function generateMemberPassword(): string {
  return randomBytes(24).toString('hex');
}

/**
 * Derive a safe, unique Postgres role name from a free-form label (e.g. an email
 * or display name). Lowercased, non-word chars collapsed to `_`, prefixed so it
 * always starts legally and namespaced under `lm_`, with a short random suffix so
 * two people with similar labels never collide.
 */
export function memberRoleName(label: string): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'member';
  return `lm_${base}_${randomBytes(3).toString('hex')}`.slice(0, 63);
}

/**
 * Create (or re-key) a scoped member LOGIN role and add it to the member group.
 * Idempotent on the role's existence: a re-invite rotates the password. Requires
 * the connection to hold `CREATEROLE`. After this, the member connects with
 * `postgres://<role>:<password>@<host>/<db>` and sees only its permitted rows.
 */
export async function provisionMemberRole(
  db: Lattice,
  role: string,
  password: string,
): Promise<void> {
  assertPg(db);
  if (!ROLE_RE.test(role)) throw new Error(`lattice: invalid member role name "${role}"`);
  if (!HEX_PW_RE.test(password)) {
    throw new Error('lattice: member password must be hex — use generateMemberPassword()');
  }
  await runAsyncOrSync(
    db.adapter,
    `DO $LATTICE$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
         CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}';
       ELSE
         -- Re-invite of an EXISTING role: set ONLY what changed (login + password).
         -- Restating NOSUPERUSER/superuser-class attrs trips Supabase supautils
         -- ("only superuser may alter the SUPERUSER attribute", 42501) since the
         -- owner 'postgres' isn't a true superuser. The role was already created
         -- NOSUPERUSER NOCREATEDB NOCREATEROLE, so there is nothing to restate.
         ALTER ROLE "${role}" WITH LOGIN PASSWORD '${password}';
       END IF;
     END $LATTICE$`,
  );
  await runAsyncOrSync(db.adapter, `GRANT ${MEMBER_GROUP} TO "${role}"`);
}

// Sharing levels a row owner may set, mirroring lattice_set_row_visibility's CHECK.
const VISIBILITY = new Set(['private', 'everyone']);

/**
 * Change a row's sharing through the owner-only `lattice_set_row_visibility`
 * SECURITY DEFINER function. Only the row's owner (Postgres raises for anyone
 * else, enforced inside the function) may call it. `pk` is the row's canonical
 * primary-key string — a single-column key is the bare value; a composite key is
 * its columns joined by TAB, matching Lattice's serialization.
 */
export async function setRowVisibility(
  db: Lattice,
  table: string,
  pk: string,
  visibility: string,
): Promise<void> {
  assertPg(db);
  if (!VISIBILITY.has(visibility)) {
    throw new Error(`lattice: invalid visibility "${visibility}" (expected private | everyone)`);
  }
  await runAsyncOrSync(db.adapter, `SELECT lattice_set_row_visibility(?, ?, ?)`, [
    table,
    pk,
    visibility,
  ]);
}

/** Per-row sharing summary the GUI attaches to each row as `_access`. */
export interface RowAccess {
  visibility: 'private' | 'everyone' | 'custom';
  /** True when the connected role owns the row (only the owner may re-share). */
  ownedByMe: boolean;
  /** Member roles a `custom`-shared row is shared with (owner view only). */
  grantees?: string[];
}

/**
 * Batched per-row access summary over `__lattice_owners` (+ `__lattice_row_grants`
 * for custom shares), keyed by each row's canonical primary-key string. The GUI
 * attaches the result to rows as `_access` so the per-row sharing affordance can
 * render — it is hidden when `_access` is absent, which is why the 3.0 RLS rewrite
 * (which dropped the old `__lattice_row_acl` enrichment without a replacement)
 * made sharing "disappear". Returns an empty map when the active DB is not a
 * secured cloud (SQLite, or a Postgres without the RLS layer) — those workspaces
 * correctly show no sharing UI. One query per page (bounded, not per-row).
 */
export async function rowAccessSummaries(
  db: Lattice,
  table: string,
  pks: readonly string[],
): Promise<Map<string, RowAccess>> {
  const out = new Map<string, RowAccess>();
  if (db.getDialect() !== 'postgres' || pks.length === 0) return out;
  if (!(await cloudRlsInstalled(db))) return out;
  // #2.1 — go through the SECURITY DEFINER summary function, NOT a direct read of
  // __lattice_owners: members have no grant on that bookkeeping table, so the
  // direct read 500'd every member row fetch. The function returns only the rows
  // the caller can see (lattice_row_visible) + whether the caller owns each.
  const owners = (await allAsyncOrSync(
    db.adapter,
    `SELECT "pk", "visibility", "owned" FROM lattice_rows_access(?, ?)`,
    [table, [...pks]],
  )) as { pk: string; visibility: string | null; owned: unknown }[];
  for (const o of owners) {
    out.set(o.pk, {
      visibility: (o.visibility ?? 'private') as RowAccess['visibility'],
      ownedByMe: o.owned === true || o.owned === 't' || o.owned === 1,
    });
  }
  const customPks = owners.filter((o) => o.visibility === 'custom').map((o) => o.pk);
  if (customPks.length > 0) {
    // Grantees of the caller's OWN custom-shared rows (member-safe DEFINER fn).
    const grants = (await allAsyncOrSync(
      db.adapter,
      `SELECT "pk", "grantee_role" FROM lattice_row_grantees(?, ?)`,
      [table, customPks],
    )) as { pk: string; grantee_role: string }[];
    for (const g of grants) {
      const a = out.get(g.pk);
      if (a) (a.grantees ??= []).push(g.grantee_role);
    }
  }
  return out;
}

/**
 * Guard for invite minting (security non-regression): only a freshly provisioned,
 * non-privileged `lm_*` member role may be embedded in an invite token. Refuse a
 * role that is superuser / has CREATEROLE / has BYPASSRLS, or that is the cloud
 * owner itself (the connecting role) — none of which must ever leave the owner's
 * machine inside a member-facing token. Throws loudly; never silently downgrades.
 */
export async function assertScopedMemberRole(db: Lattice, role: string): Promise<void> {
  assertPg(db);
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT rolsuper, rolcreaterole, rolbypassrls, (rolname = session_user) AS is_self
       FROM pg_roles WHERE rolname = ?`,
    [role],
  )) as
    | { rolsuper: unknown; rolcreaterole: unknown; rolbypassrls: unknown; is_self: unknown }
    | undefined;
  if (!row) throw new Error(`lattice: role "${role}" does not exist`);
  const truthy = (v: unknown): boolean => v === true || v === 't' || v === 1;
  if (truthy(row.rolsuper) || truthy(row.rolcreaterole) || truthy(row.rolbypassrls)) {
    throw new Error('lattice: refusing to embed a privileged role in an invite token');
  }
  if (truthy(row.is_self)) {
    throw new Error('lattice: refusing to embed the cloud owner role in an invite token');
  }
}

/**
 * Per-card audience override: grant (or revoke) one member access to ONE masked
 * cell — a specific (table, pk, column) — without changing the column's
 * schema-level audience. Owner-only (the SQL function raises for a non-owner).
 * `pk` is the row's canonical primary-key string.
 */
export async function grantCell(
  db: Lattice,
  table: string,
  pk: string,
  column: string,
  grantee: string,
): Promise<void> {
  assertPg(db);
  await runAsyncOrSync(db.adapter, `SELECT lattice_grant_cell(?, ?, ?, ?)`, [
    table,
    pk,
    column,
    grantee,
  ]);
}

export async function revokeCell(
  db: Lattice,
  table: string,
  pk: string,
  column: string,
  grantee: string,
): Promise<void> {
  assertPg(db);
  await runAsyncOrSync(db.adapter, `SELECT lattice_revoke_cell(?, ?, ?, ?)`, [
    table,
    pk,
    column,
    grantee,
  ]);
}

/**
 * Per-row "share with specific people": grant (or revoke) one member access to
 * ONE row — a specific (table, pk) — flipping the row to `custom` visibility.
 * Owner-only (the SECURITY DEFINER function raises for a non-owner, and for a
 * `never_share` table). `pk` is the row's canonical primary-key string. Mirrors
 * `grantCell`/`revokeCell` but at row granularity over `lattice_grant_row` /
 * `lattice_revoke_row` (`__lattice_row_grants`).
 */
export async function grantRow(
  db: Lattice,
  table: string,
  pk: string,
  grantee: string,
): Promise<void> {
  assertPg(db);
  await runAsyncOrSync(db.adapter, `SELECT lattice_grant_row(?, ?, ?)`, [table, pk, grantee]);
}

export async function revokeRow(
  db: Lattice,
  table: string,
  pk: string,
  grantee: string,
): Promise<void> {
  assertPg(db);
  await runAsyncOrSync(db.adapter, `SELECT lattice_revoke_row(?, ?, ?)`, [table, pk, grantee]);
}

/**
 * Remove a member: clear its privileges and drop the role. NOTE: rows the member
 * owned remain in their tables but become unreachable (their `owner_role` no
 * longer matches any login role, and RLS shows a row only to its owner / grantees
 * / everyone) — reassigning or purging a departed member's rows is a separate,
 * deliberate step, not a side effect of revoking access.
 */
export async function revokeMemberRole(db: Lattice, role: string): Promise<void> {
  assertPg(db);
  if (!ROLE_RE.test(role)) throw new Error(`lattice: invalid member role name "${role}"`);
  // Idempotent on a role that's already gone: REASSIGN/DROP OWNED raise "role
  // does not exist", so short-circuit when the role is absent. This lets the
  // re-invite + orphan sweep (#3.4) call revoke on a possibly-already-dropped
  // role without a spurious failure. (DROP ROLE IF EXISTS would tolerate it, but
  // the two OWNED statements before it would not.)
  const exists = (await getAsyncOrSync(
    db.adapter,
    `SELECT 1 AS x FROM pg_roles WHERE rolname = ?`,
    [role],
  )) as { x?: number } | undefined;
  if (!exists) return;
  // Clean up the member's owned objects + grants before dropping the role. On a
  // real-superuser cloud this REASSIGNs/DROPs whatever the role owns. But a scoped
  // member is NOSUPERUSER + has no CREATE on the schema, so it owns NO persistent
  // objects — and on managed Postgres (Supabase) the owner ISN'T a true superuser
  // and is NOT a member of the scoped role, so `REASSIGN OWNED` / `DROP OWNED`
  // raise "permission denied to reassign/drop objects" (42501). That error is
  // benign HERE (there is nothing to reassign), so tolerate ONLY the
  // insufficient-privilege code and let the DROP ROLE below be the source of
  // truth. Any OTHER error still propagates (Rule: surface real failures). The
  // DROP ROLE itself is NOT swallowed — if it fails, the kick fails loudly.
  for (const stmt of [`REASSIGN OWNED BY "${role}" TO CURRENT_USER`, `DROP OWNED BY "${role}"`]) {
    try {
      await runAsyncOrSync(db.adapter, stmt);
    } catch (e) {
      if (!isInsufficientPrivilege(e)) throw e;
      console.warn(
        `[cloud] "${stmt.split(' ').slice(0, 2).join(' ')} …" skipped (insufficient privilege; ` +
          `a scoped member owns no objects): ${(e as Error).message}`,
      );
    }
  }
  await runAsyncOrSync(db.adapter, `DROP ROLE IF EXISTS "${role}"`);
}

/** True for a Postgres "permission denied" / insufficient-privilege error
 *  (SQLSTATE 42501) — the class a restricted-superuser owner hits on
 *  REASSIGN/DROP OWNED for a role it isn't a member of. */
function isInsufficientPrivilege(e: unknown): boolean {
  const err = (e ?? {}) as { code?: string; message?: string };
  return err.code === '42501' || /permission denied/i.test(err.message ?? '');
}
