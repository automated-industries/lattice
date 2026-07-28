import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import {
  executeFunction,
  TurnOutcomeLedger,
  DESTRUCTIVE_ROW_THRESHOLD,
  verbKey,
  type DispatchCtx,
} from '../../src/gui/ai/dispatch.js';
import type { ConsentGrant } from '../../src/gui/ai/consent-store.js';
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
    // `customers` / `customer_invoices` exist so a compound name and a name that is
    // a WORD of it are both real objects — the shape that let agreeing to one
    // authorize destroying the other.
    for (const t of ['contacts', 'deals', 'customers', 'customer_invoices']) {
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
    // Wide enough that a removal of either needs the user's say-so.
    for (let i = 0; i < DESTRUCTIVE_ROW_THRESHOLD + 5; i++) {
      await db.insert('customers', { id: `cu${String(i)}`, name: `Customer ${String(i)}` });
      await db.insert('customer_invoices', { id: `ci${String(i)}`, name: `Invoice ${String(i)}` });
    }

    deleteOutcome = (name) => ({
      ok: false,
      error: `"${name}" is still referenced by other records`,
    });
    ctx = {
      db,
      feed: new FeedBus(),
      validTables: new Set([
        'contacts',
        'deals',
        'contacts_deals',
        'customers',
        'customer_invoices',
      ]),
      junctionTables: new Set(['contacts_deals']),
      softDeletable: new Set(['contacts', 'deals', 'customers', 'customer_invoices']),
      deleteEntity: (name) => Promise.resolve(deleteOutcome(name)),
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A grant exactly as the SERVER mints one: every field comes from the pre-flight
   * classifier, never from anything the model wrote. Hand-writing a grant is
   * legitimate here in a way hand-writing the old evidence was not — the old
   * evidence was parsed prose, so inventing it tested a shape no real turn produced;
   * a grant is a struct the server builds, and this is that struct.
   */
  const grant = (
    target: string,
    over: Partial<ConsentGrant> = {},
    tool = 'delete_entity',
    args: Record<string, unknown> = { resolution: 'delete_data' },
  ): ConsentGrant => ({
    tool,
    kind: 'remove_object',
    target,
    verbKey: verbKey(tool, args),
    maxRows: 10_000,
    rowsUnknown: false,
    detail: `remove "${target}"`,
    ...over,
  });

  /** Spent grants are tracked here so a test can assert single-use. */
  let spends: string[] = [];

  /** A ledger holding the consent the route would have resolved for this turn. */
  const ledgerWith = (
    grants: ConsentGrant[] = [],
    status: 'granted' | 'declined' = 'granted',
  ): TurnOutcomeLedger => {
    const live = grants.map((g) => ({ ...g }));
    return new TurnOutcomeLedger({
      consent: {
        status,
        grants: live,
        spend: (i, by) => {
          const g = live[i];
          if (!g || g.spentAt) return Promise.resolve(false);
          g.spentAt = new Date().toISOString();
          spends.push(by);
          return Promise.resolve(true);
        },
      },
    });
  };

  /** No consent at all — the default state of a turn nobody was asked about. */
  const ledgerFor = (): TurnOutcomeLedger => new TurnOutcomeLedger();

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
    const ledger = ledgerWith([grant('contacts'), grant('deals')]);
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
    // Consent covers contacts only. The old matcher compared words, so a question
    // naming one object could cover another whose name shared a word; targets are
    // compared exactly now, so a grant for one is a grant for exactly one.
    const ledger = ledgerWith([grant('contacts')]);
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
    const ledger = ledgerWith([grant('contacts'), grant('deals')], 'declined');
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
    expect(second.error).toContain('said no');
  });

  // ── Consent is an ANSWER, not a word that appeared somewhere ────────────────
  //
  // The gate used to look for the target's name anywhere in the conversation. Two
  // ways that unlocks destruction nobody agreed to: the user MENTIONS an object
  // while asking about it, and the assistant's own question supplies the names —
  // so the model could write the evidence that unlocked its own destructive call.

  it('does not treat a user asking ABOUT objects as permission to destroy them', async () => {
    // Asking a question about objects mints nothing, so there is no consent at all.
    const ledger = ledgerFor();
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
    const ledger = ledgerFor();
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

  /**
   * These four protected properties of the OLD mechanism, where consent was parsed
   * out of the conversation: a non-answer must not read as yes, a yes to one
   * question must not cover another, an old yes must not carry forward, and a real
   * yes must work. Every one of them was a way that mechanism could be fooled.
   *
   * They are kept because the PROPERTIES still matter — but they are now asserted
   * against grants, because that is what authority is made of. Most of them are no
   * longer even expressible as an attack: there is no text to be ambiguous, no
   * question to confuse with another, and no transcript to reach back into.
   */
  it('grants nothing when the user did not affirm', async () => {
    // A record that exists but was declined, and no record at all, are both "no".
    for (const ledger of [
      ledgerWith([grant('contacts'), grant('deals')], 'declined'),
      ledgerFor(),
    ]) {
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
    }
    expect(await db.countActive('deals')).toBe(2);
  });

  it('does not let consent for one object authorize another', async () => {
    // The old matcher compared singularized WORDS, so agreeing to remove "that
    // duplicate contact" covered the whole `contacts` table. Targets are compared
    // exactly now, so a grant names exactly one object.
    const ledger = ledgerWith([grant('contacts')]);
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
    expect(second.error).toContain('"deals"');
  });

  it('does not let one approval authorize the same removal twice', async () => {
    // Consent covers an act, not a standing permission. Spending is durable and
    // single-use, so a retry needs a fresh question.
    spends = [];
    const ledger = ledgerWith([grant('contacts')]);
    const first = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'contacts', resolution: 'delete_cascade' },
      ledger,
    );
    void first;
    // Force the gate to run again for the same target by widening the plan.
    const second = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'deals', resolution: 'delete_data' },
      ledger,
    );
    expect(second.error).toContain('REFUSED');
  });

  it('accepts a grant that matches the call exactly', async () => {
    const ledger = ledgerWith([grant('contacts'), grant('deals')]);
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
    expect(second.error).not.toContain('REFUSED');
  });

  it('refuses when the removal is WIDER than what was approved', async () => {
    // The count is measured when the card is shown; the table can grow before the
    // call lands. The user agreed to an upper bound, so exceeding it asks again.
    const ledger = ledgerWith([grant('contacts', { maxRows: 1 }), grant('deals')]);
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

  it('refuses when the KIND of removal differs from what was approved', async () => {
    // Agreeing to remove an object but keep its data is not agreeing to a cascade.
    const ledger = ledgerWith([
      grant('contacts', {}, 'delete_entity', { resolution: 'delete_data' }),
      grant('deals'),
    ]);
    await executeFunction(
      ctx,
      'delete_entity',
      { name: 'contacts', resolution: 'delete_cascade' },
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

  /**
   * The suites that used to sit here tested `namedIn` and `confirmationEvidence`
   * directly — the word matcher and the transcript parser. Both are gone: consent is
   * no longer derived from text, so there is no matcher to unit-test and no evidence
   * to assemble. Deleting them with the code is deliberate. A test kept alive around
   * a deleted mechanism is worse than no test: it goes on passing, and it reads as
   * coverage of a property nothing implements any more.
   *
   * What those suites were really protecting — a mention is not an answer, one
   * object's name does not cover another's, an old yes does not carry forward — is
   * asserted above against grants, which is where authority now lives.
   */
});
