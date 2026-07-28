import { randomUUID } from 'node:crypto';
import type { Lattice } from '../../lattice.js';
import type { StorageAdapter } from '../../db/adapter.js';
import { runAsyncOrSync, getAsyncOrSync, allAsyncOrSync } from '../../db/adapter.js';

/**
 * DURABLE CONSENT RECORDS — the server's own memory of what the user agreed to.
 *
 * Today's destructive gate reconstructs consent every turn by re-reading the LLM
 * transcript: the question comes from a replayed `ask_user` tool_use block and the
 * answer from the text of the user's message. BOTH halves are text the MODEL
 * authored or can steer, so the evidence that unlocks a destructive call can be
 * manufactured by the thing being gated. This store is the other half of the fix:
 * when a question is put to the user, the server writes down — before anything is
 * shown — exactly WHICH destructive calls an affirmative click would authorize,
 * and which option index counts as that click. Consent then becomes a row this
 * process wrote, keyed by an id the model never sees the meaning of, rather than a
 * sentence the model wrote.
 *
 * Managed via RAW DDL + raw SQL (NOT `db.define` / `defineLate`), exactly like
 * `__lattice_questions` / `__lattice_lineage`: an unregistered `__lattice_` table.
 * That is deliberate and load-bearing here — an unregistered table never appears in
 * `db.getRegisteredTableNames()`, so the assistant cannot list it, read it, or
 * write to it even if a prefix-based visibility filter somewhere ever regresses.
 * The renderer never walks it either. Timestamps carry NO SQL DEFAULT (the
 * SQLite-only `strftime(...)` default is non-parseable on Postgres) — every writer
 * supplies an explicit ISO string, keeping the CREATE byte-identical across
 * dialects.
 *
 * Everything here is FAIL-CLOSED. An unknown id, a record from another thread or
 * another user, an already-answered record, an expired one, an already-spent
 * grant, a malformed payload, or a write that does not land all resolve to "no
 * consent" — never to a bare throw a caller might read as success.
 *
 * NOTE: this module is currently INERT. It is the storage foundation; the gate
 * still runs on the transcript-derived evidence until a later change cuts over.
 */
export const CONSENT_TABLE = '__lattice_ai_consent';

/** Lifecycle of one consent record. Only `granted` can authorize anything. */
export type ConsentStatus = 'pending' | 'granted' | 'declined' | 'expired';

/**
 * ONE destructive call an affirmative answer would authorize.
 *
 * Every field is SERVER-DERIVED — computed by the pre-flight classifier from the
 * call the model asked to make and from counts read out of the database. There is
 * deliberately NO field that can carry model-authored prose (no question text, no
 * option label, no free-form note, no title): a grant is a machine-checkable
 * description of a call, not a sentence to be pattern-matched. That is the whole
 * point — the previous mechanism failed precisely because model-authored text was
 * load-bearing evidence. {@link normalizeGrant} enforces the field set on the way
 * in, so a caller that later hands over an object carrying extra keys has those
 * keys DROPPED rather than persisted.
 */
export interface ConsentGrant {
  /** Registry function name this grant authorizes (`delete_entity`, `dedup`, …). */
  tool: string;
  /** The classifier's kind (`remove_object` | `delete_records` | `unlink` | `clear`). */
  kind: string;
  /** The object (table) the call destroys from. */
  target: string;
  /**
   * The `verbKey` of the authorized call — see `verbKey()` in `dispatch.ts`. This
   * is what stops "yes, remove the object but keep the data" from authorizing a
   * cascade: a retry whose verbKey differs is a DIFFERENT act and is not covered.
   */
  verbKey: string;
  /** Upper bound on records this grant covers. A wider retry is not covered. */
  maxRows: number;
  /** True when the count could not be established (treated as wide, never as 0). */
  rowsUnknown: boolean;
  /**
   * True when `maxRows` is a FLOOR rather than a total — the pre-flight count hit its
   * cap and stopped. Persisted because the number alone cannot say so, and a grant
   * that records "5001" indistinguishably for a 5,001-row table and a 5,000,000-row
   * one is a record of consent to something the user was never shown. The card renders
   * it as "at least"; the bound itself still compares numerically, which stays correct
   * in both directions (a saturated call can only be covered by a saturated grant,
   * because no unsaturated count can reach the cap).
   */
  rowsSaturated: boolean;
  /** Server-composed phrase naming the exact target + count, for the audit trail. */
  detail: string;
  /** ISO timestamp the grant was consumed. Present ⇒ spent ⇒ never usable again. */
  spentAt?: string;
  /** Which call consumed it (an internal correlation id, never user/model prose). */
  spentBy?: string;
}

