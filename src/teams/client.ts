import { createHash, randomUUID } from 'node:crypto';
import type { Lattice } from '../lattice.js';
import { LOCAL_INTERNAL_TABLE_DEFS } from './internal-tables.js';
import { applySchemaSpec, TeamsSchemaConflictError, type SchemaSpec } from './schema-spec.js';
import type { Row, WriteHookContext } from '../types.js';
import { probeCloud, type CloudProbeResult } from '../framework/cloud-connect.js';
import { saveDbCredential, writeToken } from '../framework/user-config.js';
import { isPostgresUrl } from './register-direct.js';
import {
  destroyTeamDirect,
  inviteDirect,
  kickMemberDirect,
  linkRowDirect,
  listMembersDirect,
  listPendingInvitationsDirect,
  listSharedObjectsDirect,
  meDirect,
  shareObjectDirect,
  unlinkRowDirect,
  unshareObjectDirect,
} from './direct-ops.js';

/**
 * Direct postgres:// team-cloud connections are deprecated as of 2.2: they
 * pre-date row-level security and cannot enforce it (the local Lattice talks
 * straight to the cloud DB as a superuser, bypassing the per-recipient sync
 * filter). NEW connections must go through a hosted Teams server (an
 * http(s):// URL); EXISTING direct connections keep working but warn on
 * connect. This does NOT affect using Postgres as a Lattice's own storage
 * backend — only the team-sync direct path.
 */
export const DIRECT_CLOUD_DEPRECATION_MESSAGE =
  'Direct postgres:// team-cloud connections are deprecated and do not support ' +
  'row-level security. Create or join a workspace through a hosted Lattice Teams ' +
  'server (an http(s):// URL) instead. Existing direct connections continue to ' +
  'work but should be migrated.';

/**
 * Local-side client for a Lattice Teams cloud. Wraps the cloud HTTP API
 * and persists per-team connection metadata into the local lattice's
 * `__lattice_team_connections` table.
 *
 * Phase 2 covers identity + team management: register, redeem-invite,
 * list-teams, create-team, delete-team, list-members, invite, kick.
 * Phases 3 and 4 add object sharing, row link/unlink, and the polling
 * sync loop.
 */

export interface TeamSummary {
  id: string;
  name: string;
  role: string;
}

export interface RegisterResponse {
  user: { id: string; email: string; name: string };
  raw_token: string;
  team: TeamSummary;
}

export interface RedeemResponse {
  user: { id: string; email: string; name: string };
  raw_token: string;
  team: { id: string; name: string };
}

export interface MemberSummary {
  user_id: string;
  email: string | null;
  name: string | null;
  role: string;
  joined_at: string;
}

/**
 * An invitation that has been issued but not yet redeemed — surfaced in the
 * member list so the owner can see who's been invited but hasn't joined.
 */
export interface PendingInvitationSummary {
  id: string;
  invitee_email: string;
  invited_at: string;
  expires_at: string | null;
  expired: boolean;
}

export interface InviteResponse {
  id: string;
  raw_token: string;
  expires_at: string;
  team_name: string;
  invitee_email: string;
}

export interface TeamConnection {
  team_id: string;
  team_name: string;
  cloud_url: string;
  my_user_id: string;
  api_token: string;
  joined_at: string;
}

export interface SharedObjectSummary {
  table: string;
  schema_version: number;
  schema_spec: SchemaSpec;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface ShareObjectResponse {
  table: string;
  schema_version: number;
  seq: number;
  schema_spec: SchemaSpec;
}

export interface ChangeEnvelope {
  seq: number;
  table_name: string | null;
  pk: string | null;
  /**
   * Cloud-emitted ops are `schema`/`unshare`/`link`/`unlink`/`upsert`/`delete`.
   * `divergence` is a client-side-only marker the puller writes into the DLQ
   * when a non-owner local edit was overwritten by an owner update — it is
   * never emitted by the cloud, and applying it is a no-op (the LWW overwrite
   * already happened; the entry exists so the lost local content is visible).
   */
  op: 'schema' | 'unshare' | 'link' | 'unlink' | 'upsert' | 'delete' | 'divergence';
  payload: unknown;
  owner_user_id: string | null;
  created_at: string;
}

export interface OutboxRow {
  id: string;
  team_id: string;
  table_name: string;
  pk: string;
  op: 'insert' | 'update' | 'delete';
  payload_json: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
}

export interface LocalLinkRow {
  team_id: string;
  table_name: string;
  pk: string;
  owner_user_id: string;
  linked_at: string;
  synced_hash?: string | null;
}

/**
 * A parsed dead-letter-queue entry — a change envelope that failed to apply
 * during a pull (or a non-owner-overwrite divergence notice), surfaced so an
 * operator can inspect and retry instead of it sitting invisible behind a
 * count. See {@link TeamsClient.listDlq}.
 */
export interface DlqEntry {
  id: string;
  team_id: string;
  /** Table the failed envelope targeted (null for schema-level ops). */
  table_name: string | null;
  /** Primary key the failed envelope targeted (null for schema-level ops). */
  pk: string | null;
  /** The envelope op, e.g. `upsert` / `link` / `divergence`. */
  op: string;
  /** The error that caused the envelope to land in the DLQ. */
  error: string;
  created_at: string;
  /** The full envelope as stored, for retry / inspection. */
  envelope: ChangeEnvelope;
}

export interface DlqRetryResult {
  retried: number;
  succeeded: number;
  failed: number;
}

export interface SyncStatus {
  team_id: string;
  team_name: string;
  last_change_seq: number | null;
  outbox_depth: number;
  outbox_failing: number;
  dlq_depth: number;
  local_links: number;
}

export interface PullResult {
  applied: number;
  last_seq: number;
  dlq_count: number;
}

export interface PushResult {
  pushed: number;
  failed: number;
}

export interface SyncSharedSchemasResult {
  applied: { table: string; schema_version: number }[];
  conflicts: { table: string; reason: string }[];
}

interface ConnectionRow {
  team_id: string;
  team_name: string;
  cloud_url: string;
  my_user_id: string;
  api_token_encrypted: string;
  last_change_seq: number | null;
  joined_at: string;
}

export class TeamsClient {
  private _tablesReady = false;
  /**
   * Set during a pull's envelope application so the local write-hook
   * skips outbox insertion — otherwise B's pull of A's change would
   * push it right back to the cloud.
   */
  private _isReplaying = false;
  /** Tables for which a sync write-hook has already been registered. */
  private readonly _hookedTables = new Set<string>();

