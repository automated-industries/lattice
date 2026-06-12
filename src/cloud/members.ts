import { randomBytes } from 'node:crypto';
import type { Lattice } from '../lattice.js';
import { runAsyncOrSync } from '../db/adapter.js';
import { MEMBER_GROUP } from './rls.js';

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
         ALTER ROLE "${role}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}';
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
 * Remove a member: clear its privileges and drop the role. NOTE: rows the member
 * owned remain in their tables but become unreachable (their `owner_role` no
 * longer matches any login role, and RLS shows a row only to its owner / grantees
 * / everyone) — reassigning or purging a departed member's rows is a separate,
 * deliberate step, not a side effect of revoking access.
 */
export async function revokeMemberRole(db: Lattice, role: string): Promise<void> {
  assertPg(db);
  if (!ROLE_RE.test(role)) throw new Error(`lattice: invalid member role name "${role}"`);
  await runAsyncOrSync(db.adapter, `DROP OWNED BY "${role}"`).catch(() => undefined);
  await runAsyncOrSync(db.adapter, `DROP ROLE IF EXISTS "${role}"`);
}
