import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { getAsyncOrSync } from '../../src/db/adapter.js';
import {
  CONSENT_TABLE,
  ensureConsentTable,
  mintConsent,
  loadConsent,
  resolveConsent,
  expirePendingForThread,
  spendGrant,
  isGrantSpent,
  MemberCannotConsent,
  MEMBER_CANNOT_CONSENT,
  type ConsentGrant,
} from '../../src/gui/ai/consent-store.js';
import { verbKey } from '../../src/gui/ai/dispatch.js';

/**
 * DURABLE CONSENT — the server's own record of what the user agreed to.
 *
 * The mechanism it replaces reconstructed consent every turn by re-reading the LLM
 * transcript: the question came from a replayed `ask_user` block and the answer from
 * the text of the user's message. Both halves are text the MODEL authored or can
 * steer, so the evidence that unlocked a destructive call could be manufactured by
 * the thing being gated. These tests hold the replacement to the properties that
 * make that impossible: consent is a row THIS process wrote, it is single-use, it is
 * scoped to one conversation and one user, it expires, and it carries no
 * model-authored text at all.
 *
 * Every assertion below is about the FAIL-CLOSED direction — the store is allowed to
 * withhold consent it could have granted; it is never allowed to grant consent it
 * cannot prove.
 */
describe('ai consent store', () => {
  let tmpDir: string;
  let db: Lattice;

  /** A grant as the pre-flight classifier produces it — every field server-derived. */
  const grantFor = (target: string, tool = 'delete_entity'): ConsentGrant => ({
    tool,
    kind: 'remove_object',
    target,
    verbKey: verbKey(tool, { resolution: 'delete_data' }),
    maxRows: 42,
    rowsUnknown: false,
    detail: `remove "${target}" (42 record(s))`,
  });

  const mint = (over: Partial<Parameters<typeof mintConsent>[1]> = {}) =>
    mintConsent(db, {
      threadId: 'thread-1',
      ownerUserId: 'user-1',
      askedMsgId: 'msg-9',
      grants: [grantFor('customers')],
      affirmIndex: 0,
      optionCount: 2,
      ttlMs: 10 * 60_000,
      ...over,
    });

  const scope = { threadId: 'thread-1', ownerUserId: 'user-1' };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-consent-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    db.define('customers', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'customers.md',
    });
    await db.init();
    await ensureConsentTable(db.adapter);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is invisible to the assistant — it is not a registered table', () => {
    // Raw DDL, never `define`/`defineLate`: the consent ledger must not be listable,
    // readable, or writable through any assistant tool, and must never be rendered.
    // A prefix filter regressing somewhere cannot expose what was never registered.
    expect(db.getRegisteredTableNames()).not.toContain(CONSENT_TABLE);
  });

  it('grants only when the affirming option is the one that came back', async () => {
    const id = await mint();
    const loaded = await loadConsent(db, id);
    expect(loaded?.status).toBe('pending');
    expect(loaded?.grants).toHaveLength(1);
    expect(loaded?.grants[0]?.target).toBe('customers');

    const yes = await resolveConsent(db, id, 0, scope);
    expect(yes.status).toBe('granted');
    expect(yes.record?.answerIndex).toBe(0);
    expect((await loadConsent(db, id))?.status).toBe('granted');

    // A different record, answered with any other option, is a decline — not a
    // "maybe" the caller could round up.
    const other = await mint();
    const no = await resolveConsent(db, other, 1, scope);
    expect(no.status).toBe('declined');
    expect((await loadConsent(db, other))?.status).toBe('declined');
  });

  it('is single-use — the same consent cannot be resolved twice', async () => {
    const id = await mint();
    expect((await resolveConsent(db, id, 0, scope)).status).toBe('granted');
    // A replayed click, a retry, a second worker: all refused, none re-granting.
    const again = await resolveConsent(db, id, 0, scope);
    expect(again.status).toBe('rejected');
    expect(again.reason).toContain('already');
    const flipped = await resolveConsent(db, id, 1, scope);
    expect(flipped.status).toBe('rejected');
  });

  it('refuses an id that is not this conversation’s, or not this user’s', async () => {
    const wrongThread = await resolveConsent(db, await mint(), 0, {
      threadId: 'thread-2',
      ownerUserId: 'user-1',
    });
    expect(wrongThread.status).toBe('rejected');
    expect(wrongThread.reason).toContain('another conversation');

    const wrongOwner = await resolveConsent(db, await mint(), 0, {
      threadId: 'thread-1',
      ownerUserId: 'user-2',
    });
    expect(wrongOwner.status).toBe('rejected');
    expect(wrongOwner.reason).toContain('another user');

    // An anonymous answer is not the owner's answer either.
    const noOwner = await resolveConsent(db, await mint(), 0, { threadId: 'thread-1' });
    expect(noOwner.status).toBe('rejected');
  });

  it('refuses an unknown id, an expired one, and an answer that was never an option', async () => {
    expect((await resolveConsent(db, 'not-a-real-id', 0, scope)).status).toBe('rejected');

    const stale = await mint({ ttlMs: -1000 }); // born expired
    const expired = await resolveConsent(db, stale, 0, scope);
    expect(expired.status).toBe('rejected');
    expect(expired.reason).toContain('expired');
    // And it is stamped, so it can never be answered later either.
    expect((await loadConsent(db, stale))?.status).toBe('expired');

    const live = await mint({ optionCount: 2 });
    for (const bad of [-1, 2, 99, 1.5, Number.NaN]) {
      expect((await resolveConsent(db, live, bad, scope)).status, `index ${String(bad)}`).toBe(
        'rejected',
      );
    }
  });

  it('spends exactly one grant, exactly once', async () => {
    const id = await mint({ grants: [grantFor('customers'), grantFor('orders')] });
    expect((await resolveConsent(db, id, 0, scope)).status).toBe('granted');

    expect(await spendGrant(db, id, 0, 'call-1')).toBe(true);
    const after = await loadConsent(db, id);
    expect(isGrantSpent(after!.grants[0]!)).toBe(true);
    expect(after?.grants[0]?.spentBy).toBe('call-1');
    // Exactly one: the sibling grant is untouched.
    expect(isGrantSpent(after!.grants[1]!)).toBe(false);

    // Never twice — not by a retry, not by a different caller.
    expect(await spendGrant(db, id, 0, 'call-1')).toBe(false);
    expect(await spendGrant(db, id, 0, 'call-2')).toBe(false);
    // The other grant is still spendable exactly once.
    expect(await spendGrant(db, id, 1, 'call-3')).toBe(true);
    expect(await spendGrant(db, id, 1, 'call-4')).toBe(false);
  });

  it('never spends a grant on a record that was not granted', async () => {
    const pending = await mint();
    expect(await spendGrant(db, pending, 0, 'call-1')).toBe(false);

    const declined = await mint();
    await resolveConsent(db, declined, 1, scope);
    expect(await spendGrant(db, declined, 0, 'call-1')).toBe(false);

    const granted = await mint();
    await resolveConsent(db, granted, 0, scope);
    expect(await spendGrant(db, granted, 9, 'call-1')).toBe(false); // no such grant
    expect(await spendGrant(db, 'not-a-real-id', 0, 'call-1')).toBe(false);
  });

  it('closes every other open question in the thread when a new one is asked', async () => {
    const first = await mint();
    const second = await mint();
    const otherThread = await mint({ threadId: 'thread-2' });
    const current = await mint();

    const closed = await expirePendingForThread(db, 'thread-1', current);
    expect(closed).toBe(2);
    expect((await loadConsent(db, first))?.status).toBe('expired');
    expect((await loadConsent(db, second))?.status).toBe('expired');
    // The question just asked stays answerable; another conversation is untouched.
    expect((await loadConsent(db, current))?.status).toBe('pending');
    expect((await loadConsent(db, otherThread))?.status).toBe('pending');

    // An expired record grants nothing, whatever comes back for it later.
    expect((await resolveConsent(db, first, 0, scope)).status).toBe('rejected');
  });

  /**
   * THE SHAPE TEST — a consent grant must be unable to CARRY model-authored text.
   *
   * Both live forgeries work by getting model-written prose into the evidence: the
   * option blob the model authors is matched for destructive verbs and object names,
   * and a model-chosen dashboard title is injected into a bracketed server note that
   * the user-text stripper then mis-parses. A grant that has nowhere to put a
   * sentence is immune to that entire class by construction, so the property under
   * test is structural: only these fields exist, and only server-derived values ever
   * reach the row.
   *
   * Written as a loop over a sentinel array so that a field added later fails this
   * test by default rather than passing unexamined.
   */
  it('cannot carry model-authored text — every persisted field is server-derived', async () => {
    /** Unique strings standing in for each channel of model-authored prose. */
    const MODEL_AUTHORED = [
      'SENTINEL_QUESTION_TEXT_A1', // the ask_user question the model wrote
      'SENTINEL_OPTION_LABEL_A2', // an option label the model wrote (the option-blob bleed)
      'SENTINEL_DASHBOARD_TITLE_A3', // a title the model chose (the context-note injection)
      'SENTINEL_ASSISTANT_PROSE_A4', // the model's own narration
      'SENTINEL_USER_MESSAGE_A5', // the raw user message text
      'SENTINEL_FREEFORM_NOTE_A6', // any "explanation" a future caller might attach
    ];

    /** Exactly the fields a grant may have. A new one must be justified HERE first. */
    const ALLOWED_FIELDS = [
      'detail',
      'kind',
      'maxRows',
      'rowsUnknown',
      'spentAt',
      'spentBy',
      'target',
      'tool',
      'verbKey',
    ];

    // Every server-derived field populated, plus every sentinel pushed in through the
    // channel a careless caller would use: extra properties on the grant object.
    const smuggled = Object.fromEntries(MODEL_AUTHORED.map((s, i) => [`extra_${String(i)}`, s]));
    const grant = {
      ...grantFor('customers'),
      ...smuggled,
      question: MODEL_AUTHORED[0],
      optionLabel: MODEL_AUTHORED[1],
      title: MODEL_AUTHORED[2],
      note: MODEL_AUTHORED[5],
    } as unknown as ConsentGrant;

    const id = await mintConsent(db, {
      threadId: 'thread-1',
      ownerUserId: 'user-1',
      grants: [grant],
      affirmIndex: 0,
      optionCount: 2,
      ttlMs: 60_000,
    });
    await resolveConsent(db, id, 0, scope);
    await spendGrant(db, id, 0, 'call-1');

    const row = await getAsyncOrSync(
      db.adapter,
      `SELECT * FROM "${CONSENT_TABLE}" WHERE "id" = ?`,
      [id],
    );
    const persisted = JSON.stringify(row);
    for (const sentinel of MODEL_AUTHORED) {
      expect(persisted, `model-authored text reached the consent row: ${sentinel}`).not.toContain(
        sentinel,
      );
    }

    // And the row really does carry the grant — the sentinels are absent because the
    // fields were dropped, not because nothing was written.
    const loaded = await loadConsent(db, id);
    expect(loaded?.grants).toHaveLength(1);
    expect(loaded?.grants[0]?.target).toBe('customers');
    // The grant was minted, resolved AND spent above, so every field it may ever
    // carry is populated here: a field added to ConsentGrant later shows up in this
    // list and fails the comparison until someone adds it to ALLOWED_FIELDS — which
    // is the moment to ask whether it can carry model-authored text.
    expect(Object.keys(loaded!.grants[0]!).sort()).toEqual([...ALLOWED_FIELDS].sort());
  });

  describe('verbKey — what the call DOES to its target', () => {
    it('separates removing an object from removing everything in it', () => {
      // The exact confusion that let "yes, remove the object but keep the data"
      // authorize a cascade: same tool, same target, one argument apart.
      expect(verbKey('delete_entity', { resolution: 'delete_data' })).toBe(
        'resolution:delete_data',
      );
      expect(verbKey('delete_entity', { resolution: 'delete_cascade' })).toBe(
        'resolution:delete_cascade',
      );
      expect(verbKey('delete_entity', { resolution: 'delete_data' })).not.toBe(
        verbKey('delete_entity', { resolution: 'delete_cascade' }),
      );
      // Anything that is not one of the two destroying resolutions is 'none'.
      expect(verbKey('delete_entity', {})).toBe('resolution:none');
      expect(verbKey('delete_entity', { resolution: 'whatever' })).toBe('resolution:none');
    });

    it('separates a permanent delete from a recoverable one', () => {
      expect(verbKey('delete_row', { hard: true })).toBe('hard:true');
      expect(verbKey('delete_row', { hard: false })).toBe('hard:false');
      expect(verbKey('delete_row', {})).toBe('hard:false');
    });

    it('keys a clear by WHICH columns it empties, in a stable order', () => {
      expect(verbKey('bulk_update', { set: { owner: null, notes: '' } })).toBe('clear:notes,owner');
      // Argument order must not change the key…
      expect(verbKey('bulk_update', { set: { notes: '', owner: null } })).toBe('clear:notes,owner');
      // …but clearing a different column is a different act.
      expect(verbKey('bulk_update', { set: { owner: null } })).not.toBe(
        verbKey('bulk_update', { set: { notes: null } }),
      );
      // Setting a real value clears nothing.
      expect(verbKey('bulk_update', { set: { owner: 'u2' } })).toBe('clear:');
    });

    it('is empty for tools whose destruction has no shape-changing argument', () => {
      for (const tool of ['unlink', 'merge_rows', 'dedup']) {
        expect(verbKey(tool, { table: 'customers' })).toBe('');
      }
    });
  });

  /**
   * A cloud MEMBER cannot hold consent. This is a decision, not an accident of
   * privileges — on a shared workspace an irreversible removal spanning thousands of
   * rows belongs to the owner, and a member being able to self-authorize it is the
   * thing being ruled out.
   *
   * What is asserted here is that the refusal is LEGIBLE. The sibling
   * clarification-question store has the same shape, is likewise ungranted to
   * members, and its failure is swallowed client-side — so for a member it silently
   * does nothing. That is the worse of the two failures: the user cannot tell a
   * policy from a bug, so they retry, and nobody learns anything. A member must get a
   * sentence that names who can do this instead.
   */
  describe('a cloud member is refused, and told why', () => {
    it('mintConsent throws a member refusal carrying the user-facing sentence', async () => {
      // The one thing that distinguishes the connection; everything else is identical.
      const memberDb = Object.create(db) as Lattice & { isCloudMemberOpen: () => boolean };
      memberDb.isCloudMemberOpen = () => true;

      await expect(
        mintConsent(memberDb, {
          threadId: 't-member',
          grants: [grantFor('customers')],
          affirmIndex: 0,
          optionCount: 2,
          ttlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(MemberCannotConsent);

      // It names the owner as the route forward rather than reporting a bare failure.
      expect(MEMBER_CANNOT_CONSENT).toMatch(/owner/i);
      expect(MEMBER_CANNOT_CONSENT).toMatch(/nothing was changed/i);

      // ...and nothing was written: a refused mint must not leave a pending record
      // that some later turn could answer.
      const rows = await db.query(CONSENT_TABLE, { filters: [] }).catch(() => []);
      expect(rows.filter((r) => (r as { thread_id?: string }).thread_id === 't-member')).toEqual(
        [],
      );
    });
  });
});