  constructor(private readonly local: Lattice) {}

  /**
   * Lazy-register the local `__lattice_team_connections` table on first
   * use. `defineLate` is idempotent, so calling this on every session
   * start is safe.
   */
  async ensureLocalTables(): Promise<void> {
    if (this._tablesReady) return;
    for (const [name, def] of Object.entries(LOCAL_INTERNAL_TABLE_DEFS)) {
      await this.local.defineLate(name, def);
    }
    this._tablesReady = true;
  }

  // ── Cloud HTTP calls (unauthenticated) ──────────────────────────────────

  /**
   * Bootstrap-register on a fresh cloud and create the team in one
   * atomic call. The cloud rejects this once any user exists (subsequent
   * members join via `redeemInvite`). Returns the new user + bearer
   * token + team summary so the caller can immediately save a
   * connection.
   *
   * @param teamName The workspace display name (stored as `team_name` for
   * backward compatibility — a cloud IS a workspace with members).
   */
  async register(
    cloudUrl: string,
    email: string,
    name: string,
    teamName: string,
  ): Promise<RegisterResponse> {
    return this.fetchUnauthed<RegisterResponse>(cloudUrl, 'POST', '/api/auth/register', {
      email,
      name,
      team_name: teamName,
    });
  }

  async redeemInvite(
    cloudUrl: string,
    inviteToken: string,
    email: string,
    name: string,
  ): Promise<RedeemResponse> {
    // Dispatch on URL scheme — http(s):// keeps the HTTP teams-server
    // path; postgres(ql):// drives the same INSERT sequence directly
    // against the cloud Postgres. The Fetch API refuses URLs with
    // embedded credentials, so when the operator's cloud_url is the
    // saved Postgres URL the HTTP path 404s before it leaves the
    // browser (no server to answer /api/auth/redeem-invite).
    // New direct postgres:// joins are deprecated (no row-level security).
    if (isPostgresUrl(cloudUrl)) {
      throw new Error(DIRECT_CLOUD_DEPRECATION_MESSAGE);
    }
    return this.fetchUnauthed<RedeemResponse>(cloudUrl, 'POST', '/api/auth/redeem-invite', {
      invite_token: inviteToken,
      email,
      name,
    });
  }

  // ── High-level orchestration (v1.13+) ───────────────────────────────────
  // Wraps the multi-step flows the GUI's Database panel + library
  // consumers both need: connecting to an existing cloud DB (with
  // optional team join), and initializing a fresh cloud DB's owner so
  // its members + per-table sharing surface exists. A cloud workspace IS
  // a workspace with members — there is no separate "team" to convert to.
  // The HTTP routes in src/gui/dbconfig-routes.ts are thin shells over
  // these methods.

  /**
   * Connect a local project to an existing cloud DB by URL. Probes
   * the target for team status first; if it's a teams DB, the caller
   * must pass `invite_token` + identity (email/name) and the method
   * will redeem the invite and save the resulting bearer to
   * `~/.lattice/keys/<label>.token`. The saved credential lands in
   * `~/.lattice/db-credentials.enc` keyed by `label`. Caller is
   * responsible for rewriting the YAML `db:` line to
   * `${LATTICE_DB:<label>}` and reopening the active Lattice.
   *
   * Returns the probe result + (if redeemed) the member info. Throws
   * if the target is unreachable, or if it's a teams DB and the
   * caller omitted `invite_token`.
   */
  async connectToExistingCloud(opts: {
    label: string;
    cloudUrl: string;
    invite_token?: string;
    email?: string;
    name?: string;
  }): Promise<{
    probe: CloudProbeResult;
    joinedAsMember?: { user_id: string; team_id: string };
  }> {
    const probe = await probeCloud(opts.cloudUrl);
    if (!probe.reachable) {
      throw new Error(`Cloud DB unreachable: ${probe.error ?? 'unknown error'}`);
    }
    if (probe.teamEnabled) {
      const inviteToken = opts.invite_token;
      const email = opts.email;
      const name = opts.name;
      if (!inviteToken) {
        throw new TeamsHttpError(400, 'invite token required for teams DB');
      }
      if (!email || !name) {
        throw new TeamsHttpError(400, 'email + name required to redeem invitation');
      }
      const redeem = await this.redeemInvite(opts.cloudUrl, inviteToken, email, name);
      saveDbCredential(opts.label, opts.cloudUrl);
      writeToken(opts.label, redeem.raw_token);
      // Persist the local connection row too — without this, the GUI's
      // team API calls (members, invites, etc.) can't find the cloud
      // URL + bearer + user_id triple they need to authenticate. The
      // older `handleRedeemInviteAndJoin` route did this; v1.13's
      // higher-level orchestration was skipping it (see PR #20 / 1.13.4).
      await this.saveConnection({
        team_id: redeem.team.id,
        team_name: redeem.team.name,
        cloud_url: opts.cloudUrl,
        my_user_id: redeem.user.id,
        api_token: redeem.raw_token,
      });
      return {
        probe,
        joinedAsMember: { user_id: redeem.user.id, team_id: redeem.team.id },
      };
    }
    // Non-team DB: just save the credential. No bearer needed yet —
    // the upgrade-to-team flow will mint one later.
    saveDbCredential(opts.label, opts.cloudUrl);
    return { probe };
  }

