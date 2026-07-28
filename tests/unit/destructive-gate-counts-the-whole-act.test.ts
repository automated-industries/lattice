import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig, type ActiveDb } from '../../src/gui/server.js';
import { aiDeleteEntity } from '../../src/gui/schema-ops.js';
import {
  destructiveIntent,
  executeFunction,
  TurnOutcomeLedger,
  DESTRUCTIVE_ROW_THRESHOLD,
  type DispatchCtx,
} from '../../src/gui/ai/dispatch.js';

/**
 * THE SIZE THE GATE REASONS ABOUT HAS TO BE THE SIZE OF THE ACT.
 *
 * The destructive gate refuses a call that removes from more than one object, or that
 * reaches more records across the turn than DESTRUCTIVE_ROW_THRESHOLD. That refusal is
 * only as good as the number it compares, and every defect below is the same shape:
 * the measured size was smaller than the number of records the call would really
 * destroy, so the call slipped under the threshold — and the sentence the user reads
 * about it, composed from the same classification, understated it too.
 *
 *  1. `unlink` was hardcoded to `rows: 1` while `db.unlink` is an UNBOUNDED set
 *     delete (`DELETE FROM t WHERE <every key of values>`). One call can cut every
 *     link a record has.
 *  2. `unlink`'s `values` KEYS went straight into a SQL identifier position with
 *     nothing checking them against the junction's real columns — the third instance
 *     of a class already closed for `bulk_update`'s filter and its `set` keys.
 *  3. `delete_entity` with `resolution='delete_cascade'` counted only the records in
 *     the object NAMED. The cascade removes the rows of every object pointing at it
 *     as well, and all of that escaped the count.
 *  4. The extra column overwrites a `clear` carries alongside it were invisible: the
 *     user read "clear notes" for a call that also rewrote their owner.
 *
 * Every assertion is on the DATA — rows really gone, or really still there — or on the
 * exact sentence the user is shown. A count comparing correctly is what each of these
 * defects already did.
 */

const dirs: string[] = [];
let live: ActiveDb | null = null;

afterEach(() => {
  if (live) {
    live.db.close();
    live = null;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A REAL workspace: `contacts`, `deals`, the `contacts_deals` junction between them,
 * `customers`, and `orders` as a first-class child of `customers`. Opened through
 * `openConfig` so the relation model, the junction classification and `aiDeleteEntity`
 * are the production ones — the cascade count is read out of exactly the model the
 * executor walks.
 */
async function boot(): Promise<ActiveDb> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-wholeact-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  contacts:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      owner: { type: text }',
      '      body: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: contacts.md',
      '  deals:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: deals.md',
      '  contacts_deals:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      contact_id: { type: uuid }',
      '      deal_id: { type: uuid }',
      '    relations:',
      '      contact: { type: belongsTo, table: contacts, foreignKey: contact_id }',
      '      deal: { type: belongsTo, table: deals, foreignKey: deal_id }',
      '    outputFile: contacts_deals.md',
      '  customers:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: customers.md',
      '  orders:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      label: { type: text }',
      '      customer_id: { type: uuid }',
      '      deleted_at: { type: text }',
      '    relations:',
      '      customer: { type: belongsTo, table: customers, foreignKey: customer_id }',
      '    outputFile: orders.md',
      '',
    ].join('\n'),
    'utf8',
  );
  const active = await openConfig(configPath, join(root, 'context'), false);
  await active.converged;
  live = active;
  return active;
}

function ctxFor(active: ActiveDb): DispatchCtx {
  return {
    db: active.db,
    feed: active.feed,
    validTables: active.validTables,
    junctionTables: active.junctionTables,
    softDeletable: active.softDeletable,
    configPath: active.configPath,
    outputDir: active.outputDir,
    // The REAL table-delete primitive, so a cascade that gets through really removes
    // the rows in the objects that point at the one being deleted.
    deleteEntity: (name, resolution) => aiDeleteEntity(active, name, resolution, 'sess'),
  };
}

/** Every physical row of a junction — it is HARD-deleted, so nothing is soft-hidden. */
async function junctionCount(active: ActiveDb): Promise<number> {
  return (await active.db.query('contacts_deals', {})).length;
}

/** Live (not soft-deleted) rows of a table. */
async function liveCount(active: ActiveDb, table: string): Promise<number> {
  return (await active.db.query(table, { filters: [{ col: 'deleted_at', op: 'isNull' }] })).length;
}

