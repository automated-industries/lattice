import { randomUUID } from 'node:crypto';
import type { Lattice } from '../../lattice.js';
import type { StorageAdapter } from '../../db/adapter.js';
import { runAsyncOrSync, getAsyncOrSync } from '../../db/adapter.js';

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
  if (
    !Number.isInteger(optionIndex) ||
    optionIndex < 0 ||
    optionIndex >= Math.max(record.optionCount, 0)
  ) {
    return rejected('not one of the options the user was shown');
  }

  const status: 'granted' | 'declined' =
    optionIndex === record.affirmIndex ? 'granted' : 'declined';
  try {
    await runAsyncOrSync(
      db.adapter,
      `UPDATE "${CONSENT_TABLE}"
          SET "status" = ?, "answered_at" = ?, "answer_index" = ?
        WHERE "id" = ? AND "status" = 'pending'`,
      [status, now.toISOString(), optionIndex, id],
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
  if (after?.status !== status || after.answerIndex !== optionIndex) {
    return rejected('the answer could not be recorded');
  }
  return status === 'granted'
    ? { status, record: after }
    : { status, reason: 'the user chose an option that is not the affirmative one', record: after };
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