  /**
   * Initialize a fresh cloud DB's owner: register the first member (who
   * becomes owner) so the cloud's members + per-table sharing surface
   * exists. This is NOT a "convert a cloud into a team" step — a cloud
   * workspace IS a workspace with members; this just bootstraps the owner
   * the first time a cloud is opened. The hosted server path is the only
   * supported one:
   *
   *   - `http(s)://…` — POST to the cloud's `/api/auth/register` endpoint
   *     (a hosted `lattice serve` teams server is fronting the Postgres).
   *   - `postgres(ql)://…` — rejected: direct postgres:// owner bootstrap
   *     is deprecated. Row-level security is enforced by the hosted server,
   *     so it is the only supported connection method for new workspaces.
   *
   * On success writes the bearer token to `~/.lattice/keys/<label>.token`
   * **and** persists the local `__lattice_team_connections` row so the
   * GUI's team-management API calls can authenticate immediately
   * afterward (members, invites, kick, destroy). v1.13.4 added the
   * connection-row write — the older v1.13 implementation only wrote
   * the token file, leaving GUI authenticated calls with no
   * `cloud_url` + `my_user_id` + `api_token_encrypted` row to read.
   */
  async registerCloudOwner(opts: {
    label: string;
    cloudUrl: string;
    /** Workspace display name (stored as `team_name` for backward compatibility). */
    teamName: string;
    email: string;
    displayName: string;
  }): Promise<RegisterResponse> {
    // New direct postgres:// workspaces are deprecated (no row-level security).
    if (isPostgresUrl(opts.cloudUrl)) {
      throw new Error(DIRECT_CLOUD_DEPRECATION_MESSAGE);
    }
    const reg = await this.register(opts.cloudUrl, opts.email, opts.displayName, opts.teamName);
    writeToken(opts.label, reg.raw_token);
    await this.saveConnection({
      team_id: reg.team.id,
      team_name: reg.team.name,
      cloud_url: opts.cloudUrl,
      my_user_id: reg.user.id,
      api_token: reg.raw_token,
    });
    return reg;
  }

  /**
   * Idempotently initialize a cloud Postgres DB as a collaborative cloud
   * workspace (members + sharing). 1.16.3 deprecated the user-facing "team"
   * concept and the explicit "upgrade to team" step — every cloud workspace
   * gets this machinery automatically at migrate / connect / open time, so the
   * members + per-table sharing surface is always available on a cloud DB.
   *
   * No-op (returns created:false) when the cloud already carries an identity.
   * On a fresh cloud the caller becomes the owner. Race-safe: a concurrent
   * initializer that wins the singleton insert is treated as success.
   */
  async ensureCloudWorkspaceIdentity(opts: {
    label: string;
    cloudUrl: string;
    workspaceName: string;
    email: string;
    displayName?: string;
  }): Promise<{ created: boolean }> {
    const probe = await probeCloud(opts.cloudUrl);
    if (!probe.reachable) {
      throw new Error(`Cloud DB unreachable: ${probe.error ?? 'unknown error'}`);
    }
    if (probe.teamEnabled) return { created: false }; // already a cloud workspace
    if (!opts.email) {
      throw new Error('Set your email in User settings to set up this cloud workspace.');
    }
    try {
      const displayName = opts.displayName?.trim() ? opts.displayName : opts.email;
      await this.registerCloudOwner({
        label: opts.label,
        cloudUrl: opts.cloudUrl,
        teamName: opts.workspaceName,
        email: opts.email,
        displayName,
      });
      return { created: true };
    } catch (e) {
      // A concurrent initializer won the race (another connection created the
      // singleton identity / first user first). The cloud is now a workspace —
      // treat as success; this operator resolves as a member / needs-invite.
      const msg = (e as Error).message || '';
      if (/already has (a team|users)/i.test(msg)) return { created: false };
      throw e;
    }
  }

  // ── Cloud team operations (dispatch on URL scheme) ──────────────────────
  // For HTTP cloud URLs (`http://lattice-server:port`), every operation
  // round-trips through the team server's authenticated REST API. For
  // direct-Postgres cloud URLs (`postgres://...`), the user's `this.local`
  // Lattice IS the cloud DB — operations dispatch through `direct-ops.ts`
  // helpers that run the same INSERT / UPDATE / DELETE / SELECT logic
  // against `this.local` directly. The Fetch API can't handle
  // credentials-in-URL anyway, so the dispatch isn't optional.
  //
  // Authorization model: for HTTP clouds, the server gates by bearer
  // token + membership row. For direct-Postgres, possession of the
  // connection credential is the implicit gate — the operator is
  // already reading/writing the canonical data.

  /** Destroy the singleton team. Creator-only on the cloud side. */
  async destroyTeam(cloudUrl: string, token: string): Promise<void> {
    if (isPostgresUrl(cloudUrl)) {
      await destroyTeamDirect(this.local);
      return;
    }
    await this.fetchAuthed<unknown>(cloudUrl, token, 'DELETE', '/api/team');
  }

  async listMembers(cloudUrl: string, token: string, teamId: string): Promise<MemberSummary[]> {
    if (isPostgresUrl(cloudUrl)) {
      return listMembersDirect(this.local, teamId);
    }
    const r = await this.fetchAuthed<{ members: MemberSummary[] }>(
      cloudUrl,
      token,
      'GET',
      `/api/teams/${teamId}/members`,
    );
    return r.members;
  }

  async listPendingInvitations(
    cloudUrl: string,
    token: string,
    teamId: string,
  ): Promise<PendingInvitationSummary[]> {
    if (isPostgresUrl(cloudUrl)) {
      return listPendingInvitationsDirect(this.local, teamId);
    }
    const r = await this.fetchAuthed<{ invitations: PendingInvitationSummary[] }>(
      cloudUrl,
      token,
      'GET',
      `/api/teams/${teamId}/invitations`,
    );
    return r.invitations;
  }

  async invite(
    cloudUrl: string,
    token: string,
    teamId: string,
    inviteeEmail: string,
    expiresInHours?: number,
    inviterUserId?: string,
  ): Promise<InviteResponse> {
    if (isPostgresUrl(cloudUrl)) {
      if (!inviterUserId) {
        throw new Error(
          'invite: inviterUserId is required for direct-Postgres cloud URLs ' +
            '(read it from __lattice_team_connections.my_user_id)',
        );
      }
      return inviteDirect(this.local, teamId, inviterUserId, inviteeEmail, expiresInHours);
    }
    const body: Record<string, unknown> = { invitee_email: inviteeEmail };
    if (expiresInHours !== undefined) body.expires_in_hours = expiresInHours;
    return this.fetchAuthed<InviteResponse>(
      cloudUrl,
      token,
      'POST',
      `/api/teams/${teamId}/invitations`,
      body,
    );
  }