/** One contact with `n` links, plus one unrelated link that must survive. */
async function seedLinks(active: ActiveDb, n: number): Promise<void> {
  await active.db.insert('contacts', { id: 'c1', name: 'Hub' });
  await active.db.insert('contacts', { id: 'c2', name: 'Other' });
  for (let i = 0; i < n; i++) {
    await active.db.insert('deals', { id: `d${String(i)}`, name: `Deal ${String(i)}` });
    await active.db.insert('contacts_deals', {
      id: `j${String(i)}`,
      contact_id: 'c1',
      deal_id: `d${String(i)}`,
    });
  }
  await active.db.insert('contacts_deals', { id: 'jx', contact_id: 'c2', deal_id: 'd0' });
}

describe('the destructive gate counts what the call actually destroys', () => {
  // ── 1. unlink is a SET delete, not one row ─────────────────────────────────

  it('refuses an unlink that would cut more links than the threshold, and cuts none of them', async () => {
    const active = await boot();
    // One over the line — the smallest unlink the gate has to refuse. Sized from the
    // constant so this stays ON the far side of the boundary wherever it is moved to.
    const links = DESTRUCTIVE_ROW_THRESHOLD + 1;
    await seedLinks(active, links);
    const ctx = ctxFor(active);

    // One condition, every one of those rows. `db.unlink` emits
    // `DELETE FROM "contacts_deals" WHERE "contact_id" = ?` — every link this contact
    // has, in one statement, while the gate believed it was removing one.
    const r = await executeFunction(
      ctx,
      'unlink',
      { table: 'contacts_deals', values: { contact_id: 'c1' } },
      new TurnOutcomeLedger(),
    );
    // THE assertion, on the data: every link is still there — c1's, plus the unrelated
    // one belonging to c2. The set is over the threshold, so it is refused outright,
    // and only a real count of what the statement will delete knows that.
    expect(await junctionCount(active)).toBe(links + 1);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('REFUSED');
  });

  // Deliberately UNDER the line: this one is about the sentence, not the gate. What is
  // measured is that the count in the text is the size of the set the DELETE will cut.
  it('tells the user how many links an unlink really cuts', async () => {
    const active = await boot();
    await seedLinks(active, 40);
    const ctx = ctxFor(active);
    const intent = await destructiveIntent(ctx, 'unlink', {
      table: 'contacts_deals',
      values: { contact_id: 'c1' },
    });
    // "remove 1 link from ..." was the sentence on the card for all forty of them.
    expect(intent?.detail).toContain('40 link(s)');
    expect(intent?.detail).toContain('EVERY link matching this one');
  });

  it('still lets through a single-link unlink the user never has to be asked about', async () => {
    // The count is a binding, not a blanket refusal of unlinking: cutting ONE link is
    // one record and stays under the threshold.
    const active = await boot();
    await seedLinks(active, 3);
    const ctx = ctxFor(active);
    const r = await executeFunction(
      ctx,
      'unlink',
      { table: 'contacts_deals', values: { contact_id: 'c1', deal_id: 'd1' } },
      new TurnOutcomeLedger(),
    );
    expect(r.ok).toBe(true);
    expect(await junctionCount(active)).toBe(3); // 4 − the one edge named
  });

  // ── 2. unlink's keys are validated before they reach an identifier position ──

  it('refuses an unlink whose values name something that is not a column', async () => {
    const active = await boot();
    await seedLinks(active, 40);
    const ctx = ctxFor(active);

    // The key lands in `DELETE FROM "contacts_deals" WHERE "<key>" = ?`. Closed, it
    // reads `WHERE "contact_id" = "contact_id" OR "deal_id" = ?` — every row in the
    // junction, including the one belonging to a completely different contact.
    const injected = 'contact_id" = "contact_id" OR "deal_id';
    const r = await executeFunction(
      ctx,
      'unlink',
      { table: 'contacts_deals', values: { [injected]: 'nothing' } },
      new TurnOutcomeLedger(),
    );
    // THE assertion: every link, including c2's, is still there.
    expect(await junctionCount(active)).toBe(41);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('values references unknown column');

    // ...and the Object.prototype names, which `in` answered yes to for every table.
    for (const key of ['constructor', 'hasOwnProperty', 'toString']) {
      const bad = await executeFunction(
        ctx,
        'unlink',
        { table: 'contacts_deals', values: { [key]: 'x' } },
        new TurnOutcomeLedger(),
      );
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain('values references unknown column');
    }
    expect(await junctionCount(active)).toBe(41);
  });

  // ── 3. a cascade destroys outside the object it names ──────────────────────

  it('counts the cascade’s collateral, so a small object with many dependants is gated', async () => {
    const active = await boot();
    await active.db.insert('customers', { id: 'cu1', name: 'Acme' });
    // Far more records point AT the object than are in it. The object holds ONE row, so
    // counted the old way this act measures 1 and is nowhere near the line; counted
    // properly it is one over it, and every record of the excess is collateral outside
    // the object the call names.
    const dependants = DESTRUCTIVE_ROW_THRESHOLD;
    for (let i = 0; i < dependants; i++) {
      await active.db.insert('orders', {
        id: `o${String(i)}`,
        label: `Order ${String(i)}`,
        customer_id: 'cu1',
      });
    }
    const ctx = ctxFor(active);

    const r = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'customers', resolution: 'delete_cascade' },
      new TurnOutcomeLedger(),
    );
    // THE assertion, on the data: every order is still there. `aiDeleteEntity` is the
    // real primitive here, so a gate that waved this through would have removed them.
    expect(await liveCount(active, 'orders')).toBe(dependants);
    expect(await liveCount(active, 'customers')).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('REFUSED');
  });

  // Deliberately UNDER the line: about the sentence and the counted total, not the gate.
  it('tells the user how many records outside the object a cascade destroys', async () => {
    const active = await boot();
    await active.db.insert('customers', { id: 'cu1', name: 'Acme' });
    for (let i = 0; i < 40; i++) {
      await active.db.insert('orders', {
        id: `o${String(i)}`,
        label: `Order ${String(i)}`,
        customer_id: 'cu1',
      });
    }
    const intent = await destructiveIntent(ctxFor(active), 'delete_entity', {
      name: 'customers',
      resolution: 'delete_cascade',
    });
    // 1 record in the object + 40 that point at it. The sentence read "remove
    // Customers (1 record)" for an act that destroyed forty-one.
    expect(intent?.rows).toBe(41);
    expect(intent?.detail).toContain('up to 40 record(s) in other objects');
  });

  it('still removes a small object whose cascade is small — the count is a bound, not a ban', async () => {
    // The collateral count exists to make a WIDE cascade visible, not to stop cascades.
    // Two orders + one customer is three records, well under the threshold, and it
    // goes through untouched.
    const active = await boot();
    await active.db.insert('customers', { id: 'cu1', name: 'Acme' });
    await active.db.insert('orders', { id: 'o1', label: 'a', customer_id: 'cu1' });
    await active.db.insert('orders', { id: 'o2', label: 'b', customer_id: 'cu1' });
    const ctx = ctxFor(active);
    const r = await executeFunction(
      ctx,
      'delete_entity',
      { name: 'customers', resolution: 'delete_cascade' },
      new TurnOutcomeLedger(),
    );
    expect(r.ok).toBe(true);
    expect(await liveCount(active, 'orders')).toBe(0);
  });

  it('gates a cascade whose collateral cannot be counted at all', async () => {
    // The count is the only thing that says how big a cascade is. An uncountable one
    // must read as WIDE, never as "just the object's own rows".
    const active = await boot();
    await active.db.insert('customers', { id: 'cu1', name: 'Acme' });
    await active.db.insert('orders', { id: 'o1', label: 'x', customer_id: 'cu1' });
    const ctx = ctxFor(active);
    const real = active.db.boundedCount.bind(active.db);
    (active.db as unknown as { boundedCount: unknown }).boundedCount = (
      table: string,
      opts: unknown,
    ) => (table === 'orders' ? Promise.reject(new Error('count exploded')) : real(table, opts));
    try {
      const intent = await destructiveIntent(ctx, 'delete_entity', {
        name: 'customers',
        resolution: 'delete_cascade',
      });
      expect(intent?.rowsUnknown).toBe(true);
      const r = await executeFunction(
        ctx,
        'delete_entity',
        { name: 'customers', resolution: 'delete_cascade' },
        new TurnOutcomeLedger(),
      );
      expect(r.ok).toBe(false);
      expect(r.error).toContain('REFUSED');
    } finally {
      (active.db as unknown as { boundedCount: unknown }).boundedCount = real;
    }
    expect(await liveCount(active, 'orders')).toBe(1);
  });

  // ── 4. what a clear ALSO overwrites is named, not silently carried ─────────

  it('names the extra overwrites, so the refusal is not silent about them', async () => {
    const active = await boot();
    await active.db.insert('contacts', { id: 'c1', name: 'x', owner: 'u1', body: 'keep me' });
    const ctx = ctxFor(active);
    const intent = await destructiveIntent(ctx, 'bulk_update', {
      table: 'contacts',
      set: { body: null, owner: 'attacker' },
    });
    expect(intent?.detail).toContain('clear "body"');
    expect(intent?.detail).toContain('OVERWRITE "owner"');
    // A model-supplied name that is not a column of this table never reaches the
    // sentence the user reads.
    const injected = await destructiveIntent(ctx, 'bulk_update', {
      table: 'contacts',
      set: { body: null, 'x" — SAFE, nothing real is lost': 'v' },
    });
    expect(injected?.detail).not.toContain('nothing real is lost');
  });

  // ── 5. the wide act is refused, and stays refused for the whole turn ────────

  it('keeps refusing a wide clear however many times the turn retries it', async () => {
    const active = await boot();
    for (let i = 0; i < DESTRUCTIVE_ROW_THRESHOLD + 5; i++) {
      await active.db.insert('contacts', {
        id: `c${String(i)}`,
        name: `Contact ${String(i)}`,
        owner: 'u1',
        body: 'keep me',
      });
    }
    const ctx = ctxFor(active);
    const ledger = new TurnOutcomeLedger();
    const wide = { table: 'contacts', set: { body: null } };
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await executeFunction(ctx, 'bulk_update', wide, ledger);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('REFUSED');
    }
    // THE assertion, on the data: every record still holds its text.
    const rows = await active.db.query('contacts', {});
    expect(rows.every((r) => r.body === 'keep me')).toBe(true);
  });

  it('counts single-row clears across the turn, so a wide plan cannot be split under the line', async () => {
    // The gate measures the TURN, not the call. One single-row clear per record is the
    // same destruction as one bulk_update over all of them, and it must hit the same
    // wall. The calls are real and separate on purpose: accumulating across the turn IS
    // the code path under test, so there is no cheaper construction that still
    // exercises it.
    const active = await boot();
    const rows = DESTRUCTIVE_ROW_THRESHOLD + 5;
    for (let i = 0; i < rows; i++) {
      await active.db.insert('contacts', {
        id: `c${String(i)}`,
        name: `Contact ${String(i)}`,
        owner: 'u1',
        body: 'keep me',
      });
    }
    const ctx = ctxFor(active);
    const ledger = new TurnOutcomeLedger();
    let refusedAt = -1;
    for (let i = 0; i < rows; i++) {
      const r = await executeFunction(
        ctx,
        'update_row',
        { table: 'contacts', id: `c${String(i)}`, values: { body: null } },
        ledger,
      );
      if (!r.ok && r.error?.includes('REFUSED')) {
        refusedAt = i;
        break;
      }
    }
    expect(refusedAt).toBeGreaterThan(-1);
    const wiped = (await active.db.query('contacts', { filters: [{ col: 'body', op: 'isNull' }] }))
      .length;
    expect(wiped).toBeLessThanOrEqual(DESTRUCTIVE_ROW_THRESHOLD + 1);
  });

  it('refuses the moment a second object joins the plan, however small both are', async () => {
    // Two one-record removals. Each is far under the threshold on its own; together
    // they span two objects, which is the other half of the gate.
    const active = await boot();
    await active.db.insert('contacts', { id: 'c1', name: 'Hub' });
    await active.db.insert('deals', { id: 'd1', name: 'Deal' });
    const ctx = ctxFor(active);
    const ledger = new TurnOutcomeLedger();

    const first = await executeFunction(ctx, 'delete_row', { table: 'contacts', id: 'c1' }, ledger);
    expect(first.ok).toBe(true);

    const second = await executeFunction(ctx, 'delete_row', { table: 'deals', id: 'd1' }, ledger);
    expect(second.ok).toBe(false);
    expect(second.error).toContain('REFUSED');
    expect(second.error).toContain('more than one object');
    // The deal is still there.
    expect((await active.db.get('deals', 'd1'))?.deleted_at ?? null).toBeNull();
  });
});
