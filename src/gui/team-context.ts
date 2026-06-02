import type { Lattice } from '../lattice.js';
import type { TeamsClient } from '../teams/client.js';
import {
  listObjectOwners,
  reconcileObjectOwners,
  resolveUserIdByEmail,
  listSharedObjectsDirect,
  shareObjectDirect,
  unshareObjectDirect,
} from '../teams/direct-ops.js';
import { serializeSchema } from '../teams/schema-spec.js';

/**
 * Team-cloud ownership glue for the GUI. Every member of a team cloud
 * connects to the SAME physical Postgres, so per-user visibility +
 * sharing must be enforced at the application layer (see docs/teams.md
 * § Per-table ownership). These functions only ever run when the active
 * GUI database is a team-enabled `postgres://` cloud — they open / query
 * the cloud directly. Like `direct-ops.ts` and `register-direct.ts`,
 * the postgres-only branches can't execute against the SQLite-backed
 * test harness (they short-circuit on dialect / URL gating), so this
 * module is excluded from coverage; the SQL behaviour is exercised
 * manually against a real cloud Postgres at release time, and the pure
 * ownership helpers it builds on are unit-tested in
 * `tests/integration/direct-ops.test.ts`.
 */

/**
 * Resolved team-cloud ownership context for the active DB. Present only
 * when the active DB is a team-enabled Postgres cloud. A user sees the
 * tables they own PLUS tables shared to the team.
 */
export interface TeamContext {
  teamId: string;
  /** Resolved cloud user id of the operator sitting at this GUI. */
  myUserId: string;
  /** Cloud user id of the team creator, or null if unresolved. */
  creatorUserId: string | null;
  isCreator: boolean;
  /**
   * True when the operator currently has a `__lattice_team_members` row.
   * This is the authoritative "am I in the team?" signal — distinct from
   * `myUserId` resolving (which only means their email maps to a user
   * that may since have been kicked / left).
   */
  isMember: boolean;
  /** table_name → owner_user_id for every owned table on the team. */
  owners: Map<string, string>;
  /** Tables explicitly shared to the whole team. */
  shared: Set<string>;
  /**
   * table_name → its `__lattice_shared_objects.schema_version`, a snapshot at
   * resolve time. Used as the optimistic-concurrency token for data-model
   * edits to shared tables (the client sends its base version; the server
   * rejects a stale write). Re-shares bump the version.
   */
  sharedVersions: Map<string, number>;
}

/**
 * True when `tableName` should be visible to the operator in the given
 * team context: it's shared to the team, owned by the operator, or has
 * no ownership record at all (unowned tables degrade to visible so a
 * failed reconcile never hides data — security-relevant native objects
 * always get an owner via reconcile, so they don't hit this branch).
 */
export function isVisibleInTeam(tableName: string, ctx: TeamContext): boolean {
  if (ctx.shared.has(tableName)) return true;
  const owner = ctx.owners.get(tableName);
  if (owner === undefined) return true;
  return owner === ctx.myUserId;
}

/** A team member, for resolving "last edited by" labels. */
export interface TeamUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * List the team's users from `__lattice_users` (non-deleted). The client
 * caches this id→name map to render "last edited by". One team per cloud, so
 * every row is this team's. Returns [] if the table is unreachable.
 */
export async function listTeamUsers(db: Lattice): Promise<TeamUser[]> {
  try {
    const rows = (await db.query('__lattice_users', {
      filters: [{ col: 'deleted_at', op: 'isNull' }],
    })) as unknown as { id: string; email: string; name: string | null }[];
    return rows.map((r) => ({ id: r.id, email: r.email, name: r.name ?? null }));
  } catch {
    return [];
  }
}

/**
 * Apply a share / unshare to an already-resolved {@link TeamContext} in
 * place, without re-opening the active DB. Mutates `ctx.shared` and the
 * GUI's `validTables` visibility set so subsequent `/api/entities` reads
 * reflect the change immediately.
 *
 * Used on two paths: the owner's own share route (deterministic update
 * for the initiating client) and the realtime broker subscription (when
 * another client's share/unshare envelope arrives over NOTIFY). Both are
 * idempotent — a repeated `schema` envelope for an already-shared table
 * is a no-op. A table stays visible to its owner regardless of sharing.
 */
export function applySharingToContext(
  ctx: TeamContext,
  validTables: Set<string>,
  table: string,
  wantShare: boolean,
): void {
  if (wantShare) ctx.shared.add(table);
  else {
    ctx.shared.delete(table);
    ctx.sharedVersions.delete(table);
  }
  if (isVisibleInTeam(table, ctx)) validTables.add(table);
  else validTables.delete(table);
}

/**
 * Resolve the team-cloud ownership context for a direct-Postgres team
 * DB. Identity comes from the singleton `__lattice_team_identity` row;
 * the operator's cloud user id is resolved from the local
 * `__lattice_user_identity` email (the email they registered/redeemed
 * with), falling back to the saved team connection. Unowned candidate
 * tables are reconciled to the creator so visibility is deterministic.
 * Returns null when the identity row is missing or has no team_id.
 */