  async kickMember(cloudUrl: string, token: string, teamId: string, userId: string): Promise<void> {
    if (isPostgresUrl(cloudUrl)) {
      await kickMemberDirect(this.local, teamId, userId);
      return;
    }
    await this.fetchAuthed<unknown>(
      cloudUrl,
      token,
      'DELETE',
      `/api/teams/${teamId}/members/${userId}`,
    );
  }

  async me(
    cloudUrl: string,
    token: string,
  ): Promise<{ user: { id: string; email: string | null; name: string | null } }> {
    if (isPostgresUrl(cloudUrl)) {
      return meDirect(cloudUrl, token);
    }
    return this.fetchAuthed(cloudUrl, token, 'GET', '/api/auth/me');
  }

  // ── Object sharing (Phase 3) ────────────────────────────────────────────

  /**
   * Share a table with the team. Re-sharing the same table bumps its
   * `schema_version` and replaces the stored spec — useful for evolving
   * shared schemas additively.
   */
  async shareObject(
    cloudUrl: string,
    token: string,
    teamId: string,
    table: string,
    schemaSpec: SchemaSpec,
    inviterUserId?: string,
  ): Promise<ShareObjectResponse> {
    if (isPostgresUrl(cloudUrl)) {
      if (!inviterUserId) {
        throw new Error(
          'shareObject: inviterUserId is required for direct-Postgres cloud URLs ' +
            '(read it from __lattice_team_connections.my_user_id)',
        );
      }
      return shareObjectDirect(cloudUrl, teamId, inviterUserId, table, schemaSpec);
    }
    return this.fetchAuthed<ShareObjectResponse>(
      cloudUrl,
      token,
      'POST',
      `/api/teams/${teamId}/objects`,
      { table, schema_spec: schemaSpec },
    );
  }

  /**
   * Stop sharing a table. Only the original sharer or the team creator
   * can call this. The cloud soft-deletes the `__lattice_shared_objects`
   * row and appends an `unshare` envelope to the change log.
   */
  async unshareObject(
    cloudUrl: string,
    token: string,
    teamId: string,
    table: string,
  ): Promise<void> {
    if (isPostgresUrl(cloudUrl)) {
      await unshareObjectDirect(cloudUrl, teamId, table);
      return;
    }
    await this.fetchAuthed<unknown>(
      cloudUrl,
      token,
      'DELETE',
      `/api/teams/${teamId}/objects/${encodeURIComponent(table)}`,
    );
  }

  async listSharedObjects(
    cloudUrl: string,
    token: string,
    teamId: string,
  ): Promise<SharedObjectSummary[]> {
    if (isPostgresUrl(cloudUrl)) {
      return listSharedObjectsDirect(cloudUrl, teamId);
    }
    const r = await this.fetchAuthed<{ objects: SharedObjectSummary[] }>(
      cloudUrl,
      token,
      'GET',
      `/api/teams/${teamId}/objects`,
    );
    return r.objects;
  }

  /**
   * Pull change envelopes since the given sequence number. Phase 3
   * emits `schema` and `unshare` ops; Phase 4 adds row-level ops. The
   * `has_more` flag tells callers to loop until drained before sleeping.
   */
  async fetchChangeBatch(
    cloudUrl: string,
    token: string,
    teamId: string,
    since = 0,
    limit = 500,
  ): Promise<{ envelopes: ChangeEnvelope[]; has_more: boolean }> {
    // Direct-Postgres mode: local IS cloud. There is no remote change
    // log to pull — every write the operator made already landed in
    // the same DB the GUI is reading. Return an empty batch so the
    // sync loop terminates cleanly. (When per-user row sharing arrives
    // for direct-Postgres clouds we'll revisit; today there's nothing
    // to do.)
    if (isPostgresUrl(cloudUrl)) {
      return { envelopes: [], has_more: false };
    }
    return this.fetchAuthed<{ envelopes: ChangeEnvelope[]; has_more: boolean }>(
      cloudUrl,
      token,
      'GET',
      `/api/teams/${teamId}/changes?since=${since.toString()}&limit=${limit.toString()}`,
    );
  }

  /**
   * Fetch every shared object on the team's cloud and apply each spec
   * to the local lattice. New tables go through `defineLate`; existing
   * tables get additive ALTER TABLE for any cloud-only columns. PK
   * mismatches are surfaced as `TeamsSchemaConflictError`s and recorded
   * in the returned summary so callers can present them to the user.
   *
   * Phase 4 will wrap this in a polling loop; Phase 3 invokes it on
   * demand from the CLI / GUI.
   */
  async syncSharedSchemas(connection: TeamConnection): Promise<SyncSharedSchemasResult> {
    const objects = await this.listSharedObjects(
      connection.cloud_url,
      connection.api_token,
      connection.team_id,
    );
    const applied: { table: string; schema_version: number }[] = [];
    const conflicts: { table: string; reason: string }[] = [];
    for (const obj of objects) {
      try {
        const changed = await this.applyCloudSchemaLocally(obj.table, obj.schema_spec);
        if (changed) applied.push({ table: obj.table, schema_version: obj.schema_version });
      } catch (e) {
        // Isolate per-table failures: a single object that can't be applied
        // (PK conflict, or any DDL error) is recorded and skipped, so the rest
        // of the team's shared tables still sync. Previously a non-conflict
        // error aborted the whole sync, leaving a joined member with NO tables.
        if (e instanceof TeamsSchemaConflictError) {
          conflicts.push({ table: e.table, reason: e.reason });
        } else {
          conflicts.push({ table: obj.table, reason: (e as Error).message });
        }
      }
    }
    return { applied, conflicts };
  }

  /**
   * Apply a single cloud SchemaSpec to the local lattice. Returns true
   * if any change was made (new table, new column), false if local was
   * already in sync. Throws `TeamsSchemaConflictError` on PK mismatch.
   */
  async applyCloudSchemaLocally(table: string, spec: SchemaSpec): Promise<boolean> {
    return applySchemaSpec(this.local, table, spec);
  }

