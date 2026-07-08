import type { Lattice } from '../lattice.js';
import { getAsyncOrSync } from '../db/adapter.js';
import type { ChatProgressEnvelope } from './chat-progress.js';

/**
 * Chat identity + the per-user delivery gate. Extracted from chat-routes so BOTH the
 * chat route (which stamps + filters chat rows) and the /api/stream forwarder (which
 * gates chat-progress delivery) share ONE implementation of "who is this connection".
 *
 * A chat is private to whoever created it. We never rely on Postgres RLS alone: the app
 * connects as a BYPASSRLS role, so RLS does NOT filter the owner's connection — every
 * chat read MUST also filter by this key in the app layer, every chat write MUST stamp
 * it, and every chat-progress push MUST be gated by it. On a cloud the key is the
 * connection's Postgres login role (`session_user`, the same identity cloud RLS keys on);
 * on a local single-user SQLite DB there is no cross-user boundary, so it is null and no
 * scoping is applied.
 */

/** True on a cloud (Postgres) workspace, where chat is per-user scoped. */
export function isCloudChat(db: Lattice): boolean {
  return db.getDialect() === 'postgres';
}

/** The connection's chat owner id (`session_user`), or null on a local DB / when
 *  unresolved. */
export async function resolveChatOwnerId(db: Lattice): Promise<string | null> {
  if (!isCloudChat(db)) return null; // local single-user — no per-user scoping
  const row = (await getAsyncOrSync(db.adapter, 'SELECT session_user AS u')) as
    | { u?: unknown }
    | undefined;
  const u = row?.u;
  return typeof u === 'string' && u.length > 0 ? u : null;
}

/**
 * FAIL-CLOSED per-user gate for forwarding a chat-progress envelope to one connected
 * `/api/stream` socket. The {@link ChatProgressBus} is per-PROCESS (a single instance
 * shared by every socket on the workspace), so WITHOUT this gate a cloud member's socket
 * would receive another member's streamed chat text. RLS does not help here — the app
 * connects BYPASSRLS.
 *
 * @param connOwner   the socket connection's resolved owner ({@link resolveChatOwnerId})
 * @param connIsCloud whether the connection's workspace is a cloud DB ({@link isCloudChat})
 * @param env         the chat-progress envelope (carries the turn's `ownerUserId`)
 *
 * Rules:
 *  - LOCAL (`connIsCloud` false): single-user, no boundary → deliver to all.
 *  - CLOUD: deliver IFF the connection's owner is KNOWN **and** equals the envelope's
 *    owner. Drop on an unresolved connection identity (`connOwner == null`) or an
 *    un-owned envelope (`env.ownerUserId == null`) — an un-owned turn must never reach a
 *    cloud socket.
 */
export function mayReceiveChat(
  connOwner: string | null,
  connIsCloud: boolean,
  env: ChatProgressEnvelope,
): boolean {
  if (!connIsCloud) return true; // local — no cross-user boundary
  if (connOwner == null) return false; // cloud but identity unresolved → fail closed
  return env.ownerUserId != null && env.ownerUserId === connOwner;
}
