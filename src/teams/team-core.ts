import type { Lattice } from '../lattice.js';
import type { MemberSummary } from './client.js';

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