/** A consent record, decoded. */
export interface ConsentRecord {
  id: string;
  createdAt: string;
  expiresAt: string;
  threadId: string;
  ownerUserId: string | null;
  askedMsgId: string | null;
  status: ConsentStatus;
  grants: ConsentGrant[];
  /** The option index that counts as "yes". Any other index is a decline. */
  affirmIndex: number;
  /** How many options the user was shown (bounds a valid answer index). */
  optionCount: number;
  answeredAt: string | null;
  answerIndex: number | null;
}

/** Who a resolution must come from for the record to be theirs to answer. */
export interface ConsentScope {
  threadId: string;
  ownerUserId?: string | null;
}

/**
 * The outcome of answering a consent record. `rejected` is distinct from
 * `declined`: declined means the user really answered and said no; rejected means
 * the answer could not be attributed to this record at all (unknown, stale,
 * expired, someone else's). Both grant nothing.
 */
export interface ConsentResolution {
  status: 'granted' | 'declined' | 'rejected';
  /** Why it was rejected / how it was read. Never shown to the model as consent. */
  reason?: string;
  record?: ConsentRecord;
}

export interface MintConsentInput {
  threadId: string;
  ownerUserId?: string | null;
  askedMsgId?: string | null;
  /** The exact calls an affirmative answer authorizes. May be empty (authorizes nothing). */
  grants: ConsentGrant[];
  affirmIndex: number;
  optionCount: number;
  /** How long the answer stays answerable. Non-positive ⇒ born expired. */
  ttlMs: number;
}

/** The raw column shape, before decoding. */
interface ConsentRow {
  id: string;
  created_at: string;
  expires_at: string;
  thread_id: string;
  owner_user_id: string | null;
  asked_msg_id: string | null;
  status: string;
  grants_json: string;
  affirm_index: number;
  option_count: number;
  answered_at: string | null;
  answer_index: number | null;
}

/** Create the consent table + its per-thread scan index. Idempotent. */
export async function ensureConsentTable(adapter: StorageAdapter): Promise<void> {
  await runAsyncOrSync(
    adapter,
    `CREATE TABLE IF NOT EXISTS "${CONSENT_TABLE}" (
       "id"            TEXT PRIMARY KEY,
       "created_at"    TEXT NOT NULL,
       "expires_at"    TEXT NOT NULL,
       "thread_id"     TEXT NOT NULL,
       "owner_user_id" TEXT,
       "asked_msg_id"  TEXT,
       "status"        TEXT NOT NULL,
       "grants_json"   TEXT NOT NULL,
       "affirm_index"  INTEGER NOT NULL,
       "option_count"  INTEGER NOT NULL,
       "answered_at"   TEXT,
       "answer_index"  INTEGER
     )`,
  );
  await runAsyncOrSync(
    adapter,
    `CREATE INDEX IF NOT EXISTS "${CONSENT_TABLE}_thread_status_idx" ON "${CONSENT_TABLE}" ("thread_id", "status")`,
  );
}

/** A string, or '' for anything that is not one. Never `undefined`, never coerced prose. */
function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** A non-negative integer, or 0. */
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

/** Literally `true`, or false. A truthy non-boolean never becomes a yes here. */
function flag(v: unknown): boolean {
  return v === true;
}

/**
 * A `COUNT(*)` result as a number. Postgres returns bigint counts as STRINGS
 * through `pg`, where SQLite returns numbers — reading one shape only would report
 * 0 on the other dialect.
 */
