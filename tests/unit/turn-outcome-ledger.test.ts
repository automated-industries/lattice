import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import {
  executeFunction,
  TurnOutcomeLedger,
  DESTRUCTIVE_ROW_THRESHOLD,
  type DispatchCtx,
} from '../../src/gui/ai/dispatch.js';
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
    // A REAL config on disk, with the junction's two relations declared. A
    // `delete_cascade` destroys in OTHER objects too, and the classifier counts that
    // collateral from the workspace's declared relations — with no config there is no
    // relation model to read, which fails CLOSED (an uncountable cascade, gated at any
    // size). The server always supplies one; so does this.
    const configPath = join(tmpDir, 'lattice.config.yml');
    const outputDir = join(tmpDir, 'context');
    const entity = (name: string, extra: string[] = []): string[] => [
      `  ${name}:`,
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      owner: { type: text }',
      '      deleted_at: { type: text }',
      ...extra,
      `    outputFile: ${name}.md`,
    ];
    writeFileSync(
      configPath,
      [
        'db: ./test.db',
        '',
        'entities:',
        ...entity('contacts'),
        ...entity('deals'),
        ...entity('customers'),
        ...entity('customer_invoices'),
        '  contacts_deals:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      contact_id: { type: uuid }',
        '      deal_id: { type: uuid }',
        '    relations:',
        '      contact: { type: belongsTo, table: contacts, foreignKey: contact_id }',
        '      deal: { type: belongsTo, table: deals, foreignKey: deal_id }',
        '    outputFile: contacts_deals.md',
        '',
      ].join('\n'),
    );
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
      configPath,
      outputDir,
      deleteEntity: (name) => Promise.resolve(deleteOutcome(name)),
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A fresh ledger. There is no other kind: it carries no authorization state, because
   * a wide or multi-object removal is not something the assistant can be authorized to
   * do. The constructor used to take a consent record and a thread's refusal history.
   */
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
    // Refused means refused: the rows are untouched.
    expect(await db.countActive('deals')).toBe(2);
  });

  /**
   * ── There is nothing to approve ──────────────────────────────────────────────
   *
   * The suites that used to sit here tested the two mechanisms that made a wide
   * removal runnable: first a word matcher over the transcript, then a server-minted
   * consent record with spendable grants. Both are gone.
   *
   * What replaced them is not a better matcher. It is the removal of the capability:
   * seven adversarial review rounds each found a way to forge, widen, replay or
   * outlive an approval, and most rounds' fixes opened new holes while closing others.
   * A person still does every one of these operations in the app, where the
   * confirmation is a real action on a real screen. So the property under test
   * collapses from "does the approval match?" to "no approval exists" — which is both
   * stronger and much easier to state.
   */
  it('refuses a multi-object plan no matter what the turn does before or after', async () => {
    const ledger = ledgerFor();
    await executeFunction(
      ctx,
      'delete_entity',
      { name: 'contacts', resolution: 'delete_data' },
      ledger,
    );
    // Ten attempts, every resolution, in both orders. None of them lands.
    for (let i = 0; i < 5; i++) {
      for (const resolution of ['delete_data', 'delete_cascade']) {
        const r = await executeFunction(
          ctx,
          'delete_entity',
          { name: 'deals', resolution },
          ledger,
        );
        expect(r.ok).toBe(false);
        expect(r.error).toContain('REFUSED');
      }
    }
    expect(await db.countActive('deals')).toBe(2);
  });

  it('never emits a consent or approval card — reversible proceeds, irreversible refuses, neither asks', async () => {
    // The property the removed consent system kept failing: no card, no grant, no
    // approval state anywhere. A reversible act just runs and returns a plain outcome;
    // an irreversible one is refused with text that explicitly forbids asking to approve.
    const rows = DESTRUCTIVE_ROW_THRESHOLD + 5;
    for (let i = 0; i < rows; i++) {
      await db.insert('deals', { id: `k${String(i)}`, name: `Deal ${String(i)}`, owner: 'u1' });
    }
    const reversible = await executeFunction(
      ctx,
      'bulk_update',
      { table: 'deals', set: { owner: null } },
      ledgerFor(),
    );
    expect(reversible.ok).toBe(true);
    // The result is a plain outcome — no field a forged/widened approval could live in.
    const keys = Object.keys(reversible as Record<string, unknown>).join(' ');
    expect(keys).not.toMatch(/consent|approv|confirm|card|grant/i);

    // The irreversible arm refuses, and the refusal tells the model there is no approval
    // to seek — never a card to fill in.
    const led = ledgerFor();
    await executeFunction(
      ctx,
      'delete_entity',
      { name: 'contacts', resolution: 'delete_data' },
      led,
    );
    const refused = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'deals', resolution: 'delete_data' },
      led,
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('REFUSED');
    expect(refused.error).not.toMatch(/call ask_user/i);
    expect(refused.error).toMatch(/do not ask them to confirm or approve/i);
    expect(refused.error).toMatch(/no answer they\s+can give/i);
  });

  it('has no constructor argument that could open the gate', async () => {
    // The shape of the old bypasses was always "hand the ledger a state that means
    // yes". There is no such state to hand it: the only way to build one is with no
    // arguments at all, and the gate never reads anything but the call's own size.
    expect(TurnOutcomeLedger.length).toBe(0);

    const ledger = new TurnOutcomeLedger();
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

  it('does not treat a user asking ABOUT objects as permission to destroy them', async () => {
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

  it('runs a wide reversible clear without any authorization, because undo is the safety net', async () => {
    // A wide clear is reversible — the prior value is kept in the audit image and the undo
    // restores it — so it simply proceeds. There is no authorization involved and nothing
    // to refuse: the safety net is undo, not a permission the request could imply.
    const rows = DESTRUCTIVE_ROW_THRESHOLD + 5;
    for (let i = 0; i < rows; i++) {
      await db.insert('deals', { id: `bulk${String(i)}`, name: `Deal ${String(i)}`, owner: 'u1' });
    }
    const ledger = ledgerFor();
    const r = await executeFunction(
      ctx,
      'bulk_update',
      { table: 'deals', set: { owner: null } },
      ledger,
    );
    expect(r.ok).toBe(true);
    expect(r.error ?? '').not.toContain('REFUSED');
    // Every record really was cleared — the `rows` just inserted, plus the two deals the
    // fixture seeds (this unfiltered clear covers every record in the object).
    const cleared = (await db.query('deals', { filters: [{ col: 'owner', op: 'isNull' }] })).length;
    expect(cleared).toBe(rows + 2);
  });

  it('still lets a small single-object removal through', async () => {
    // The gate is a size, not a ban. Deleting one record from one object is the work
    // the assistant exists to do, and it is recorded in version history like any other
    // change.
    const ledger = ledgerFor();
    const r = await executeFunction(ctx, 'delete_row', { table: 'contacts', id: 'c1' }, ledger);
    expect(r.ok).toBe(true);
    expect(await db.countActive('contacts')).toBe(2);
  });
});
