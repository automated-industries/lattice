import { randomUUID } from 'node:crypto';
import type { Lattice } from '../lattice.js';
import { LOCAL_INTERNAL_TABLE_DEFS } from './internal-tables.js';
import { applySchemaSpec, TeamsSchemaConflictError, type SchemaSpec } from './schema-spec.js';
import type { Row, WriteHookContext } from '../types.js';
import { probeCloud, type CloudProbeResult } from '../framework/cloud-connect.js';
import { saveDbCredential, writeToken } from '../framework/user-config.js';
import { isPostgresUrl, registerDirectViaPostgres } from './register-direct.js';

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
  op: 'schema' | 'unshare' | 'link' | 'unlink' | 'upsert' | 'delete';
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
    return this.fetchUnauthed<RedeemResponse>(cloudUrl, 'POST', '/api/auth/redeem-invite', {
      invite_token: inviteToken,
      email,
      name,
    });
  }

  // ── High-level orchestration (v1.13+) ───────────────────────────────────
  // Wraps the multi-step flows the GUI's Database panel + library
  // consumers both need: connecting to an existing cloud DB (with
  // optional team join), and upgrading a non-team cloud into a team
  // cloud. The HTTP routes in src/gui/dbconfig-routes.ts are thin
  // shells over these methods.

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
   * Upgrade an already-connected cloud DB to a team DB. Two paths
   * depending on the cloud URL's scheme:
   *
   *   - `http(s)://…` — POST to the cloud's `/api/auth/register` endpoint
   *     (`lattice serve --team-cloud` is fronting the Postgres).
   *   - `postgres(ql)://…` — drive the same INSERT sequence directly
   *     against the cloud Postgres via {@link registerDirectViaPostgres}.
   *     The HTTP path can't be used here because the browser's Fetch
   *     API refuses URLs with embedded credentials.
   *
   * On success writes the bearer token to `~/.lattice/keys/<label>.token`
   * **and** persists the local `__lattice_team_connections` row so the
   * GUI's team-management API calls can authenticate immediately
   * afterward (members, invites, kick, destroy). v1.13.4 added the
   * connection-row write — the older v1.13 implementation only wrote
   * the token file, leaving GUI authenticated calls with no
   * `cloud_url` + `my_user_id` + `api_token_encrypted` row to read.
   */
  async upgradeToTeamCloud(opts: {
    label: string;
    cloudUrl: string;
    teamName: string;
    email: string;
    displayName: string;
  }): Promise<RegisterResponse> {
    const reg = isPostgresUrl(opts.cloudUrl)
      ? await registerDirectViaPostgres(opts.cloudUrl, opts.email, opts.displayName, opts.teamName)
      : await this.register(opts.cloudUrl, opts.email, opts.displayName, opts.teamName);
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

  // ── Cloud HTTP calls (authenticated) ────────────────────────────────────

  /** Destroy the singleton team. Creator-only on the cloud side. */
  async destroyTeam(cloudUrl: string, token: string): Promise<void> {
    await this.fetchAuthed<unknown>(cloudUrl, token, 'DELETE', '/api/team');
  }

  async listMembers(cloudUrl: string, token: string, teamId: string): Promise<MemberSummary[]> {
    const r = await this.fetchAuthed<{ members: MemberSummary[] }>(
      cloudUrl,
      token,
      'GET',
      `/api/teams/${teamId}/members`,
    );
    return r.members;
  }

  async invite(
    cloudUrl: string,
    token: string,
    teamId: string,
    inviteeEmail: string,
    expiresInHours?: number,
  ): Promise<InviteResponse> {
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
  ): Promise<ShareObjectResponse> {
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
        if (e instanceof TeamsSchemaConflictError) {
          conflicts.push({ table: e.table, reason: e.reason });
        } else {
          throw e;
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
        await this.local.upsert(env.table_name, env.payload as Row);
        return;
      }
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

export class TeamsHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`HTTP ${String(status)}: ${message}`);
    this.name = 'TeamsHttpError';
  }
}