function sqlCount(v: unknown): number {
  if (typeof v === 'number') return count(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? count(n) : 0;
  }
  return 0;
}

/**
 * The ONLY fields a persisted grant may carry, picked explicitly. Anything else
 * on the input object — including a field a future caller adds carelessly — is
 * dropped here rather than written to the row. This is the enforcement point for
 * "no model-authored text in a grant".
 */
function normalizeGrant(g: ConsentGrant): ConsentGrant {
  const out: ConsentGrant = {
    tool: text(g.tool),
    kind: text(g.kind),
    target: text(g.target),
    verbKey: text(g.verbKey),
    maxRows: count(g.maxRows),
    rowsUnknown: flag(g.rowsUnknown),
    rowsSaturated: flag(g.rowsSaturated),
    detail: text(g.detail),
  };
  const spentAt = text(g.spentAt);
  const spentBy = text(g.spentBy);
  if (spentAt) out.spentAt = spentAt;
  if (spentBy) out.spentBy = spentBy;
  return out;
}

/**
 * Deterministic encoding of the grant list. Deterministic on purpose:
 * {@link spendGrant} compares the stored string against a re-encoding of what it
 * read, so a concurrent spend cannot be overwritten.
 */
function encodeGrants(grants: readonly ConsentGrant[]): string {
  return JSON.stringify(grants.map(normalizeGrant));
}

function decodeGrants(raw: string): ConsentGrant[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((g) => normalizeGrant(g as ConsentGrant));
  } catch {
    // A payload we cannot read authorizes nothing — the caller sees "no consent".
    return null;
  }
}

function decodeStatus(raw: string): ConsentStatus | null {
  return raw === 'pending' || raw === 'granted' || raw === 'declined' || raw === 'expired'
    ? raw
    : null;
}

function decodeRow(row: ConsentRow): ConsentRecord | null {
  const status = decodeStatus(text(row.status));
  const grants = decodeGrants(text(row.grants_json));
  if (!status || !grants) {
    console.warn(`[assistant] unreadable consent record "${text(row.id)}" — treated as no consent`);
    return null;
  }
  return {
    id: text(row.id),
    createdAt: text(row.created_at),
    expiresAt: text(row.expires_at),
    threadId: text(row.thread_id),
    ownerUserId: typeof row.owner_user_id === 'string' ? row.owner_user_id : null,
    askedMsgId: typeof row.asked_msg_id === 'string' ? row.asked_msg_id : null,
    status,
    grants,
    affirmIndex: typeof row.affirm_index === 'number' ? row.affirm_index : -1,
    optionCount: count(row.option_count),
    answeredAt: typeof row.answered_at === 'string' ? row.answered_at : null,
    answerIndex: typeof row.answer_index === 'number' ? row.answer_index : null,
  };
}

/** True once `at` is at or past the record's expiry. An unparseable expiry is expired. */
export function isConsentExpired(record: ConsentRecord, at: Date = new Date()): boolean {
  const expires = Date.parse(record.expiresAt);
  if (Number.isNaN(expires)) return true;
  return at.getTime() >= expires;
}

/** True when this grant has already been consumed — single-use, forever. */
export function isGrantSpent(grant: ConsentGrant): boolean {
  return typeof grant.spentAt === 'string' && grant.spentAt !== '';
}

/**
 * Write down what an affirmative answer to a question would authorize, BEFORE the
 * question is shown. Returns the record id — the handle the answer comes back
 * with. A failure to write throws: no record means no consent can ever be granted
 * through that question, which is the fail-closed direction, and the caller must
 * not go on to show a question it cannot honour.
 *
 * An `affirmIndex` outside `[0, optionCount)` mints a record nothing can grant.
 * That is intentional — it fails closed rather than guessing which option meant yes.
 */
/**
 * The refusal a cloud MEMBER gets instead of a consent question.
 *
 * Exported so the caller can surface this exact sentence rather than inventing its
 * own, and so a test can pin it.
 */
export const MEMBER_CANNOT_CONSENT =
  'Removing this much data on a shared workspace has to be confirmed by the workspace owner. ' +
  'Nothing was changed. Ask the owner to run it, or ask them to share ownership of these records with you.';

