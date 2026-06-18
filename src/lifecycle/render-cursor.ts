/**
 * Open-time render staleness gate — the cursor half.
 *
 * The GUI re-renders the whole context tree on every open (a plain restart and a
 * version update are both just "boot → background render"). That full render is
 * pure churn when nothing the tree depends on has changed: it re-reads every
 * table off the wire (shared-quota egress) and emits per-table progress the GUI
 * paints as "Rendering…%" overlays even though zero files change.
 *
 * This module computes a small, string-comparable CURSOR of everything a rendered
 * tree depends on, recorded in the manifest at render time and re-read at open
 * time. When the live cursor has not advanced past the recorded one (and the
 * render OUTPUT format hasn't changed), the open render can be SKIPPED entirely.
 *
 * Correctness over churn: a naive `COUNT(*)+MAX(updated_at)` fingerprint is wrong
 * here. Many tables have no `updated_at` (an in-place edit would be invisible),
 * and a cloud MEMBER's tree depends on things that never move an entity table's
 * count — a new derived observation, or an owner sharing / un-sharing a row. So
 * the cursor is built from the WRITE LOG (`__lattice_changelog`, which records
 * every edit and every observation) and the SHARING GRAPH, both read THROUGH the
 * current connection's scope so a member's cursor is inherently per-viewer.
 *
 * Every read here is best-effort and FAILS OPEN: any error, missing substrate, or
 * unreadable relation yields `null` for that field, and a `null` on either side of
 * the comparison forces a render. The gate never skips on uncertainty.
 */
import type { StorageAdapter } from '../db/adapter.js';
import { getAsyncOrSync } from '../db/adapter.js';
import type { RenderCursor } from './manifest.js';
import { TEMPLATE_VERSION } from './manifest.js';

/** A cursor whose every field is null — the "I couldn't read anything" sentinel. */
const EMPTY_CURSOR: RenderCursor = { changelog: null, grants: null, owners: null };

/** Coerce any scalar a driver returns (bigint, number, Date, string) to a
 *  string-comparable mark, or null. Postgres `bigint` arrives as a string from
 *  node-postgres; SQLite `MAX(rowid)` as a number; timestamps as a Date or ISO
 *  string. All compare correctly as strings EXCEPT numerics of differing width,
 *  which is why the numeric marks below are zero-padded before stringifying. */
function markToString(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  // An unexpected object/array shape from the driver — don't stringify it to
  // "[object Object]" (which would compare equal across genuinely different
  // states). Treat as unreadable → null → the gate fails open and renders.
  return null;
}

/** Left-pad a non-negative integer-ish mark so plain string comparison orders it
 *  like a number (`'9' < '10'` is false as strings; `'00000009' < '00000010'` is
 *  true). Width 20 covers a 64-bit identity counter. Non-integers (timestamps)
 *  are returned unchanged — ISO-8601 already sorts lexicographically. */
function padNumericMark(v: unknown): string | null {
  const s = markToString(v);
  if (s == null) return null;
  if (/^\d+$/.test(s)) return s.padStart(20, '0');
  return s;
}

/** Does `__lattice_changelog` physically exist for this connection? Read-only;
 *  never issues DDL (a scoped member can't create it). */
async function changelogExists(adapter: StorageAdapter): Promise<boolean> {
  if (adapter.dialect === 'postgres') {
    const row = (await getAsyncOrSync(
      adapter,
      `SELECT to_regclass('__lattice_changelog') AS reg`,
    )) as { reg?: string | null } | undefined;
    return !!row && row.reg != null;
  }
  const row = (await getAsyncOrSync(
    adapter,
    `SELECT name FROM sqlite_master WHERE type='table' AND name='__lattice_changelog'`,
  )) as { name?: string } | undefined;
  return !!row;
}

/**
 * High-water mark of the change/write log, read through the CURRENT scope.
 *
 * On Postgres the changelog carries a monotonic `seq` identity column and is
 * RLS-filtered for a member (`lattice_changelog_sel`), so `MAX(seq)` is exactly
 * "the newest changelog row THIS viewer can see" — it advances on a member-visible
 * derived observation as well as on a plain edit. On SQLite there is no cloud
 * scope; `MAX(rowid)` is the monotonic insertion mark.
 *
 * Returns `null` when the substrate is absent or unreadable — never throws.
 */
