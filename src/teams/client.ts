import type { Lattice } from '../lattice.js';
import { LOCAL_INTERNAL_TABLE_DEFS } from './internal-tables.js';
import {
  deserializeSchema,
  diffSchemaForAdditive,
  renderColumnType,
  TeamsSchemaConflictError,
  type SchemaSpec,
} from './schema-spec.js';

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

export interface RegisterResponse {
  user: { id: string; email: string; name: string };
  raw_token: string;
}

export interface RedeemResponse extends RegisterResponse {
  team: { id: string; name: string };
}

export interface TeamSummary {
  id: string;
  name: string;
  role: string;
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
  op: string;
  payload: unknown;
  created_at: string;
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
  joined_at: string;
}

export class TeamsClient {
  private _tablesReady = false;

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

  async register(cloudUrl: string, email: string, name: string): Promise<RegisterResponse> {
    return this.fetchUnauthed<RegisterResponse>(cloudUrl, 'POST', '/api/auth/register', {
      email,
      name,
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

  // ── Cloud HTTP calls (authenticated) ────────────────────────────────────

  async listTeams(cloudUrl: string, token: string): Promise<TeamSummary[]> {
    const r = await this.fetchAuthed<{ teams: TeamSummary[] }>(
      cloudUrl,
      token,
      'GET',
      '/api/teams',
    );
    return r.teams;
  }

  async createTeam(cloudUrl: string, token: string, name: string): Promise<TeamSummary> {
    return this.fetchAuthed<TeamSummary>(cloudUrl, token, 'POST', '/api/teams', { name });
  }

  async deleteTeam(cloudUrl: string, token: string, teamId: string): Promise<void> {
    await this.fetchAuthed<unknown>(cloudUrl, token, 'DELETE', `/api/teams/${teamId}`);
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
    expiresInHours?: number,
  ): Promise<InviteResponse> {
    const body = expiresInHours !== undefined ? { expires_in_hours: expiresInHours } : {};
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
  async pullChanges(
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
    let localColumns: string[];
    try {
      localColumns = await this.local.introspectColumns(table);
    } catch {
      localColumns = [];
    }

    if (localColumns.length === 0) {
      // Table doesn't exist locally — register it.
      const def = deserializeSchema(spec, this.local.getDialect());
      await this.local.defineLate(table, def);
      return true;
    }

    const localPk = this.local.getPrimaryKey(table);
    const { addColumns } = diffSchemaForAdditive(table, spec, localColumns, localPk);
    if (addColumns.length === 0) return false;
    for (const colName of addColumns) {
      const colSpec = spec.columns[colName];
      if (!colSpec) continue;
      const sqlType = renderColumnType(colSpec, this.local.getDialect());
      await this.local.addColumn(table, colName, sqlType);
    }
    return true;
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