export async function resolveTeamContext(
  db: Lattice,
  teamsClient: TeamsClient,
  cloudUrl: string,
  candidateTables: string[],
): Promise<TeamContext | null> {
  const identity = (await db.get('__lattice_team_identity', 'singleton')) as {
    team_id?: string;
    creator_email?: string;
  } | null;
  if (!identity?.team_id) return null;
  const teamId = identity.team_id;
  const creatorUserId = identity.creator_email
    ? await resolveUserIdByEmail(db, identity.creator_email)
    : null;

  // Resolve "me": prefer the operator's mirrored identity email, fall
  // back to the saved team connection's my_user_id.
  let myUserId = '';
  let myEmail = '';
  try {
    const me = (await db.get('__lattice_user_identity', 'singleton')) as {
      email?: string;
    } | null;
    if (me?.email) {
      myEmail = me.email;
      myUserId = (await resolveUserIdByEmail(db, me.email)) ?? '';
    }
  } catch {
    myUserId = '';
  }
  let savedConn: { my_user_id?: string } | null = null;
  if (!myUserId) {
    try {
      const conns = await teamsClient.listConnections();
      savedConn =
        conns.find((c) => c.cloud_url === cloudUrl) ??
        conns.find((c) => c.team_id === teamId) ??
        null;
      myUserId = savedConn?.my_user_id ?? '';
    } catch {
      // leave empty
    }
  }

  // Authoritative membership: do I currently have a team_members row?
  let isMember = false;
  if (myUserId) {
    try {
      const rows = (await db.query('__lattice_team_members', {
        filters: [
          { col: 'team_id', op: 'eq', val: teamId },
          { col: 'user_id', op: 'eq', val: myUserId },
        ],
        limit: 1,
      })) as unknown as unknown[];
      isMember = rows.length > 0;
    } catch {
      isMember = false;
    }
  }
  // Fallback for an already-joined member whose cloud user-id didn't resolve
  // (identity email not mirrored locally, or a saved connection missing
  // my_user_id) — they were wrongly shown the "paste invite token" panel.
  // Resolve membership directly: match a live team_members row to the local
  // identity email via the cloud users table; failing that, a saved
  // connection for THIS cloud/team is itself proof of a redeemed membership.
  if (!isMember && (myEmail || savedConn)) {
    try {
      const memberRows = (await db.query('__lattice_team_members', {
        filters: [
          { col: 'team_id', op: 'eq', val: teamId },
          { col: 'deleted_at', op: 'isNull' },
        ],
      })) as unknown as { user_id: string }[];
      if (memberRows.length > 0) {
        const matchId = myEmail ? await resolveUserIdByEmail(db, myEmail) : null;
        if (matchId && memberRows.some((m) => m.user_id === matchId)) {
          myUserId = matchId;
          isMember = true;
        } else if (savedConn) {
          isMember = true;
        }
      }
    } catch {
      // leave isMember as-is
    }
  }

  if (creatorUserId) {
    await reconcileObjectOwners(db, teamId, creatorUserId, candidateTables);
  }
  const owners = await listObjectOwners(db, teamId);
  let shared = new Set<string>();
  const sharedVersions = new Map<string, number>();
  try {
    const summaries = await listSharedObjectsDirect(cloudUrl, teamId);
    shared = new Set(summaries.map((s) => s.table));
    for (const s of summaries) sharedVersions.set(s.table, s.schema_version);
  } catch {
    // Shared-object table unreachable — treat as nothing shared.
  }
  const isCreator = !!creatorUserId && myUserId === creatorUserId;
  return { teamId, myUserId, creatorUserId, isCreator, isMember, owners, shared, sharedVersions };
}

/**
 * Share or unshare a table with the team (owner-only). Validates that
 * the operator owns the table, then drives the direct-Postgres
 * share/unshare against the cloud. Returns an HTTP status + body for
 * the GUI route to send; the caller handles re-opening the active DB on
 * success. The "not a team cloud" guard stays in the route so it's
 * reachable (and tested) against local databases.
 */
export async function shareEntityWithTeam(
  db: Lattice,
  cloudUrl: string,
  ctx: TeamContext,
  validTables: Set<string>,
  table: string,
  wantShare: boolean,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!validTables.has(table)) {
    return { status: 400, body: { error: `Unknown entity: ${table}` } };
  }
  if (ctx.owners.get(table) !== ctx.myUserId) {
    return { status: 403, body: { error: 'Only the table owner can change sharing' } };
  }
  if (wantShare) {
    const cols = db.getRegisteredColumns(table);
    if (!cols) {
      return { status: 404, body: { error: `Table "${table}" is not registered` } };
    }
    const spec = serializeSchema(
      { columns: cols, render: () => '', outputFile: '' },
      db.getPrimaryKey(table),
    );
    await shareObjectDirect(cloudUrl, ctx.teamId, ctx.myUserId, table, spec);
  } else {
    await unshareObjectDirect(cloudUrl, ctx.teamId, table);
  }
  return { status: 200, body: { ok: true, table, shared: wantShare } };
}