/** Raised when a member reaches the consent path. Carries the user-facing sentence. */
export class MemberCannotConsent extends Error {
  constructor() {
    super(MEMBER_CANNOT_CONSENT);
    this.name = 'MemberCannotConsent';
  }
}

export async function mintConsent(db: Lattice, input: MintConsentInput): Promise<string> {
  // A scoped cloud MEMBER cannot hold consent, by decision — not by accident.
  //
  // The mechanics say so first: a member has no DDL privilege, so the bookkeeping
  // table cannot be created on their connection, and it is deliberately not granted
  // to them. But the product answer is the same one, and it is the reason this is a
  // hard refusal rather than a permissions workaround: on a SHARED workspace, an
  // irreversible removal spanning thousands of rows belongs to the owner. A member
  // asking for it is a reasonable request; a member being able to self-authorize it
  // is not.
  //
  // Refusing LOUDLY is the part that matters. The sibling clarification-question
  // store has exactly this shape, is likewise ungranted to members, and its failure
  // is swallowed by a client `.catch()` — so for a member it simply does nothing,
  // silently. Repeating that here would turn "the owner has to do this" into "the
  // assistant ignored me", which is the worse failure of the two: the user cannot
  // tell a policy from a bug, and retries.
  if (db.isCloudMemberOpen()) throw new MemberCannotConsent();

  await ensureConsentTable(db.adapter);
  const id = randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + input.ttlMs);
  await runAsyncOrSync(
    db.adapter,
    `INSERT INTO "${CONSENT_TABLE}"
       ("id","created_at","expires_at","thread_id","owner_user_id","asked_msg_id","status",
        "grants_json","affirm_index","option_count","answered_at","answer_index")
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL)`,
    [
      id,
      now.toISOString(),
      expires.toISOString(),
      input.threadId,
      input.ownerUserId ?? null,
      input.askedMsgId ?? null,
      encodeGrants(input.grants),
      Math.trunc(input.affirmIndex),
      count(input.optionCount),
    ],
  );
  return id;
}

/**
 * One consent record by id, or null. Never throws: an unreadable store is "no
 * consent", surfaced in the log rather than as an exception a caller could mistake
 * for an empty-but-fine result.
 */
export async function loadConsent(db: Lattice, id: string): Promise<ConsentRecord | null> {
  if (!id) return null;
  try {
    await ensureConsentTable(db.adapter);
    const row = await getAsyncOrSync(
      db.adapter,
      `SELECT * FROM "${CONSENT_TABLE}" WHERE "id" = ?`,
      [id],
    );
    if (!row) return null;
    return decodeRow(row as unknown as ConsentRow);
  } catch (e) {
    console.warn(`[assistant] could not read consent "${id}": ${(e as Error).message}`);
    return null;
  }
}

function rejected(reason: string): ConsentResolution {
  return { status: 'rejected', reason };
}

/**
 * Record the user's answer to a consent question. Granted ONLY when a live,
 * pending record belonging to this thread + user is answered with exactly its
 * affirming option index; every other path grants nothing.
 *
 * Answered once: the answer is written with a compare-and-set on `status='pending'`
 * and then re-read, so a later resolution of the same id — a replayed click, a
 * retry — is rejected rather than re-granting. Two requests that race with the SAME
 * index converge on the one outcome that was actually recorded (only one write
 * lands); they cannot produce two different answers, and they gain no extra
 * authority, because AUTHORITY is arbitrated per call by {@link spendGrant}, which
 * is single-use even against itself.
 *
 * `scope` is REQUIRED rather than optional: an id is a bearer token, and the
 * thread/owner it was minted for is what stops one conversation (or one member of
 * a shared cloud workspace) spending another's consent.
 */