  // ── Local persistence (encrypted API tokens) ────────────────────────────

  /**
   * Persist a team connection in the local lattice. If a row already
   * exists for the same `team_id`, it's overwritten — the caller has
   * presumably just redeemed a fresh invitation or recreated the team.
   *
   * Token encryption: Phase 2 stores tokens in plaintext. Lattice's
   * existing AES-256-GCM encryption layer can wrap this column when the
   * caller configures `encryptionKey`, but the entity-context encryption
   * API doesn't apply to raw `define()`/`defineLate()` tables yet. A
   * follow-up will enable per-column encryption for these internal
   * tables; until then operators should keep their lattice DB file safe.
   */
  async saveConnection(conn: {
    team_id: string;
    team_name: string;
    cloud_url: string;
    my_user_id: string;
    api_token: string;
  }): Promise<void> {
    await this.ensureLocalTables();
    await this.local.upsert('__lattice_team_connections', {
      team_id: conn.team_id,
      team_name: conn.team_name,
      cloud_url: conn.cloud_url,
      my_user_id: conn.my_user_id,
      api_token_encrypted: conn.api_token,
      joined_at: new Date().toISOString(),
    });
  }

  async deleteConnection(teamId: string): Promise<void> {
    await this.ensureLocalTables();
    await this.local.delete('__lattice_team_connections', teamId);
  }

  async listConnections(): Promise<TeamConnection[]> {
    await this.ensureLocalTables();
    const rows = (await this.local.query(
      '__lattice_team_connections',
      {},
    )) as unknown as ConnectionRow[];
    return rows.map((r) => ({
      team_id: r.team_id,
      team_name: r.team_name,
      cloud_url: r.cloud_url,
      my_user_id: r.my_user_id,
      api_token: r.api_token_encrypted,
      joined_at: r.joined_at,
    }));
  }