async function changelogMark(adapter: StorageAdapter): Promise<string | null> {
  try {
    if (!(await changelogExists(adapter))) return null;
    const col = adapter.dialect === 'postgres' ? 'seq' : 'rowid';
    const row = (await getAsyncOrSync(
      adapter,
      `SELECT MAX(${col}) AS m FROM __lattice_changelog`,
    )) as { m?: unknown } | undefined;
    return padNumericMark(row?.m);
  } catch {
    return null;
  }
}

/**
 * Sharing-graph STATE DIGEST, read through the CURRENT scope.
 *
 * A share or un-share changes a member's visible row set without writing any
 * entity row, and grant/revoke do NOT append a `__lattice_changelog` entry — so
 * the changelog mark misses them. We capture them here.
 *
 * Unlike the changelog mark, the sharing digest is NOT monotonic from a member's
 * viewpoint: an un-share REMOVES a row from what the member can see, so a "newest
 * seq" alone would not move (or would even fall) on a revoke. So the digest is a
 * `count#max` pair compared by EQUALITY (see {@link cursorIsFresh}) — any
 * difference, up OR down, means the member's visible share state changed.
 *
 * - **Member (no direct read on the owner-only bookkeeping):** the only share
 *   signal a member may read is the member-visible change FEED. `lattice_changes_since`
 *   is a SECURITY-DEFINER function returning ONLY the feed rows whose underlying
 *   row the caller can see, and grant/revoke each append one. A SHARE makes the
 *   row (and its feed rows) visible → the member's feed count rises. An UN-SHARE
 *   makes the row invisible → the previously-visible feed rows for that row drop
 *   OUT of the member's view → the count falls. Either way `count#max` over the
 *   member-visible feed CHANGES — so an equality comparison catches both. No
 *   owner-only table is read, so nothing leaks. Both fields are set to this digest.
 * - **Owner / DBA (direct read):** the ownership + grant bookkeeping is readable,
 *   so `owners` = `count#MAX(updated_at)` of `__lattice_owners` and `grants` =
 *   `count#MAX(granted_at)` of `__lattice_row_grants` (count pairs with max so a
 *   revoke — count drops, max may not — still changes the digest).
 * - **SQLite / non-cloud:** no sharing graph → both null. A null marker on the
 *   recorded OR live side forces a render; for a local single-user DB the
 *   changelog mark alone already decides freshness (both-null reads as fresh).
 *
 * Returns `{ grants, owners }`, either of which may be `null`. Never throws.
 */
async function sharingMarks(
  adapter: StorageAdapter,
): Promise<{ grants: string | null; owners: string | null }> {
  if (adapter.dialect !== 'postgres') return { grants: null, owners: null };
  // Member path: try the member-safe change feed first. A member has no SELECT on
  // __lattice_owners / __lattice_row_grants, so reading those raw throws
  // "permission denied" — which the owner path below handles by returning null
  // (fail-open). The feed function exists only on a secured cloud.
  try {
    const reg = (await getAsyncOrSync(
      adapter,
      `SELECT to_regclass('__lattice_changes') AS reg`,
    )) as { reg?: string | null } | undefined;
    const hasFeed = !!reg && reg.reg != null;
    if (hasFeed) {
      // Bounded (the function clamps LIMIT ≤ 1000): a `count#max` digest of the
      // member-visible feed. Changes on share (count up) AND un-share (a now-
      // invisible row's feed rows drop out → count down). Owner rows are visible to
      // the owner too, so this is also a correct (coarser) digest on the owner
      // connection — but the owner-direct path below is preferred when reachable.
      const row = (await getAsyncOrSync(
        adapter,
        `SELECT COUNT(*) AS n, MAX(seq) AS m FROM lattice_changes_since(0, 1000)`,
      )) as { n?: unknown; m?: unknown } | undefined;
      // A feed that exists but is empty (count 0) is still a valid digest — the
      // member can see no shared changes yet. Distinguish "feed present" from the
      // owner-fallback by always returning the digest when the function ran.
      const digest = digestOf(row?.n, row?.m);
      return { grants: digest, owners: digest };
    }
  } catch {
    // Fall through to the owner-direct path (e.g. an older cloud without the feed).
  }
  // Owner / DBA direct path: read the bookkeeping tables. Throws → null (fail-open).
  let owners: string | null = null;
  let grants: string | null = null;
  try {
    const o = (await getAsyncOrSync(
      adapter,
      `SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM __lattice_owners`,
    )) as { n?: unknown; m?: unknown } | undefined;
    owners = digestOf(o?.n, o?.m);
  } catch {
    owners = null;
  }
  try {
    const g = (await getAsyncOrSync(
      adapter,
      `SELECT COUNT(*) AS n, MAX(granted_at) AS m FROM __lattice_row_grants`,
    )) as { n?: unknown; m?: unknown } | undefined;
    grants = digestOf(g?.n, g?.m);
  } catch {
    grants = null;
  }
  return { grants, owners };
}