export async function resolveConsent(
  db: Lattice,
  id: string,
  optionIndex: number,
  scope: ConsentScope,
): Promise<ConsentResolution> {
  const record = await loadConsent(db, id);
  if (!record) return rejected('no such consent record');
  if (record.status !== 'pending') return rejected(`this question was already ${record.status}`);
  if (record.threadId !== scope.threadId) return rejected('belongs to another conversation');
  if ((record.ownerUserId ?? null) !== (scope.ownerUserId ?? null)) {
    return rejected('belongs to another user');
  }
  const now = new Date();
  if (isConsentExpired(record, now)) {
    await markExpired(db, id, now);
    return rejected('the question expired before it was answered');
  }

  // GRANTED requires the affirming option, exactly. EVERYTHING ELSE that reaches a
  // live record of this user's own conversation is a DECLINE.
  //
  // An out-of-range index used to be `rejected` instead — "not one of the options the
  // user was shown" — and that sentence was true but the conclusion was wrong. The
  // client attaches the open question's id to EVERY send, with index -1 whenever the
  // user typed a reply or sent files rather than clicking, and its own comment says
  // that explicitly declines. Server-side the -1 was rejected, so the record never
  // became `declined`, the gate saw "never asked" instead of "asked and said no", and
  // the plan the user had just refused in words RAN. Measured on one fixture with
  // only the option index differing: a clicked no left the records intact; a typed no
  // left them empty.
  //
  // `rejected` is kept for what it actually means — an answer that cannot be
  // attributed to this record AT ALL (unknown id, another conversation, another user,
  // already answered, expired). Those are decided above. Past that point the user
  // really did respond to this question, and anything other than the affirming click
  // is a no. Reading it that way can only ever CLOSE the gate: `spendGrant` refuses
  // any record that is not `granted`.
  const affirmed =
    Number.isInteger(optionIndex) &&
    optionIndex >= 0 &&
    optionIndex < Math.max(record.optionCount, 0) &&
    optionIndex === record.affirmIndex;
  const status: 'granted' | 'declined' = affirmed ? 'granted' : 'declined';
  // The column is an INTEGER; a non-integer index is recorded as the sentinel rather
  // than written through, so the stored answer always round-trips through decodeRow.
  const storedIndex = Number.isInteger(optionIndex) ? Math.trunc(optionIndex) : -1;
  try {
    await runAsyncOrSync(
      db.adapter,
      `UPDATE "${CONSENT_TABLE}"
          SET "status" = ?, "answered_at" = ?, "answer_index" = ?
        WHERE "id" = ? AND "status" = 'pending'`,
      [status, now.toISOString(), storedIndex, id],
    );
  } catch (e) {
    console.warn(
      `[assistant] could not record consent answer for "${id}": ${(e as Error).message}`,
    );
    return rejected('the answer could not be recorded');
  }
  // Read back rather than trust the write: the adapter surface has no portable
  // row-count, and a CAS that silently matched nothing must not read as consent.
  const after = await loadConsent(db, id);
  if (after?.status !== status || after.answerIndex !== storedIndex) {
    return rejected('the answer could not be recorded');
  }
  return status === 'granted'
    ? { status, record: after }
    : {
        status,
        reason:
          storedIndex < 0
            ? 'the user replied without choosing the affirmative option'
            : 'the user chose an option that is not the affirmative one',
        record: after,
      };
}

/** Stamp a record expired. Best-effort bookkeeping — the read path already refuses it. */
async function markExpired(db: Lattice, id: string, at: Date): Promise<void> {
  try {
    await runAsyncOrSync(
      db.adapter,
      `UPDATE "${CONSENT_TABLE}" SET "status" = 'expired', "answered_at" = ?
        WHERE "id" = ? AND "status" = 'pending'`,
      [at.toISOString(), id],
    );
  } catch (e) {
    console.warn(`[assistant] could not expire consent "${id}": ${(e as Error).message}`);
  }
}

/**
 * Expire every still-pending consent record in a thread, optionally sparing the
 * one just minted. This is how an open destructive question stops being answerable
 * the moment the conversation moves on — the durable equivalent of the transcript
 * gate's "staleness" rule, and immune to the ways that rule can be side-stepped
 * (a files-only send that persists no user text, a message the rehydrator drops).
 *
 * Returns how many records it expired.
 *
 * ONE `UPDATE` covering every match, never a read-then-write loop: the sweep must
 * not be able to leave a record behind (an un-expired pending record stays
 * answerable, which is the fail-OPEN direction), and it must not read row bodies to
 * do its job. The count is a SQL aggregate over the same predicate.
 */