  /**
   * Resolve a team name to a local connection row. Throws if more than
   * one matches (e.g. user joined two teams with the same name on
   * different clouds) — caller must disambiguate with team_id.
   */
  async findConnectionByName(teamName: string): Promise<TeamConnection | null> {
    const conns = await this.listConnections();
    const matches = conns.filter((c) => c.team_name === teamName);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous team name "${teamName}" — matches ${String(matches.length)} cloud connections. ` +
          `Use the team-id form to disambiguate.`,
      );
    }
    return matches[0] ?? null;
  }

  // ── Row link / unlink (Phase 4) ─────────────────────────────────────────

  /**
   * Link a local row to a team. Reads the current local row, POSTs the
   * snapshot to the cloud (which creates a `__lattice_row_links` row +
   * mirrors the data into the team's shared table + emits link/upsert
   * envelopes), and records the link on the local side.
   *
   * Also ensures the sync write-hook is attached for `table` so future
   * local writes to this row drain through the outbox to the cloud.
   */
  async linkRow(
    connection: TeamConnection,
    table: string,
    pk: string,
  ): Promise<{ owner_user_id: string; seq: number }> {
    await this.ensureLocalTables();
    const snapshot = await this.local.get(table, pk);
    if (!snapshot) {
      throw new Error(`Row not found in local table "${table}" with pk "${pk}"`);
    }
    if (isPostgresUrl(connection.cloud_url)) {
      const result = await linkRowDirect(
        this.local,
        connection.cloud_url,
        connection.team_id,
        connection.my_user_id,
        table,
        pk,
      );
      this.ensureWriteHook(table);
      return result;
    }
    const result = await this.fetchAuthed<{ owner_user_id: string; seq: number }>(
      connection.cloud_url,
      connection.api_token,
      'POST',
      `/api/teams/${connection.team_id}/objects/${encodeURIComponent(table)}/links`,
      { pk, row_snapshot: snapshot },
    );
    await this.local.upsert('__lattice_local_links', {
      team_id: connection.team_id,
      table_name: table,
      pk,
      owner_user_id: result.owner_user_id,
      linked_at: new Date().toISOString(),
    });
    this.ensureWriteHook(table);
    return result;
  }

  /**
   * Remove a row from the team. The cloud verifies the caller is the
   * owner (or team creator) and emits an `unlink` envelope; the local
   * link row is removed and the local data row is kept in place (Phase
   * 4 v1 default — receivers' pullers handle their own removal).
   */
  async unlinkRow(connection: TeamConnection, table: string, pk: string): Promise<void> {
    await this.ensureLocalTables();
    if (isPostgresUrl(connection.cloud_url)) {
      await unlinkRowDirect(this.local, connection.cloud_url, connection.team_id, table, pk);
      return;
    }
    await this.fetchAuthed<unknown>(
      connection.cloud_url,
      connection.api_token,
      'DELETE',
      `/api/teams/${connection.team_id}/objects/${encodeURIComponent(table)}/links/${encodeURIComponent(pk)}`,
    );
    try {
      await this.local.delete('__lattice_local_links', {
        team_id: connection.team_id,
        table_name: table,
        pk,
      });
    } catch {
      // Link row may have already been removed by a concurrent pull.
    }
  }

  /**
   * Scan `__lattice_local_links` for tables that currently have at
   * least one link and ensure a write-hook is registered for each.
   * Called by CLI sync commands at session start to re-arm hooks after
   * a process restart (write hooks are bound to the in-memory Lattice
   * instance, not the underlying DB).
   */
  async attachWriteHooks(): Promise<void> {
    await this.ensureLocalTables();
    const links = (await this.local.query(
      '__lattice_local_links',
      {},
    )) as unknown as LocalLinkRow[];
    const tables = new Set(links.map((l) => l.table_name));
    for (const t of tables) this.ensureWriteHook(t);
  }

  /**
   * Register a sync write-hook for a single table. Idempotent: a second
   * call for the same table is a no-op. Called automatically by
   * `linkRow` and `applyCloudSchemaLocally`; manual callers can invoke
   * directly for tables that exist before any link/share happens.
   *
   * The hook captures local writes to linked rows into
   * `__lattice_team_outbox`. The replay guard (`_isReplaying`) skips
   * captures during envelope application so pulled changes don't get
   * pushed back to the cloud.
   */
  ensureWriteHook(table: string): void {
    if (this._hookedTables.has(table)) return;
    this._hookedTables.add(table);
    this.local.defineWriteHook({
      table,
      on: ['insert', 'update', 'delete'],
      handler: (ctx) => this.captureWrite(ctx),
    });
  }

  private async captureWrite(ctx: WriteHookContext): Promise<void> {
    if (this._isReplaying) return;
    // Find every (team, owner=me) link that matches (table, pk). One
    // outbox row per matching team.
    const links = (await this.local.query('__lattice_local_links', {
      filters: [
        { col: 'table_name', op: 'eq', val: ctx.table },
        { col: 'pk', op: 'eq', val: ctx.pk },
      ],
    })) as unknown as LocalLinkRow[];
    if (links.length === 0) return;
    // Lattice's update-hook ctx.row contains only the partial diff
    // (missing the PK and unchanged columns), so push a full snapshot
    // re-read from the DB. The write has already committed by the time
    // the hook fires, so `get()` here sees the new state.
    let payloadJson: string | null = null;
    if (ctx.op !== 'delete') {
      const fullRow = await this.local.get(ctx.table, ctx.pk);
      if (!fullRow) return; // race: row already gone, skip
      payloadJson = JSON.stringify(fullRow);
    }
    for (const link of links) {
      const conn = (await this.local.get(
        '__lattice_team_connections',
        link.team_id,
      )) as unknown as ConnectionRow | null;
      if (!conn) continue;
      // Push only rows I own. Non-owner writes to mirrored rows are a
      // local-only divergence — the next pull will overwrite them with
      // the cloud's (owner's) state.
      if (conn.my_user_id !== link.owner_user_id) continue;
      const now = new Date().toISOString();
      await this.local.insert('__lattice_team_outbox', {
        id: randomUUID(),
        team_id: link.team_id,
        table_name: ctx.table,
        pk: ctx.pk,
        op: ctx.op,
        payload_json: payloadJson,
        attempts: 0,
        next_attempt_at: now,
        created_at: now,
      });
    }
  }

  // ── Push: drain outbox → cloud (Phase 4) ────────────────────────────────

  /**
   * Drain the outbox for one team in FIFO order. Each entry POSTs to
   * the cloud's row endpoint (or DELETEs for soft-delete ops). 2xx
   * deletes the outbox row; failures increment `attempts` + set
   * `next_attempt_at` to an exponential-backoff future timestamp,
   * leaving the row for a later drain.
   *
   * Phase 4 v1: no separate dead-letter for outbox entries. Repeated
   * 4xx responses just keep retrying with a growing backoff — operator
   * surfaces them via `lattice teams status`.
   */
  async drainOutbox(connection: TeamConnection): Promise<PushResult> {
    await this.ensureLocalTables();
    // Direct-Postgres mode: local IS cloud. Writes already landed in
    // the same DB the cloud reads, so there's nothing to push. Skip
    // the outbox drain entirely (and avoid the fetch() with embedded
    // credentials that would 400 anyway).
    if (isPostgresUrl(connection.cloud_url)) {
      return { pushed: 0, failed: 0 };
    }
    const now = new Date().toISOString();
    const rows = (await this.local.query('__lattice_team_outbox', {
      filters: [
        { col: 'team_id', op: 'eq', val: connection.team_id },
        { col: 'next_attempt_at', op: 'lte', val: now },
      ],
      orderBy: 'created_at',
      orderDir: 'asc',
    })) as unknown as OutboxRow[];
    let pushed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        if (row.op === 'delete') {
          await this.fetchAuthed<unknown>(
            connection.cloud_url,
            connection.api_token,
            'DELETE',
            `/api/teams/${connection.team_id}/objects/${encodeURIComponent(row.table_name)}/rows/${encodeURIComponent(row.pk)}`,
          );
        } else {
          const payload = row.payload_json ? (JSON.parse(row.payload_json) as Row) : {};
          await this.fetchAuthed<unknown>(
            connection.cloud_url,
            connection.api_token,
            'POST',
            `/api/teams/${connection.team_id}/objects/${encodeURIComponent(row.table_name)}/rows`,
            { pk: row.pk, payload },
          );
        }
        await this.local.delete('__lattice_team_outbox', row.id);
        pushed++;
      } catch (e) {
        failed++;
        const attempts = row.attempts + 1;
        const backoffMs = Math.min(60_000, 2_000 * 2 ** Math.min(row.attempts, 5));
        const nextAt = new Date(Date.now() + backoffMs).toISOString();
        await this.local.update('__lattice_team_outbox', row.id, {
          attempts,
          last_error: (e as Error).message,
          next_attempt_at: nextAt,
        });
      }
    }
    return { pushed, failed };
  }

  // ── Pull: cloud → local with replay guard (Phase 4) ─────────────────────

  /**
   * Pull change envelopes from the cloud and apply them to the local
   * lattice. Loops internally until the cloud reports no more pending
   * envelopes, so a single call drains arbitrary backlog. Bookkeeping:
   * the local connection's `last_change_seq` advances per successful
   * envelope; the replay guard prevents pulled writes from being re-
   * pushed back to the cloud via the outbox.
   *
   * Individual envelope failures land in `__lattice_team_dlq` so one
   * bad row doesn't stall the stream.
   */
  async pullChanges(connection: TeamConnection, batchSize = 500): Promise<PullResult> {
    await this.ensureLocalTables();
    // Direct-Postgres mode: no separate cloud to pull from. fetchChangeBatch
    // already short-circuits to empty for this case, but pullChanges has
    // its own loop and would 400 on the credentialed URL — short-circuit
    // here too.
    if (isPostgresUrl(connection.cloud_url)) {
      return { applied: 0, last_seq: 0, dlq_count: 0 };
    }
    const connRow = (await this.local.get(
      '__lattice_team_connections',
      connection.team_id,
    )) as unknown as ConnectionRow | null;
    let lastSeq = connRow?.last_change_seq ?? 0;
    let totalApplied = 0;
    let dlqCount = 0;

    for (;;) {
      const response = await this.fetchAuthed<{
        envelopes: ChangeEnvelope[];
        has_more: boolean;
      }>(
        connection.cloud_url,
        connection.api_token,
        'GET',
        `/api/teams/${connection.team_id}/changes?since=${lastSeq.toString()}&limit=${batchSize.toString()}`,
      );
      if (response.envelopes.length === 0) break;

      this._isReplaying = true;
      try {
        for (const env of response.envelopes) {
          try {
            await this.applyEnvelope(connection, env);
            totalApplied++;
          } catch (e) {
            await this.local.insert('__lattice_team_dlq', {
              id: randomUUID(),
              team_id: connection.team_id,
              envelope_json: JSON.stringify(env),
              error: (e as Error).message,
              created_at: new Date().toISOString(),
            });
            dlqCount++;
          }
          lastSeq = env.seq;
        }
      } finally {
        this._isReplaying = false;
      }

      // Persist the cursor advance — survives crashes mid-pull.
      await this.local.update('__lattice_team_connections', connection.team_id, {
        last_change_seq: lastSeq,
      });

      if (!response.has_more) break;
    }

    return { applied: totalApplied, last_seq: lastSeq, dlq_count: dlqCount };
  }

  private async applyEnvelope(connection: TeamConnection, env: ChangeEnvelope): Promise<void> {
    switch (env.op) {
      case 'schema': {
        if (!env.table_name || !env.payload) return;
        await this.applyCloudSchemaLocally(env.table_name, env.payload as SchemaSpec);
        this.ensureWriteHook(env.table_name);
        return;
      }
      case 'unshare':
        // Phase 4 v1: receivers keep their local copy of the unshared
        // table. The row-link entries get cleaned up via individual
        // `unlink` envelopes the cloud emits separately.
        return;
      case 'link': {
        if (!env.table_name || !env.pk) return;
        const payload = (env.payload ?? {}) as { owner_user_id?: string };
        const ownerId = payload.owner_user_id ?? env.owner_user_id;
        if (!ownerId) return;
        await this.local.upsert('__lattice_local_links', {
          team_id: connection.team_id,
          table_name: env.table_name,
          pk: env.pk,
          owner_user_id: ownerId,
          linked_at: env.created_at,
        });
        this.ensureWriteHook(env.table_name);
        return;
      }
      case 'unlink': {
        if (!env.table_name || !env.pk) return;
        try {
          await this.local.delete('__lattice_local_links', {
            team_id: connection.team_id,
            table_name: env.table_name,
            pk: env.pk,
          });
        } catch {
          // Link row may already be gone — idempotent.
        }
        // Default unlink behavior: hard-delete the row from local mirror.
        // (`onUnlink: 'keep'` mode is a future per-team setting.)
        try {
          await this.local.delete(env.table_name, env.pk);
        } catch {
          // Row may not exist locally.
        }
        return;
      }
      case 'upsert': {
        if (!env.table_name || !env.payload) return;
        await this.applyUpsertEnvelope(connection, env, env.payload as Row);
        return;
      }
      case 'divergence':
        // Client-side-only DLQ marker — never arrives from the cloud, and the
        // last-write-wins overwrite it records already happened. No-op so a
        // DLQ retry simply clears the notice.
        return;
      case 'delete': {
        if (!env.table_name || !env.pk) return;
        try {
          await this.local.delete(env.table_name, env.pk);
        } catch {
          // Row may not exist locally.
        }
        return;
      }
    }
  }

  /**
   * Apply an `upsert` envelope to a local row, guarding against silently
   * clobbering a non-owner's local edit.
   *
   * A non-owner who edits a mirrored row locally produces no outbox entry
   * (only owners push), so the next owner update would overwrite it with no
   * trace. Before the last-write-wins overwrite, this compares the current
   * local row against the hash captured at the last sync (`synced_hash` on
   * the link row): if they differ, the local copy diverged, so we record a
   * `divergence` entry in the DLQ — capturing the lost local content — then
   * still apply (LWW keeps sync converging). The loss is now visible via
   * `lattice teams dlq list` instead of being silent.
   *
   * Owner rows are never overwritten by foreign upserts, so they skip the
   * check. `synced_hash` is (re)stamped from the stored row after every apply.
   */
  private async applyUpsertEnvelope(
    connection: TeamConnection,
    env: ChangeEnvelope,
    payload: Row,
  ): Promise<void> {
    const table = env.table_name;
    const pk = env.pk;
    if (!table) return;

    const link = pk ? await this.findLocalLink(connection.team_id, table, pk) : null;

    if (
      link &&
      pk &&
      link.owner_user_id !== connection.my_user_id &&
      typeof link.synced_hash === 'string' &&
      link.synced_hash.length > 0
    ) {
      const current = await this.local.get(table, pk);
      if (current && stableRowHash(current) !== link.synced_hash) {
        await this.local.insert('__lattice_team_dlq', {
          id: randomUUID(),
          team_id: connection.team_id,
          envelope_json: JSON.stringify({
            ...env,
            op: 'divergence',
            payload: { incoming: payload, local_overwritten: current },
          }),
          error:
            'non-owner local edit overwritten by owner update (last-write-wins); ' +
            'lost local content captured in payload.local_overwritten',
          created_at: new Date().toISOString(),
        });
      }
    }

    await this.local.upsert(table, payload);

    // Re-stamp the link's synced_hash from the row as actually stored, so the
    // next pull's divergence check has a faithful baseline.
    if (link && pk) {
      const stored = await this.local.get(table, pk);
      if (stored) {
        await this.local.update(
          '__lattice_local_links',
          { team_id: connection.team_id, table_name: table, pk },
          { synced_hash: stableRowHash(stored) },
        );
      }
    }
  }

  private async findLocalLink(
    teamId: string,
    table: string,
    pk: string,
  ): Promise<LocalLinkRow | null> {
    const rows = (await this.local.query('__lattice_local_links', {
      filters: [
        { col: 'team_id', op: 'eq', val: teamId },
        { col: 'table_name', op: 'eq', val: table },
        { col: 'pk', op: 'eq', val: pk },
      ],
    })) as unknown as LocalLinkRow[];
    return rows[0] ?? null;
  }

  // ── Dead-letter queue: inspect / retry / purge (1.14.x) ──────────────────
  // The DLQ used to be write-only — failed pull envelopes landed there and
  // could only be counted via `teams status`, never inspected or replayed.
  // These methods make it observable and recoverable: an envelope that failed
  // because its dependency hadn't arrived yet (out-of-order delivery) can be
  // retried once the dependency lands, instead of being lost behind an
  // ever-advancing pull cursor.

  /**
   * List the DLQ entries for a team, newest first, with the stored envelope
   * parsed for inspection.
   */
  async listDlq(connection: TeamConnection): Promise<DlqEntry[]> {
    await this.ensureLocalTables();
    const rows = (await this.local.query('__lattice_team_dlq', {
      filters: [{ col: 'team_id', op: 'eq', val: connection.team_id }],
      orderBy: 'created_at',
      orderDir: 'desc',
    })) as unknown as {
      id: string;
      team_id: string;
      envelope_json: string;
      error: string;
      created_at: string;
    }[];
    return rows.map((r) => {
      const envelope = JSON.parse(r.envelope_json) as ChangeEnvelope;
      return {
        id: r.id,
        team_id: r.team_id,
        table_name: envelope.table_name ?? null,
        pk: envelope.pk ?? null,
        op: envelope.op,
        error: r.error,
        created_at: r.created_at,
        envelope,
      };
    });
  }

  /**
   * Replay DLQ entries through {@link applyEnvelope}. With `id`, retries just
   * that entry; otherwise retries every entry for the team (oldest first, so
   * dependencies replay before dependents). An entry that applies cleanly is
   * deleted; one that fails again stays, with its `error` refreshed. Runs
   * under the replay guard so a re-applied row isn't pushed back to the cloud.
   */
  async retryDlq(connection: TeamConnection, id?: string): Promise<DlqRetryResult> {
    await this.ensureLocalTables();
    const filters = [{ col: 'team_id', op: 'eq' as const, val: connection.team_id }];
    if (id) filters.push({ col: 'id', op: 'eq' as const, val: id });
    const rows = (await this.local.query('__lattice_team_dlq', {
      filters,
      orderBy: 'created_at',
      orderDir: 'asc',
    })) as unknown as { id: string; envelope_json: string }[];

    let succeeded = 0;
    let failed = 0;
    this._isReplaying = true;
    try {
      for (const row of rows) {
        const envelope = JSON.parse(row.envelope_json) as ChangeEnvelope;
        try {
          await this.applyEnvelope(connection, envelope);
          await this.local.delete('__lattice_team_dlq', row.id);
          succeeded++;
        } catch (e) {
          await this.local.update('__lattice_team_dlq', row.id, {
            error: (e as Error).message,
          });
          failed++;
        }
      }
    } finally {
      this._isReplaying = false;
    }
    return { retried: rows.length, succeeded, failed };
  }

  /**
   * Delete DLQ entries without applying them. With `id`, purges just that
   * entry; otherwise purges every entry for the team. Returns the count
   * removed. Use to discard divergence notices or envelopes that will never
   * apply.
   */
  async purgeDlq(connection: TeamConnection, id?: string): Promise<number> {
    await this.ensureLocalTables();
    const filters = [{ col: 'team_id', op: 'eq' as const, val: connection.team_id }];
    if (id) filters.push({ col: 'id', op: 'eq' as const, val: id });
    const rows = (await this.local.query('__lattice_team_dlq', {
      filters,
    })) as unknown as { id: string }[];
    for (const row of rows) {
      await this.local.delete('__lattice_team_dlq', row.id);
    }
    return rows.length;
  }

  // ── Status (Phase 4) ────────────────────────────────────────────────────

  async getStatus(connection: TeamConnection): Promise<SyncStatus> {
    await this.ensureLocalTables();
    const connRow = (await this.local.get(
      '__lattice_team_connections',
      connection.team_id,
    )) as unknown as ConnectionRow | null;
    const outbox = (await this.local.query('__lattice_team_outbox', {
      filters: [{ col: 'team_id', op: 'eq', val: connection.team_id }],
    })) as unknown as OutboxRow[];
    const dlq = await this.local.count('__lattice_team_dlq', {
      filters: [{ col: 'team_id', op: 'eq', val: connection.team_id }],
    });
    const links = await this.local.count('__lattice_local_links', {
      filters: [{ col: 'team_id', op: 'eq', val: connection.team_id }],
    });
    return {
      team_id: connection.team_id,
      team_name: connection.team_name,
      last_change_seq: connRow?.last_change_seq ?? null,
      outbox_depth: outbox.length,
      outbox_failing: outbox.filter((r) => r.attempts > 0).length,
      dlq_depth: dlq,
      local_links: links,
    };
  }

  // ── HTTP plumbing ───────────────────────────────────────────────────────

  private async fetchUnauthed<T>(
    cloudUrl: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return doFetch<T>(cloudUrl, path, method, body);
  }

  private async fetchAuthed<T>(
    cloudUrl: string,
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return doFetch<T>(cloudUrl, path, method, body, token);
  }
}

async function doFetch<T>(
  cloudUrl: string,
  path: string,
  method: string,
  body: unknown,
  token?: string,
): Promise<T> {
  const url = `${stripTrailingSlash(cloudUrl)}${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let parsedMessage = errText || res.statusText;
    try {
      const parsed = JSON.parse(errText) as { error?: string };
      if (parsed.error) parsedMessage = parsed.error;
    } catch {
      // not JSON, keep raw
    }
    throw new TeamsHttpError(res.status, parsedMessage);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

/**
 * Order-independent content hash of a row, for detecting whether a locally
 * mirrored row was edited since the last sync. Keys are sorted so JSON key
 * order can't produce false positives; values are JSON-serialized with
 * `undefined`/missing normalized to `null`.
 */
function stableRowHash(row: Row): string {
  const keys = Object.keys(row).sort();
  const canonical = JSON.stringify(keys.map((k) => [k, row[k] ?? null]));
  return createHash('sha256').update(canonical).digest('hex');
}

export class TeamsHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`HTTP ${String(status)}: ${message}`);
    this.name = 'TeamsHttpError';
  }
}
