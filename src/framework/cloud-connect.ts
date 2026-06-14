import { Lattice } from '../lattice.js';
import { getAsyncOrSync } from '../db/adapter.js';

/**
 * Cloud-connect probe — non-destructive inspection of a candidate target
 * Lattice (a Postgres URL the user wants to migrate to or join). Used by the
 * GUI's "Migrate to cloud" and "Join a cloud" flows to tell, before the user
 * commits, whether a URL points at a fresh database or an already-secured
 * Lattice cloud. Exported as public API so library consumers can pre-flight the
 * same check.
 *
 * A "cloud" in v3 is a shared Postgres database with Lattice RLS installed —
 * its tell is the bookkeeping table `__lattice_owners` (created by
 * `installCloudRls`). The probe opens the URL with `introspectOnly` (NO DDL, so
 * it works even when the caller holds a scoped, non-superuser member role), asks
 * Postgres whether that table exists, and closes. It never mutates the target.
 */

export interface CloudProbeResult {
  /** True iff the URL could be opened (connected + authenticated). */
  reachable: boolean;
  /** Adapter dialect of the probed URL. */
  dialect: 'sqlite' | 'postgres';
  /**
   * True iff the target is an established Lattice cloud — Postgres with RLS
   * bookkeeping (`__lattice_owners`) present. A fresh Postgres (no Lattice
   * schema yet) and any SQLite file are `false`: the former is a migration
   * target, the latter is a private local store.
   */
  isCloud: boolean;
  /** Underlying error message when `reachable: false`. */
  error?: string;
}

/** Detect the RLS bookkeeping table without assuming SELECT privilege on it.
 *  `to_regclass` returns the table's OID name when it exists and NULL when it
 *  doesn't — and, unlike `SELECT FROM __lattice_owners`, it does not require any
 *  privilege on the table, so a scoped member (who is denied SELECT on the
 *  bookkeeping tables) still gets a truthful answer. */
export async function cloudRlsInstalled(probe: Lattice): Promise<boolean> {
  // Resolve via the search_path (current schema), NOT a hardcoded `public.` — the
  // cloud bootstrap installs into the connection's schema (cloudSchema), so a
  // cloud in a non-public schema was mis-detected as "not a cloud".
  const row = (await getAsyncOrSync(
    probe.adapter,
    `SELECT to_regclass('__lattice_owners') AS reg`,
  )) as { reg?: string | null } | undefined;
  return !!row && row.reg != null;
}

/**
 * Whether the connected role may create other roles — the capability that
 * separates a cloud OWNER (ran the migration, owns the rows, can invite members)
 * from a scoped MEMBER (provisioned `NOCREATEROLE`). Read from
 * `pg_roles.rolcreaterole` for the live role. SQLite or any error → false.
 */
export async function canManageRoles(db: Lattice): Promise<boolean> {
  if (db.getDialect() !== 'postgres') return false;
  try {
    const row = (await getAsyncOrSync(
      db.adapter,
      `SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user`,
    )) as { rolcreaterole?: boolean } | undefined;
    return !!row?.rolcreaterole;
  } catch {
    return false;
  }
}

/**
 * Probe a candidate Lattice URL for reachability + cloud status.
 *
 * Never throws. Errors are returned in the result's `error` field with
 * `reachable: false`.
 */
export async function probeCloud(targetUrl: string): Promise<CloudProbeResult> {
  const dialect: 'sqlite' | 'postgres' = /^postgres(ql)?:\/\//i.test(targetUrl)
    ? 'postgres'
    : 'sqlite';

  // SQLite is never a shared cloud — skip the open entirely.
  if (dialect === 'sqlite') {
    return { reachable: true, dialect, isCloud: false };
  }

  let probe: Lattice | null = null;
  try {
    probe = new Lattice(targetUrl);
    // introspectOnly: open + authenticate, issue NO DDL. A scoped member role
    // has no CREATE privilege, so a normal init() (which applies the schema)
    // would fail against an established cloud; the probe must not depend on it.
    await probe.init({ introspectOnly: true });
    const isCloud = await cloudRlsInstalled(probe);
    return { reachable: true, dialect, isCloud };
  } catch (e) {
    // Surface as much underlying detail as the driver gave us so the GUI can
    // show something more actionable than "Unreachable: unknown". Postgres
    // errors from `pg` carry `.code` (SQLSTATE) + `.routine` — include them so
    // callers can tell e.g. SCRAM auth failure (28P01) from a network error.
    const err = e as Error & { code?: string; routine?: string; severity?: string };
    const parts: string[] = [];
    if (err.code) parts.push(`[${err.code}]`);
    if (err.message) parts.push(err.message);
    if (err.routine && !err.message.includes(err.routine)) {
      parts.push(`(routine: ${err.routine})`);
    }
    return {
      reachable: false,
      dialect,
      isCloud: false,
      error: parts.join(' ') || 'unknown',
    };
  } finally {
    if (probe) {
      try {
        probe.close();
      } catch {
        // best-effort
      }
    }
  }
}