export async function expirePendingForThread(
  db: Lattice,
  threadId: string,
  exceptId?: string,
): Promise<number> {
  if (!threadId) return 0;
  const scope = exceptId
    ? {
        where: `"thread_id" = ? AND "status" = 'pending' AND "id" <> ?`,
        args: [threadId, exceptId],
      }
    : { where: `"thread_id" = ? AND "status" = 'pending'`, args: [threadId] };
  try {
    await ensureConsentTable(db.adapter);
    const row = await getAsyncOrSync(
      db.adapter,
      `SELECT COUNT(*) AS n FROM "${CONSENT_TABLE}" WHERE ${scope.where}`,
      scope.args,
    );
    await runAsyncOrSync(
      db.adapter,
      `UPDATE "${CONSENT_TABLE}" SET "status" = 'expired', "answered_at" = ? WHERE ${scope.where}`,
      [new Date().toISOString(), ...scope.args],
    );
    return sqlCount((row as unknown as { n?: unknown } | undefined)?.n);
  } catch (e) {
    console.warn(
      `[assistant] could not expire pending consent for thread "${threadId}": ${(e as Error).message}`,
    );
    return 0;
  }
}

/**
 * How many answered consent records one thread's refusal history reads. Bounded, and
 * ordered newest-first so the cap can only ever drop the OLDEST answers — which the
 * newer ones already override.
 */
const REFUSAL_SCAN_LIMIT = 200;

/**
 * How many still-open cards one send may sweep. One is the norm (a turn may only mint
 * one, and every send sweeps), so this is a bound on a pathological store, not a
 * working limit.
 */
const PENDING_SCAN_LIMIT = 50;

/**
 * Answer every still-open card in this thread with a NO, because the user's next
 * message arrived without one.
 *
 * The typed-decline path — "a reply that is not the affirming click is a refusal" —
 * only ran when the CLIENT attached the open card's id to the send. That id is
 * ephemeral in-memory state in the browser: a page reload, a stream reconnect, or a
 * client that simply loses it between rendering the card and the next message all
 * drop it. The record then stayed `pending`, the staleness sweep stamped it `expired`,
 * and the gate read "never asked" instead of "asked and said no" — so the plan the
 * user had just walked away from was runnable again on the next turn.
 *
 * So the store answers the question itself: it knows which cards are live for this
 * thread and this user without being told. A message that reaches here carrying no
 * affirmative answer IS the answer — the same reading the client's own `-1` index
 * already meant, now independent of the client remembering to send it.
 *
 * EXPIRED records are left to the sweep rather than declined: expiry means nobody
 * answered in time, which grants nothing either way, and turning it into a durable
 * refusal would let an abandoned tab bind an object the user never actually refused.
 *
 * Returns the records that really became `declined`, newest last. Never throws: an
 * unreadable store declines nothing, and the record stays `pending` for the sweep.
 */
export async function declinePendingForThread(
  db: Lattice,
  scope: ConsentScope,
): Promise<ConsentRecord[]> {
  const out: ConsentRecord[] = [];
  if (!scope.threadId) return out;
  try {
    await ensureConsentTable(db.adapter);
    const rows = (await allAsyncOrSync(
      db.adapter,
      `SELECT "id" FROM "${CONSENT_TABLE}"
        WHERE "thread_id" = ?
          AND ${scope.ownerUserId == null ? '"owner_user_id" IS NULL' : '"owner_user_id" = ?'}
          AND "status" = 'pending'
        ORDER BY "created_at" ASC, "id" ASC
        LIMIT ${String(PENDING_SCAN_LIMIT)}`,
      scope.ownerUserId == null ? [scope.threadId] : [scope.threadId, scope.ownerUserId],
    )) as unknown as { id?: unknown }[];
    for (const row of rows) {
      const id = text(row.id);
      if (!id) continue;
      // -1 is the same sentinel a typed reply carries: an answer that is not the
      // affirming click. Routed through resolveConsent so it takes exactly the same
      // compare-and-set, read-back and scope checks as a clicked answer — there is no
      // second way to write an answer into this table.
      const resolution = await resolveConsent(db, id, -1, scope);
      if (resolution.status === 'declined' && resolution.record) out.push(resolution.record);
    }
  } catch (e) {
    console.warn(
      `[assistant] could not close open confirmations for thread "${scope.threadId}": ${(e as Error).message}`,
    );
  }
  return out;
}

