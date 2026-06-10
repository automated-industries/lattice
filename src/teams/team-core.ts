import type { Lattice } from '../lattice.js';
import type {
  MemberSummary,
  PendingInvitationSummary,
  SharedObjectSummary,
  ShareObjectResponse,
} from './client.js';
import { applySchemaSpec, type SchemaSpec } from './schema-spec.js';

/**
 * Pure DB logic for team operations — NO auth, NO HTTP, NO connection
 * lifecycle. These functions take an already-open Lattice (the cloud DB) plus
 * the operation's parameters and return plain data.
 *
 * Two callers share them so their behavior can never drift:
 *   - the local direct-Postgres path (`src/teams/direct-ops.ts`, where the
 *     operator's local Lattice *is* the cloud), and
 *   - the cloud HTTP server (`src/teams/server/routes.ts`), whose `handle*`
 *     functions perform token-auth + role checks and then delegate here.
 *
 * Auth MUST stay in the HTTP handlers and never migrate into this module.
 */

interface MemberRow {
  user_id: string;
  team_id: string;
  role: string;
  joined_at: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
}

/**
 * List a team's members. The team creator is always surfaced with
 * `role: 'creator'` — even when their stored `__lattice_team_members.role` says
 * otherwise, and even when they have no members row at all (they are prepended).
 * This is the behavior the direct path always had; the HTTP handler previously
 * omitted it, so a creator listing members over the cloud saw the wrong role.
 */
export async function listTeamMembers(db: Lattice, teamId: string): Promise<MemberSummary[]> {
  const members = (await db.query('__lattice_team_members', {
    filters: [{ col: 'team_id', op: 'eq', val: teamId }],
  })) as unknown as MemberRow[];
  const team = (await db.get('__lattice_team', teamId)) as {
    created_by_user_id?: string;
    created_at?: string;
  } | null;
  const creatorUserId = team?.created_by_user_id ?? null;

  const ids = new Set<string>(members.map((m) => m.user_id));
  if (creatorUserId) ids.add(creatorUserId);
  if (ids.size === 0) return [];

  const users = (await db.query('__lattice_users', {
    filters: [
      { col: 'id', op: 'in', val: [...ids] },
      { col: 'deleted_at', op: 'isNull' },
    ],
  })) as unknown as UserRow[];
  const userById = new Map(users.map((u) => [u.id, u]));

  const out: MemberSummary[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    const u = userById.get(m.user_id);
    if (!u) continue;
    out.push({
      user_id: m.user_id,
      email: u.email,
      name: u.name,
      role: m.user_id === creatorUserId ? 'creator' : m.role,
      joined_at: m.joined_at,
    });
    seen.add(m.user_id);
  }
  // Surface the creator even without a members row (not soft-deleted).
  if (creatorUserId && !seen.has(creatorUserId)) {
    const u = userById.get(creatorUserId);
    if (u) {
      out.unshift({
        user_id: creatorUserId,
        email: u.email,
        name: u.name,
        role: 'creator',
        joined_at: team?.created_at ?? '',
      });
    }
  }
  return out;
}

interface InvitationRow {
  id: string;
  team_id: string;
  invitee_email: string;
  created_at: string;
  expires_at: string | null;
  redeemed_at: string | null;
}

/**
 * List a team's pending (unredeemed) invitations. Redeemed invites are
 * omitted — those people are members now and surface via listTeamMembers.
 * `expired` is computed against the current time so the UI can flag stale
 * invites without a second round-trip. Newest-first.
 */
export async function listPendingInvitations(
  db: Lattice,
  teamId: string,
): Promise<PendingInvitationSummary[]> {
  const rows = (await db.query('__lattice_invitations', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'redeemed_at', op: 'isNull' },
    ],
  })) as unknown as InvitationRow[];
  const nowMs = Date.now();
  return rows
    .map((r) => ({
      id: r.id,
      invitee_email: r.invitee_email,
      invited_at: r.created_at,
      expires_at: r.expires_at ?? null,
      expired: r.expires_at != null && new Date(r.expires_at).getTime() < nowMs,
    }))
    .sort((a, b) => (a.invited_at < b.invited_at ? 1 : a.invited_at > b.invited_at ? -1 : 0));
}