/** `count#max` digest of a relation; null only when the count itself is null
 *  (the read failed). A zero-count relation digests as `0#` — a valid, stable
 *  "nothing shared" state that compares equal to itself across opens. */
function digestOf(count: unknown, max: unknown): string | null {
  const n = padNumericMark(count);
  if (n == null) return null;
  const m = markToString(max) ?? '';
  return `${n}#${m}`;
}

/**
 * Compute the full render cursor through `adapter`'s current scope. Best-effort:
 * any field that can't be read is `null`. Never throws.
 */
export async function computeRenderCursor(adapter: StorageAdapter): Promise<RenderCursor> {
  try {
    const [changelog, sharing] = await Promise.all([changelogMark(adapter), sharingMarks(adapter)]);
    return { changelog, grants: sharing.grants, owners: sharing.owners };
  } catch {
    return { ...EMPTY_CURSOR };
  }
}

/**
 * Is a tree rendered with `recorded` (template version + cursor) still FRESH
 * relative to the `live` cursor — i.e. can the open render be SKIPPED?
 *
 * Skip is allowed ONLY when ALL hold:
 *  1. the recorded template version matches {@link TEMPLATE_VERSION} (an output-
 *     format change always re-renders), and
 *  2. `changelog` is a MONOTONIC high-water mark — fresh iff the live mark is
 *     `<=` the recorded one (nothing newer appeared), and
 *  3. `grants` / `owners` are sharing-graph STATE DIGESTS — fresh iff the live
 *     digest EQUALS the recorded one. Equality (not `<=`) because a member's
 *     visible share state is non-monotonic: an un-share REMOVES a row, lowering
 *     the digest, which `<=` would wrongly accept as "fresh". Any difference, up
 *     or down, is a real visibility change → render.
 *
 * For every field, both-null is "fresh" (the substrate is consistently absent in
 * this scope — e.g. a local SQLite DB has no sharing graph), and exactly-one-null
 * is "stale" (the substrate's readability changed between render and open → we
 * can't prove it's unchanged → render, fail-open). This is intentionally
 * conservative: a needless render costs churn; a wrong skip leaves a stale (and,
 * for a member, security-relevant) tree.
 */
export function cursorIsFresh(
  recorded: { templateVersion?: number; cursor?: RenderCursor } | null,
  live: RenderCursor,
  templateVersion: number = TEMPLATE_VERSION,
): boolean {
  if (recorded == null) return false;
  if (recorded.templateVersion !== templateVersion) return false;
  const rc = recorded.cursor;
  if (rc == null) return false;

  // Monotonic field: stale only when something NEWER appeared.
  if (!fieldFresh(rc.changelog, live.changelog, (r, l) => l <= r)) return false;
  // State-digest fields: stale on ANY difference (handles un-share count drops).
  if (!fieldFresh(rc.grants, live.grants, (r, l) => l === r)) return false;
  if (!fieldFresh(rc.owners, live.owners, (r, l) => l === r)) return false;
  return true;
}

/** Per-field freshness with consistent null handling: both-null → fresh,
 *  one-null → stale (fail-open), both-non-null → delegate to `ok`. */
function fieldFresh(
  recorded: string | null,
  live: string | null,
  ok: (recorded: string, live: string) => boolean,
): boolean {
  if (recorded == null && live == null) return true;
  if (recorded == null || live == null) return false;
  return ok(recorded, live);
}
