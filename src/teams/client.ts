import type { Lattice } from '../lattice.js';
import { LOCAL_INTERNAL_TABLE_DEFS } from './internal-tables.js';

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
