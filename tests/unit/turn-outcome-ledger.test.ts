import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import {
  executeFunction,
  TurnOutcomeLedger,
  CLAIM_VERIFIERS,
  DESTRUCTIVE_ROW_THRESHOLD,
  namedIn,
  type DispatchCtx,
} from '../../src/gui/ai/dispatch.js';
import { confirmationEvidence, type LlmMessage } from '../../src/gui/ai/chat.js';
import type { DeleteEntityOutcome } from '../../src/gui/schema-ops.js';

/**
 * The per-turn outcome ledger: ONE claim-verification mechanism the answer is
 * measured against, with the destructive pre-flight gate layered on top.
 *
 * The bug it exists for: a turn ran a series of FAILED deletes, unlinked 40 rows
 * on the way, and finished with "Done. Your model is now relinked and clean."
 * Nothing had been deleted and the links were gone — the workspace ended up
 * strictly worse than it started, and the answer said the opposite.
 */

describe('turn outcome ledger', () => {
  let tmpDir: string;
  let db: Lattice;
  let ctx: DispatchCtx;
  /** Stands in for the real table-delete primitive; scripted to fail like the session did. */
  let deleteOutcome: (name: string) => DeleteEntityOutcome;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-ledger-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    for (const t of ['contacts', 'deals']) {
      db.define(t, {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', owner: 'TEXT', deleted_at: 'TEXT' },
        render: () => '',
        outputFile: `${t}.md`,
      });
    }
    db.define('contacts_deals', {
      columns: { id: 'TEXT PRIMARY KEY', contact_id: 'TEXT', deal_id: 'TEXT' },
      render: () => '',
      outputFile: 'contacts_deals.md',
    });
    // Every assistant write is audited + undoable; the audit table is what makes
    // the undo offer in the ledger's notice a real one.
    db.define('_lattice_gui_audit', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        ts: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        table_name: 'TEXT NOT NULL',
        row_id: 'TEXT',
        operation: 'TEXT NOT NULL',
        before_json: 'TEXT',
        after_json: 'TEXT',
        undone: 'INTEGER NOT NULL DEFAULT 0',
      },
      render: () => '',
      outputFile: '.lattice-gui/audit.md',
    });
    await db.init();
    for (const id of ['c1', 'c2', 'c3']) {
      await db.insert('contacts', { id, name: `Contact ${id}`, owner: 'u1' });
    }
    for (const id of ['d1', 'd2'])
      await db.insert('deals', { id, name: `Deal ${id}`, owner: 'u1' });

    deleteOutcome = (name) => ({
      ok: false,
      error: `"${name}" is still referenced by other records`,
    });
    ctx = {
      db,
      feed: new FeedBus(),
      validTables: new Set(['contacts', 'deals', 'contacts_deals']),
      junctionTables: new Set(['contacts_deals']),
      softDeletable: new Set(['contacts', 'deals']),
      deleteEntity: (name) => Promise.resolve(deleteOutcome(name)),
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A ledger whose consent evidence is assembled exactly the way the chat loop
   * assembles it — from the question the assistant actually asked and the reply the
   * user actually gave. Hand-building the evidence would test a shape no real turn
   * produces, which is how a mention got mistaken for an answer in the first place.
   */
  const ledgerFor = (userMessage = '', history: LlmMessage[] = []): TurnOutcomeLedger =>
    new TurnOutcomeLedger({ evidence: confirmationEvidence(history, userMessage) });

  /** The prior round's question, replayed into this turn's history as the loop replays it. */
  const questionAsked = (question: string, options = ['Yes', 'No']): LlmMessage[] => [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'q1', name: 'ask_user', input: { question, options } }],
    },
  ];

  it('stays silent on a clean turn — nothing to reconcile, nothing to warn about', async () => {
    const ledger = ledgerFor();
    const r = await executeFunction(
      ctx,
      'create_row',
      { table: 'contacts', values: { id: 'c4', name: 'New' } },
      ledger,
    );
    expect(r.ok).toBe(true);
    expect(ledger.counts).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(ledger.reconciliation()).toBeNull();
    expect(ledger.userNotice()).toBeNull();
  });

  it('records a mixed round — some calls ok, some failed — and still reports the failures', async () => {
    const ledger = ledgerFor();
    await executeFunction(
      ctx,
      'update_row',
      { table: 'contacts', id: 'c1', values: { name: 'Renamed' } },
      ledger,
    );
    await executeFunction(
      ctx,
      'delete_entity',
      { name: 'contacts', resolution: 'delete_data' },
      ledger,
    );

    expect(ledger.counts).toEqual({ attempted: 2, succeeded: 1, failed: 1 });
    const record = ledger.reconciliation();
    expect(record).not.toBeNull();
    expect(record).toContain('DID NOT HAPPEN');
    expect(record).toContain('"contacts" was NOT removed');
    expect(record).toContain('still referenced by other records');
    // The success in the same round must not launder the failure away.
    expect(record).toContain('2 attempted, 1 succeeded, 1 failed');
    expect(ledger.userNotice()).toContain('Contacts could not be removed');
  });

  it('surfaces a half-applied plan: the links removed to enable a delete that then failed', async () => {
    const ledger = ledgerFor();
    // The damage from the real session: rows unlinked to make a deletion possible.
    const cleared = await executeFunction(
      ctx,
      'bulk_update',
      { table: 'contacts', set: { owner: null } },
      ledger,
    );
    expect(cleared.ok).toBe(true);
    const removed = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'contacts', resolution: 'delete_data' },
      ledger,
    );
    expect(removed.ok).toBe(false);

    const record = ledger.reconciliation();
    expect(record).toContain('ALREADY CHANGED AND STILL APPLIED');
    expect(record).toContain('3 record(s)');
    expect(record).toContain('half-changed');
    expect(record).toMatch(/never call this turn done, clean, simplified/i);

    const notice = ledger.userNotice();
    expect(notice).toContain('3 record(s) in Contacts');
    expect(notice).toContain('still in place');
    expect(notice).toContain('undo');
    // Business terms only — no internal vocabulary in what the user is shown.
    expect(notice).not.toMatch(/\btable\b|\bcolumn\b|\bjunction\b|bulk_update|delete_entity/i);
  });

  it('refuses a multi-target destructive plan and names the exact targets and row counts', async () => {
    const ledger = ledgerFor();
    const first = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'contacts', resolution: 'delete_data' },
      ledger,
    );
    // The first target is allowed through (it is not yet a multi-target plan);
    // it fails on its own merits, exactly like the reported session.
    expect(first.error).toContain('still referenced');

    const second = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'deals', resolution: 'delete_data' },
      ledger,
    );
    expect(second.ok).toBe(false);
    expect(second.error).toContain('REFUSED');
    expect(second.error).toContain('nothing was changed by this call');
    expect(second.error).toContain('"deals" (2 record(s))');
    expect(second.error).toContain('"contacts" (3 record(s))');
    expect(second.error).toContain('ask_user');
    // Refused means refused: the rows are untouched.
    expect(await db.countActive('deals')).toBe(2);
  });

  it('lets the same plan through once the user has been asked about every target', async () => {
    const ledger = ledgerFor(
      'Yes, remove both',
      questionAsked('Remove Contacts (3 records) and Deals (2 records)?', [
        'Yes, remove both',
        'No, keep them',
      ]),
    );
    await executeFunction(
      ctx,
      'delete_entity',
      { name: 'contacts', resolution: 'delete_data' },
      ledger,
    );
    const second = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'deals', resolution: 'delete_data' },
      ledger,
    );
    // Reaches the real primitive (which fails for its own reason), not the gate.
    expect(second.error).toContain('still referenced');
    expect(second.error).not.toContain('REFUSED');
  });

  it('keeps the gate closed when the confirmation only named some of the targets', async () => {
    const ledger = ledgerFor('Yes', questionAsked('Remove Contacts (3 records)?'));
    await executeFunction(
      ctx,
      'delete_entity',
      { name: 'contacts', resolution: 'delete_data' },
      ledger,
    );
    const second = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'deals', resolution: 'delete_data' },
      ledger,
    );
    expect(second.error).toContain('REFUSED');
  });

  it('keeps the gate closed when the user just said no', async () => {
    const ledger = ledgerFor(
      'No, keep them',
      questionAsked('Remove Contacts (3 records) and Deals (2 records)?', [
        'Yes, remove both',
        'No, keep them',
      ]),
    );
    await executeFunction(
      ctx,
      'delete_entity',
      { name: 'contacts', resolution: 'delete_data' },
      ledger,
    );
    const second = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'deals', resolution: 'delete_data' },
      ledger,
    );
    expect(second.error).toContain('REFUSED');
    expect(second.error).toContain('reads as a refusal');
  });

  // ── Consent is an ANSWER, not a word that appeared somewhere ────────────────
  //
  // The gate used to look for the target's name anywhere in the conversation. Two
  // ways that unlocks destruction nobody agreed to: the user MENTIONS an object
  // while asking about it, and the assistant's own question supplies the names —
  // so the model could write the evidence that unlocked its own destructive call.

  it('does not treat a user asking ABOUT objects as permission to destroy them', async () => {
    const ledger = ledgerFor('what is in contacts and deals?');
    await executeFunction(
      ctx,
      'delete_entity',
      { name: 'contacts', resolution: 'delete_data' },
      ledger,
    );
    const second = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'deals', resolution: 'delete_data' },
      ledger,
    );
    expect(second.error).toContain('REFUSED');
    expect(await db.countActive('deals')).toBe(2);
  });

  it('does not let a mention in the request authorize a wide clear of that object', async () => {
    for (let i = 0; i < DESTRUCTIVE_ROW_THRESHOLD + 5; i++) {
      await db.insert('deals', { id: `bulk${String(i)}`, name: `Deal ${String(i)}`, owner: 'u1' });
    }
    const ledger = ledgerFor('how many deals have no owner yet?');
    const r = await executeFunction(
      ctx,
      'bulk_update',
      { table: 'deals', set: { owner: null } },
      ledger,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('REFUSED');
    // Asking a question about an object must never be what empties it.
    const cleared = (await db.query('deals', { filters: [{ col: 'owner', op: 'isNull' }] })).length;
    expect(cleared).toBe(0);
  });

  it('does not accept a non-answer to its own question as consent', async () => {
    const history = questionAsked('Remove Contacts (3 records) and Deals (2 records)?', [
      'Yes, remove both',
      'No, keep them',
    ]);
    // Silence, a change of subject, and an ambiguous reply are all NOT a yes.
    for (const reply of ['', 'Hmm.', 'What does that involve?', 'Also add a deal for Acme.']) {
      const ledger = ledgerFor(reply, history);
      await executeFunction(
        ctx,
        'delete_entity',
        { name: 'contacts', resolution: 'delete_data' },
        ledger,
      );
      const second = await executeFunction(
        ctx,
        'delete_entity',
        { name: 'deals', resolution: 'delete_data' },
        ledger,
      );
      expect(second.error, `reply: ${JSON.stringify(reply)}`).toContain('REFUSED');
      expect(second.error).toContain('not a clear yes');
    }
    expect(await db.countActive('deals')).toBe(2);
  });

  it('does not read a yes to some OTHER question as consent to destroy', async () => {
    // The question named both objects — but it asked about adding something, not
    // removing anything. A yes to that is not a yes to this.
    const ledger = ledgerFor(
      'Yes please',
      questionAsked('Add a Notes field to Contacts and Deals?'),
    );
    await executeFunction(
      ctx,
      'delete_entity',
      { name: 'contacts', resolution: 'delete_data' },
      ledger,
    );
    const second = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'deals', resolution: 'delete_data' },
      ledger,
    );
    expect(second.error).toContain('REFUSED');
    expect(await db.countActive('deals')).toBe(2);
  });

  it('stays closed for even a single small removal the user has already said no to', async () => {
    // Splitting a refused plan into one small call at a time is the same plan. A no
    // to "remove Contacts?" is a no to removing any of it, however little at a time.
    const ledger = ledgerFor('No, keep them', questionAsked('Remove Contacts (3 records)?'));
    const r = await executeFunction(ctx, 'delete_row', { table: 'contacts', id: 'c1' }, ledger);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('REFUSED');
    expect(r.error).toContain('reads as a refusal');
    expect(await db.countActive('contacts')).toBe(3);
  });

  it('still allows a small removal the user never said no to', async () => {
    // The refusal was about something else entirely — it must not freeze the turn.
    const ledger = ledgerFor('No, keep the deals', questionAsked('Remove Deals (2 records)?'));
    const r = await executeFunction(ctx, 'delete_row', { table: 'contacts', id: 'c1' }, ledger);
    expect(r.ok).toBe(true);
  });

  it('measures the plan by everything the turn has attempted, not only by what landed', async () => {
    // 22 records — under the unasked threshold once, over it twice. The removal
    // fails, so nothing is destroyed and the old per-call count never grew: the
    // model could re-attempt a wide removal forever without ever being asked.
    for (let i = 0; i < 20; i++) {
      await db.insert('deals', { id: `acc${String(i)}`, name: `Deal ${String(i)}`, owner: 'u1' });
    }
    const ledger = ledgerFor('tidy this up');
    const first = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'deals', resolution: 'delete_data' },
      ledger,
    );
    expect(first.error).toContain('still referenced');
    const second = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'deals', resolution: 'delete_data' },
      ledger,
    );
    expect(second.error).toContain('REFUSED');
    expect(second.error).toContain('44'); // 22 attempted, then 22 more
  });

  it('tells the user what was already changed when the turn is stopped part-way', async () => {
    const ledger = ledgerFor('disconnect these');
    const cleared = await executeFunction(
      ctx,
      'bulk_update',
      { table: 'contacts', set: { owner: null } },
      ledger,
    );
    expect(cleared.ok).toBe(true);
    // Mid-turn there is nothing to correct — the plan may still finish.
    expect(ledger.userNotice()).toBeNull();

    ledger.markStopped();
    const notice = ledger.userNotice();
    expect(notice).toContain('3 record(s) in Contacts');
    expect(notice).toContain('still in place');
    expect(notice).toContain('undo');
    expect(notice).not.toMatch(/\btable\b|\bcolumn\b|\bjunction\b|bulk_update|delete_entity/i);
  });

  it('refuses a single clear that is wider than the unasked threshold, with the real count', async () => {
    for (let i = 0; i < DESTRUCTIVE_ROW_THRESHOLD + 5; i++) {
      await db.insert('deals', { id: `bulk${String(i)}`, name: `Deal ${String(i)}`, owner: 'u1' });
    }
    const ledger = ledgerFor();
    const r = await executeFunction(
      ctx,
      'bulk_update',
      { table: 'deals', set: { owner: null } },
      ledger,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('REFUSED');
    expect(r.error).toContain(String(DESTRUCTIVE_ROW_THRESHOLD + 7)); // 2 seeded + 30 added
    expect(r.error).toContain('"owner"');
    // Nothing was cleared.
    const rows = (await db.query('deals', { filters: [{ col: 'owner', op: 'isNull' }] })).length;
    expect(rows).toBe(0);
  });

  it('does not gate ordinary edits, single small removals, or reversible merges', async () => {
    const ledger = ledgerFor();
    // A value-setting bulk edit is not destruction.
    const set = await executeFunction(
      ctx,
      'bulk_update',
      { table: 'contacts', set: { owner: 'u2' } },
      ledger,
    );
    expect(set.ok).toBe(true);
    // One row, one object.
    const del = await executeFunction(ctx, 'delete_row', { table: 'contacts', id: 'c1' }, ledger);
    expect(del.ok).toBe(true);
    // A merge is reversible by design and must not demand a confirmation round.
    deleteOutcome = (name) => ({ ok: true, deleted: name, movedRows: 2 });
    const merged = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'deals', move_to: 'contacts' },
      ledger,
    );
    expect(merged.ok).toBe(true);
    expect(ledger.reconciliation()).toBeNull();
  });

  it('leaves the pre-ledger call path exactly as it was (the gate is opt-in per turn)', async () => {
    // Control: the same multi-target plan with NO ledger — the behaviour this
    // change replaces. Both calls reach the primitive; nothing is refused, and
    // nothing is recorded to reconcile the answer against.
    const first = await executeFunction(ctx, 'delete_entity', {
      name: 'contacts',
      resolution: 'delete_data',
    });
    const second = await executeFunction(ctx, 'delete_entity', {
      name: 'deals',
      resolution: 'delete_data',
    });
    expect(first.error).toContain('still referenced');
    expect(second.error).toContain('still referenced');
    expect(second.error).not.toContain('REFUSED');
  });

  it('reconciles every axis through the one shared mechanism', () => {
    expect(CLAIM_VERIFIERS.map((v) => v.axis)).toEqual(['destructive', 'artifact', 'dashboard']);
    const ledger = ledgerFor();
    // Axis 2 — a document the answer would claim is "in your workspace".
    ledger.record(
      'create_artifact',
      { title: 'Quarterly Review', spec: 'a long report' },
      { ok: false, error: 'its text did not persist' },
    );
    // Axis 3 — a page of zeros reported as healthy.
    ledger.record(
      'create_dashboard',
      { title: 'Revenue', spec: 'revenue by month' },
      { ok: true, result: { id: 'd1', qaIssues: [{ kind: 'no_data' }, { kind: 'sql_error' }] } },
    );
    const record = ledger.reconciliation();
    expect(record).toContain('The document "Quarterly Review" was NOT saved');
    expect(record).toContain('HAPPENED BUT IS NOT A SUCCESS');
    expect(record).toContain('2 of its figures returned NO data');
    const notice = ledger.userNotice();
    expect(notice).toContain('"Quarterly Review" was not saved');
    expect(notice).toContain('will show as zero');
  });

  it('flags a delegated document that came back as a stub', () => {
    const ledger = ledgerFor();
    ledger.record(
      'create_artifact',
      { title: 'Big Report', spec: 'a comprehensive 20-page analysis' },
      { ok: true, result: { id: 'f1', chars: 12 } },
    );
    expect(ledger.reconciliation()).toContain('only 12 characters');
  });

  it('treats a delete that removed nothing as not-done, not as a success', () => {
    const ledger = ledgerFor();
    ledger.record(
      'delete_entity',
      { name: 'contacts' },
      { ok: true, result: { needsResolution: true, rowCount: 3, message: 'not empty' } },
    );
    expect(ledger.reconciliation()).toContain('"contacts" was NOT removed');
  });

  it('withholds only the "waiting on your answer" lines when the turn ends on a question', () => {
    const ledger = ledgerFor();
    ledger.record(
      'delete_entity',
      { name: 'contacts' },
      { ok: true, result: { needsResolution: true, rowCount: 3, message: 'not empty' } },
    );
    expect(ledger.userNotice({ askedUser: true })).toBeNull();
    expect(ledger.userNotice({ askedUser: false })).toContain('has not been removed');
  });

  describe('naming a target to the user', () => {
    it('matches the friendly names the assistant is required to use', () => {
      expect(namedIn('Remove Q3 Invoice Lines (12 records)?', 'q3_invoice_lines')).toBe(true);
      expect(namedIn('Delete the Contact list?', 'contacts')).toBe(true);
      expect(namedIn('Remove Deals?', 'contacts')).toBe(false);
      expect(namedIn('', 'contacts')).toBe(false);
    });
  });

  describe('confirmation evidence', () => {
    it('carries the last question the user was actually shown, and their answer to it', () => {
      const evidence = confirmationEvidence(
        [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'ask_user',
                input: { question: 'Remove Contacts and Deals?', options: ['Yes', 'No'] },
              },
            ],
          },
        ],
        'Yes',
      );
      expect(namedIn(evidence.question, 'contacts')).toBe(true);
      expect(namedIn(evidence.question, 'deals')).toBe(true);
      expect(evidence.affirmed).toBe(true);
      expect(evidence.declined).toBe(false);
    });

    it('keeps the user’s own words out of the question — a mention is not an answer', () => {
      const evidence = confirmationEvidence([], 'please delete contacts and deals');
      // Nothing was asked, so nothing is confirmed — however emphatic the request.
      expect(evidence.question).toBe('');
      expect(namedIn(evidence.question, 'contacts')).toBe(false);
    });

    it('never counts a server-authored context note as the user agreeing', () => {
      const evidence = confirmationEvidence(
        [],
        '[The user is currently viewing Contacts — "this" / "it" refers to it.]\n\nTidy this up',
      );
      expect(evidence.question).toBe('');
      expect(evidence.affirmed).toBe(false);
      // A note that happens to start with an agreeable word is still not the user.
      expect(confirmationEvidence([], '[Yes — viewing Contacts]\n\ntidy this up').affirmed).toBe(
        false,
      );
    });

    it('reads a refusal as a refusal, and only a yes as a yes', () => {
      expect(confirmationEvidence([], 'No, keep them').declined).toBe(true);
      expect(confirmationEvidence([], 'No, keep them').affirmed).toBe(false);
      expect(confirmationEvidence([], 'Yes, remove them').declined).toBe(false);
      expect(confirmationEvidence([], 'Yes, remove them').affirmed).toBe(true);
      expect(confirmationEvidence([], 'Go ahead').affirmed).toBe(true);
      // Ambiguity is not agreement.
      expect(confirmationEvidence([], 'Maybe later').affirmed).toBe(false);
      expect(confirmationEvidence([], '').affirmed).toBe(false);
      // A yes wrapped around a no is not a yes.
      expect(confirmationEvidence([], 'Yes to the first one\nno to the rest').affirmed).toBe(false);
    });
  });
});