/**
 * ONE act, as the refusal history keys it: the object, the tool, and the verb.
 *
 * The same triple the gate compares a grant on, so "what the user answered about" and
 * "what this call does" are the same identity in both directions. The separator is a
 * unit separator, which cannot occur in a table name, a tool name or a `verbKey`.
 */
export function consentActKey(target: string, tool: string, verb: string): string {
  return `${target}␟${tool}␟${verb}`;
}

/** What a conversation's answered consent records say about what it may still do. */
export interface ThreadRefusals {
  /**
   * Objects carrying a STANDING refusal: some act on them was refused and has not
   * since been re-approved. The gate refuses ANY act on these at any size.
   */
  targets: ReadonlySet<string>;
  /**
   * Acts ({@link consentActKey}) whose LATEST answer in this conversation was yes.
   * These are the exception to the line above: the user really was asked about this
   * exact act and really did say yes, so a standing refusal about a DIFFERENT act on
   * the same object must not block it.
   */
  grantedActs: ReadonlySet<string>;
}

/**
 * What this conversation has refused, and what it has since re-approved.
 *
 * The gate's rule — a plan the user REFUSED is gated at any size, because chipping
 * away at it one small call at a time is the same plan — was enforced from a single
 * record: the one the CURRENT request answered. The client only sends a question id
 * on the turn that answers it, so a refusal lasted exactly one turn. Measured: turn 2
 * clicked no and the gate held; turn 3 said "ok then" and the identical plan ran and
 * destroyed the records, while the stored record still read `declined`.
 *
 * So the refusal is read from the STORE instead of from the request. The rule used to
 * be "last answer per TARGET wins", and that was too coarse in the one direction that
 * matters: a later yes about a SMALL act on an object silently revoked an earlier no
 * about a completely different and far larger one. Saying no to "delete Invoices and
 * everything pointing at it" and then yes to "delete this one invoice row" lifted the
 * refusal on the whole object.
 *
 * So the verdict is tracked per ACT (object + tool + verb). A refusal stands for the
 * object until the user is asked AGAIN about the act they refused; a yes lifts only
 * the act it actually answered. Both halves are needed: without the per-act yes, a
 * refusal would make the object unusable for the rest of the conversation (its own
 * kind of broken), and without the object-level standing refusal, the plan could be
 * chipped away by any act that had never been named.
 *
 * Scoped to the thread AND the owner, like every other read here. Never throws: an
 * unreadable store yields no refusals and no lifted acts, and the gate's other rules
 * (size, multi-target, an unspendable grant) still stand.
 */