interface SharedObjectRow {
  team_id: string;
  table_name: string;
  schema_spec_json: string;
  schema_version: number;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ChangeEnvelopeEntry {
  team_id: string;
  table_name: string | null;
  pk?: string | null;
  op: 'schema' | 'unshare' | 'link' | 'unlink' | 'upsert' | 'delete' | 'ddl';
  payload_json: string | null;
  owner_user_id?: string | null;
  /**
   * True edit time as recorded by the originating client (ISO-8601). Used to
   * preserve edit-timestamp order for offline replays; defaults to the
   * server-receipt time when omitted. Never used for ordering — that's `seq`.
   */
  client_ts?: string | null;
  /** Client idempotency key for offline replay (no-op on re-send). */
  edit_id?: string | null;
  /**
   * Per-recipient targeting for 2.2 hard row-level sync. NULL = broadcast
   * (delivered to every member, then filtered at pull time against
   * `__lattice_row_acl`); non-null = targeted to exactly this user (the
   * grant / revoke / delete fan-out). See `handleListChanges`.
   */
  recipient_user_id?: string | null;
}

/**
 * Append a change envelope to `__lattice_change_log` with a per-team-monotonic
 * `seq`, returning the assigned seq. Single source of truth for both the cloud
 * HTTP server and the direct-Postgres path.
 *
 * (These previously diverged: the HTTP path derived a GLOBAL max seq across all
 * teams, the direct path a per-team max. With one team per cloud — the singleton
 * model — they coincide; per-team is the correct cursor semantics, and
 * `handleListChanges` filters per team regardless.)
 */
export async function appendChangeEnvelope(
  db: Lattice,
  entry: ChangeEnvelopeEntry,
): Promise<number> {
  const rows = (await db.query('__lattice_change_log', {
    filters: [{ col: 'team_id', op: 'eq', val: entry.team_id }],
    orderBy: 'seq',
    orderDir: 'desc',
    limit: 1,
  })) as unknown as { seq: number }[];
  const seq = (rows[0]?.seq ?? 0) + 1;
  const now = new Date().toISOString();
  await db.insert('__lattice_change_log', {
    seq,
    team_id: entry.team_id,
    table_name: entry.table_name,
    pk: entry.pk ?? null,
    op: entry.op,
    payload_json: entry.payload_json,
    owner_user_id: entry.owner_user_id ?? null,
    created_at: now,
    client_ts: entry.client_ts ?? now,
    edit_id: entry.edit_id ?? null,
    recipient_user_id: entry.recipient_user_id ?? null,
  });
  return seq;
}

/**
 * Look up a prior change envelope by its client idempotency key. Returns the
 * recorded `{ pk }` (the row the edit targeted) when a matching edit_id exists
 * for the team, else null. Used to make an offline-replayed edit a no-op
 * instead of a duplicate write.
 */
export async function findEnvelopeByEditId(
  db: Lattice,
  teamId: string,
  editId: string,
): Promise<{ pk: string | null } | null> {
  const rows = (await db.query('__lattice_change_log', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'edit_id', op: 'eq', val: editId },
    ],
    limit: 1,
  })) as unknown as { pk: string | null }[];
  return rows[0] ? { pk: rows[0].pk } : null;
}

/**
 * Share (or re-share) `table` to `teamId`: upsert the `__lattice_shared_objects`
 * row (bumping `schema_version` on re-share, resetting to 1 for a fresh/previously
 * -unshared object), materialise the table via `applySchemaSpec`, and append a
 * `schema` change envelope. Pure DB logic — the caller performs auth.
 */
export async function shareObject(
  db: Lattice,
  teamId: string,
  createdByUserId: string,
  table: string,
  spec: SchemaSpec,
): Promise<ShareObjectResponse> {
  const existing = (await db.query('__lattice_shared_objects', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'table_name', op: 'eq', val: table },
    ],
    limit: 1,
  })) as unknown as SharedObjectRow[];
  const prior = existing[0];
  const now = new Date().toISOString();
  let schemaVersion: number;
  let outSpec: SchemaSpec;
  if (prior && !prior.deleted_at) {
    schemaVersion = prior.schema_version + 1;
    outSpec = { ...spec, schemaVersion };
    await db.upsert('__lattice_shared_objects', {
      team_id: teamId,
      table_name: table,
      schema_spec_json: JSON.stringify(outSpec),
      schema_version: schemaVersion,
      created_by_user_id: prior.created_by_user_id,
      created_at: prior.created_at,
      updated_at: now,
      deleted_at: null,
    });
  } else {
    schemaVersion = 1;
    outSpec = { ...spec, schemaVersion };
    await db.upsert('__lattice_shared_objects', {
      team_id: teamId,
      table_name: table,
      schema_spec_json: JSON.stringify(outSpec),
      schema_version: schemaVersion,
      created_by_user_id: createdByUserId,
      created_at: prior?.created_at ?? now,
      updated_at: now,
      deleted_at: null,
      // 2.2: a freshly-shared table defaults to 'everyone' so the existing
      // "share a table → every member sees its rows" contract is preserved.
      // The owner can narrow the table default (or individual rows) afterward.
      // Re-share (the branch above) intentionally omits this so an owner's
      // earlier choice survives a schema bump (the upsert only sets the
      // columns it lists).
      default_row_visibility: 'everyone',
    });
  }
  await applySchemaSpec(db, table, outSpec);
  const seq = await appendChangeEnvelope(db, {
    team_id: teamId,
    table_name: table,
    pk: null,
    op: 'schema',
    payload_json: JSON.stringify(outSpec),
    owner_user_id: null,
  });
  return { table, schema_version: schemaVersion, seq, schema_spec: outSpec };
}

/** List a team's live (non-unshared) shared objects. Pure DB read. */
export async function listSharedObjects(
  db: Lattice,
  teamId: string,
): Promise<SharedObjectSummary[]> {
  const rows = (await db.query('__lattice_shared_objects', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'deleted_at', op: 'isNull' },
    ],
  })) as unknown as SharedObjectRow[];
  return rows.map((r) => ({
    table: r.table_name,
    schema_version: r.schema_version,
    created_by_user_id: r.created_by_user_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    schema_spec: JSON.parse(r.schema_spec_json) as SchemaSpec,
  }));
}

/**
 * Soft-delete `table`'s `__lattice_shared_objects` row and append an `unshare`
 * change envelope. Pure DB logic — the caller performs auth + the
 * sharer/creator authorization check (the HTTP path) before invoking this.
 */
export async function unshareObject(db: Lattice, teamId: string, table: string): Promise<void> {
  const now = new Date().toISOString();
  await db.update(
    '__lattice_shared_objects',
    { team_id: teamId, table_name: table },
    { deleted_at: now, updated_at: now },
  );
  await appendChangeEnvelope(db, {
    team_id: teamId,
    table_name: table,
    pk: null,
    op: 'unshare',
    payload_json: null,
    owner_user_id: null,
  });
}