export async function refusalsForThread(db: Lattice, scope: ConsentScope): Promise<ThreadRefusals> {
  const targets = new Set<string>();
  const grantedActs = new Set<string>();
  if (!scope.threadId) return { targets, grantedActs };
  try {
    await ensureConsentTable(db.adapter);
    const rows = (await allAsyncOrSync(
      db.adapter,
      `SELECT "status","grants_json","answered_at","created_at" FROM "${CONSENT_TABLE}"
        WHERE "thread_id" = ?
          AND ${scope.ownerUserId == null ? '"owner_user_id" IS NULL' : '"owner_user_id" = ?'}
          AND "status" IN ('granted','declined')
        ORDER BY "answered_at" DESC, "created_at" DESC, "id" DESC
        LIMIT ${String(REFUSAL_SCAN_LIMIT)}`,
      scope.ownerUserId == null ? [scope.threadId] : [scope.threadId, scope.ownerUserId],
    )) as unknown as Pick<ConsentRow, 'status' | 'grants_json' | 'answered_at' | 'created_at'>[];
    // Newest first, so the first verdict seen for an act is its latest one — as far as
    // the stored timestamps can tell. `id DESC` is only there to make the SQL ordering
    // total; it decides NOTHING, because an id tie is resolved by the fail-closed rule
    // below rather than by which random UUID happened to sort higher.
    const decided = new Map<string, { target: string; stamp: string; declined: boolean }>();
    for (const row of rows) {
      const status = decodeStatus(text(row.status));
      const grants = decodeGrants(text(row.grants_json));
      if (!status || !grants) continue;
      // What the store can actually order two answers by. Anything past this is a TIE,
      // not a later answer — see the tie rule below.
      const stamp = `${text(row.answered_at)}␟${text(row.created_at)}`;
      for (const g of grants) {
        const target = text(g.target);
        if (!target) continue;
        const act = consentActKey(target, text(g.tool), text(g.verbKey));
        const prev = decided.get(act);
        // Rows arrive newest-first, so a DIFFERENT stamp here is strictly older and
        // has been superseded.
        if (prev && prev.stamp !== stamp) continue;
        decided.set(act, {
          target,
          stamp,
          // THE TIE RULE, and it is fail-closed on purpose. Two answers to the same act
          // can land in the same millisecond, and the stored timestamps then cannot say
          // which came last. The ordering used to break that tie on `id DESC` — a
          // RANDOM UUID — so which answer counted as the latest was decided by a coin
          // flip, and a refusal could be lifted (or not) differently on two runs of the
          // identical conversation. When the store cannot tell, the refusal wins: a no
          // that might be the user's last word must not be discarded on a tiebreak.
          declined: (prev?.declined ?? false) || status === 'declined',
        });
      }
    }
    for (const [act, v] of decided) {
      if (v.declined) targets.add(v.target);
      else grantedActs.add(act);
    }
  } catch (e) {
    console.warn(
      `[assistant] could not read refusals for thread "${scope.threadId}": ${(e as Error).message}`,
    );
  }
  return { targets, grantedActs };
}

/**
 * Consume ONE grant on a granted record, durably. Returns true only when this call
 * is the one that marked it — false when the record is unknown, not granted,
 * expired, the index does not exist, the grant is already spent, or the write does
 * not land. A false is always "you do not have consent for this call".
 *
 * Durable rather than in-memory because the whole point is that a grant survives
 * exactly one use ACROSS turns, processes, and retries — an in-process flag is
 * lost on restart and invisible to a second worker.
 */
export async function spendGrant(
  db: Lattice,
  id: string,
  grantIndex: number,
  by: string,
): Promise<boolean> {
  const record = await loadConsent(db, id);
  if (!record) return false;
  if (record.status !== 'granted') return false;
  const now = new Date();
  if (isConsentExpired(record, now)) return false;
  if (!Number.isInteger(grantIndex) || grantIndex < 0 || grantIndex >= record.grants.length) {
    return false;
  }
  const grant = record.grants[grantIndex];
  if (!grant || isGrantSpent(grant)) return false;

  const stamp = now.toISOString();
  const spentBy = by || 'unknown';
  const next = record.grants.map((g, i) =>
    i === grantIndex ? { ...g, spentAt: stamp, spentBy } : g,
  );
  try {
    // Compare-and-set on the exact stored payload: if anything else spent a grant
    // between the read and this write, the WHERE matches nothing and the read-back
    // below refuses. Two calls can never both believe they spent the same grant.
    await runAsyncOrSync(
      db.adapter,
      `UPDATE "${CONSENT_TABLE}" SET "grants_json" = ?
        WHERE "id" = ? AND "status" = 'granted' AND "grants_json" = ?`,
      [encodeGrants(next), id, encodeGrants(record.grants)],
    );
  } catch (e) {
    console.warn(`[assistant] could not spend consent grant on "${id}": ${(e as Error).message}`);
    return false;
  }
  const after = await loadConsent(db, id);
  const spent = after?.grants[grantIndex];
  return spent?.spentAt === stamp && spent.spentBy === spentBy;
}
