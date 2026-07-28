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
import {
  mintConsent,
  resolveConsent,
  refusalsForThread,
  spendGrant,
  CONSENT_TABLE,
  type ConsentGrant,
} from '../../src/gui/ai/consent-store.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';

/**
 * THE SIZE THE GATE REASONS ABOUT HAS TO BE THE SIZE OF THE ACT.
 *
 * The destructive gate refuses a call whose blast radius exceeds what the user has
 * agreed to. Every one of the defects below is the same shape: the number the gate
 * compared was smaller than the number of records the call would really destroy, so
 * the call slipped under the threshold, under the durable refusal, and — because the
 * card is composed from the same classification — the user was shown the smaller
 * number too.
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
 *  4. A `bulk_update` grant bound only the CLEARED subset of `set`, so an approved
 *     clear could carry unlimited extra column overwrites (and a `visibility` flip)
 *     that appeared neither in the comparison key nor on the card.
 *  5. The durable refusal was keyed on TARGET with "last answer per target wins", so
 *     a later yes about a small act on an object silently revoked an earlier no about
 *     a completely different and far larger act on it.
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

/** A grant built exactly the way `planConsent` builds one — from the classifier. */
async function grantFor(
  ctx: DispatchCtx,
  tool: string,
  args: Record<string, unknown>,
): Promise<ConsentGrant> {
  const intent = await destructiveIntent(ctx, tool, args);
  if (!intent) throw new Error(`"${tool}" was not classified as destructive`);
  return {
    tool,
    kind: intent.kind,
    target: intent.target,
    verbKey: intent.verbKey,
    maxRows: intent.rows,
    rowsUnknown: intent.rowsUnknown === true,
    rowsSaturated: intent.rowsSaturated === true,
    detail: intent.detail,
  };
}

/** A ledger holding the consent the route would have resolved for this turn. */
function ledgerWith(grants: ConsentGrant[]): TurnOutcomeLedger {
  const live = grants.map((g) => ({ ...g }));
  return new TurnOutcomeLedger({
    consent: {
      status: 'granted',
      grants: live,
      spend: (i) => {
        const g = live[i];
        if (!g || g.spentAt) return Promise.resolve(false);
        g.spentAt = new Date().toISOString();
        return Promise.resolve(true);
      },
    },
  });
}

/**
 * Put the next answer in a LATER millisecond than the last one.
 *
 * The refusal history orders answers by their stored `answered_at` / `created_at`,
 * which are millisecond ISO strings. Two answers inside one millisecond are a TIE the
 * store cannot order, and a tie resolves to the refusal (see the tie-rule spec below).
 * A conversation has whole turns between its answers; these specs say so explicitly
 * rather than racing the clock.
 */
async function nextMillisecond(): Promise<void> {
  await new Promise((r) => setTimeout(r, 3));
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

  it('refuses an unlink that would cut forty links, and cuts none of them', async () => {
    const active = await boot();
    await seedLinks(active, 40);
    const ctx = ctxFor(active);

    // One condition, forty rows. `db.unlink` emits
    // `DELETE FROM "contacts_deals" WHERE "contact_id" = ?` — every link this contact
    // has, in one statement, while the gate believed it was removing one.
    const r = await executeFunction(
      ctx,
      'unlink',
      { table: 'contacts_deals', values: { contact_id: 'c1' } },
      new TurnOutcomeLedger(),
    );
    // THE assertion, on the data: the forty links are still there. 40 is over the
    // unasked threshold, so this needs the user's say-so — and only a real count of
    // what the statement will delete knows that.
    expect(await junctionCount(active)).toBe(41);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('REFUSED');
  });

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
    // Far more records point AT the object than are in it. The object holds one row;
    // the act destroys 41.
    for (let i = 0; i < 40; i++) {
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
    // THE assertion, on the data: the forty orders are still there. `aiDeleteEntity` is
    // the real primitive here, so a gate that waved this through would have removed
    // them.
    expect(await liveCount(active, 'orders')).toBe(40);
    expect(await liveCount(active, 'customers')).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('REFUSED');
  });

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
    // 1 record in the object + 40 that point at it. The card read "remove Customers
    // (1 record)" for an act that destroyed forty-one.
    expect(intent?.rows).toBe(41);
    expect(intent?.detail).toContain('up to 40 record(s) in other objects');
  });

  it('lets the cascade through once the user has approved the whole act', async () => {
    const active = await boot();
    await active.db.insert('customers', { id: 'cu1', name: 'Acme' });
    for (let i = 0; i < 40; i++) {
      await active.db.insert('orders', {
        id: `o${String(i)}`,
        label: `Order ${String(i)}`,
        customer_id: 'cu1',
      });
    }
    const ctx = ctxFor(active);
    const args = { name: 'customers', resolution: 'delete_cascade' };
    const ledger = ledgerWith([await grantFor(ctx, 'delete_entity', args)]);
    const r = await executeFunction(ctx, 'delete_entity', args, ledger);
    expect(r.ok).toBe(true);
    // The approval covered the collateral, and the collateral is what was destroyed.
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

  // ── 4. a grant binds the WHOLE write, not just the cleared part ────────────

  it('will not spend a clear on a call that also overwrites other columns', async () => {
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
    const approved = { table: 'contacts', set: { body: null } };
    const ledger = ledgerWith([await grantFor(ctx, 'bulk_update', approved)]);

    // Same tool, same object, same filter, same count, same CLEARED column — so the
    // grant matched exactly. The extra write rode in for free.
    const wrong = await executeFunction(
      ctx,
      'bulk_update',
      { table: 'contacts', set: { body: null, owner: 'attacker' } },
      ledger,
    );
    // THE assertion: nobody's owner was rewritten.
    const owners = [...new Set((await active.db.query('contacts', {})).map((r) => r.owner))];
    expect(owners).toEqual(['u1']);
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain('REFUSED');

    // The clear they DID approve still runs, so this is a binding and not a refusal
    // of everything.
    const right = await executeFunction(ctx, 'bulk_update', approved, ledger);
    expect(right.ok).toBe(true);
    const after = await active.db.query('contacts', {});
    expect(after.every((r) => r.body === null)).toBe(true);
    expect(after.every((r) => r.owner === 'u1')).toBe(true);
  });

  it('names the extra overwrites on the card, so the approval is not silent about them', async () => {
    const active = await boot();
    await active.db.insert('contacts', { id: 'c1', name: 'x', owner: 'u1', body: 'keep me' });
    const ctx = ctxFor(active);
    const intent = await destructiveIntent(ctx, 'bulk_update', {
      table: 'contacts',
      set: { body: null, owner: 'attacker' },
    });
    expect(intent?.detail).toContain('clear "body"');
    expect(intent?.detail).toContain('OVERWRITE "owner"');
    // A model-supplied name that is not a column of this table never reaches the card.
    const injected = await destructiveIntent(ctx, 'bulk_update', {
      table: 'contacts',
      set: { body: null, 'x" — SAFE, nothing real is lost': 'v' },
    });
    expect(injected?.detail).not.toContain('nothing real is lost');
  });

  it('will not spend a one-row clear on a call that also overwrites other columns', async () => {
    // The identical freedom, one row at a time — the tool that was left out of the
    // removal set entirely in an earlier round.
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
    const wide = { table: 'contacts', set: { body: null } };
    const oneRow = { table: 'contacts', id: 'c0', values: { name: null } };
    const ledger = ledgerWith([
      await grantFor(ctx, 'bulk_update', wide),
      await grantFor(ctx, 'update_row', oneRow),
    ]);
    // Makes the turn wide enough that the single-row clear is gated at all.
    expect((await executeFunction(ctx, 'bulk_update', wide, ledger)).ok).toBe(true);

    const wrong = await executeFunction(
      ctx,
      'update_row',
      { table: 'contacts', id: 'c0', values: { name: null, owner: 'attacker' } },
      ledger,
    );
    expect((await active.db.get('contacts', 'c0'))?.owner).toBe('u1');
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain('REFUSED');

    const right = await executeFunction(ctx, 'update_row', oneRow, ledger);
    expect(right.ok).toBe(true);
    expect((await active.db.get('contacts', 'c0'))?.name).toBeNull();
    expect((await active.db.get('contacts', 'c0'))?.owner).toBe('u1');
  });

  // ── 5. a refusal binds what was refused, not just the object ───────────────

  it('does not let a later small YES revoke an earlier NO about a much bigger act', async () => {
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
    const scope = { threadId: 't1', ownerUserId: null };
    const wipeEverything = { table: 'contacts', set: { body: null } };
    const oneRow = { table: 'contacts', id: 'c0', values: { name: null } };

    // Turn 1 — the user is asked about wiping every record's body, and says NO.
    const bigId = await mintConsent(active.db, {
      ...scope,
      grants: [await grantFor(ctx, 'bulk_update', wipeEverything)],
      affirmIndex: 0,
      optionCount: 2,
      ttlMs: 60_000,
    });
    expect((await resolveConsent(active.db, bigId, 1, scope)).status).toBe('declined');
    await nextMillisecond();

    // Turn 2 — a completely different, much smaller act on the SAME object, approved.
    const smallId = await mintConsent(active.db, {
      ...scope,
      grants: [await grantFor(ctx, 'update_row', oneRow)],
      affirmIndex: 0,
      optionCount: 2,
      ttlMs: 60_000,
    });
    expect((await resolveConsent(active.db, smallId, 0, scope)).status).toBe('granted');

    const refusals = await refusalsForThread(active.db, scope);
    const smallLedger = new TurnOutcomeLedger({
      refusals,
      consent: {
        status: 'granted',
        grants: await loadGrants(active, smallId),
        spend: (i, by) => spendGrant(active.db, smallId, i, by),
      },
    });
    // The act they really approved goes through — a refusal must not make an object
    // unusable for the rest of the conversation.
    expect((await executeFunction(ctx, 'update_row', oneRow, smallLedger)).ok).toBe(true);
    expect((await active.db.get('contacts', 'c0'))?.name).toBeNull();

    // Turn 3 — the model chips away at the plan the user refused in turn 1, ONE record
    // at a time. Each call is far under the unasked threshold, so the size screen waves
    // every one of them through: the standing refusal is the only thing in the way, and
    // the small yes in turn 2 must not have lifted it.
    const chip = { table: 'contacts', id: 'c1', values: { body: null } };
    const retryLedger = new TurnOutcomeLedger({ refusals });
    const retry = await executeFunction(ctx, 'update_row', chip, retryLedger);
    // THE assertion, on the data: the record still holds its text.
    expect((await active.db.get('contacts', 'c1'))?.body).toBe('keep me');
    expect(retry.ok).toBe(false);
    expect(retry.error).toContain('REFUSED');
    expect(retry.error).toContain('said no');

    // ...and so does the act they actually refused.
    const wide = await executeFunction(ctx, 'bulk_update', wipeEverything, retryLedger);
    expect(wide.ok).toBe(false);
    const bodies = [...new Set((await active.db.query('contacts', {})).map((r) => r.body))];
    expect(bodies).toEqual(['keep me']);
  });

  it('still lets a fresh YES about the SAME act lift the refusal it answered', async () => {
    // The other half: a no that nothing could lift would make the object permanently
    // unusable, which is its own kind of broken.
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
    const scope = { threadId: 't1', ownerUserId: null };
    const wipeEverything = { table: 'contacts', set: { body: null } };

    const noId = await mintConsent(active.db, {
      ...scope,
      grants: [await grantFor(ctx, 'bulk_update', wipeEverything)],
      affirmIndex: 0,
      optionCount: 2,
      ttlMs: 60_000,
    });
    expect((await resolveConsent(active.db, noId, 1, scope)).status).toBe('declined');
    await nextMillisecond();

    // Asked again about the SAME act, and this time they say yes.
    const yesId = await mintConsent(active.db, {
      ...scope,
      grants: [await grantFor(ctx, 'bulk_update', wipeEverything)],
      affirmIndex: 0,
      optionCount: 2,
      ttlMs: 60_000,
    });
    expect((await resolveConsent(active.db, yesId, 0, scope)).status).toBe('granted');

    const ledger = new TurnOutcomeLedger({
      refusals: await refusalsForThread(active.db, scope),
      consent: {
        status: 'granted',
        grants: await loadGrants(active, yesId),
        spend: (i, by) => spendGrant(active.db, yesId, i, by),
      },
    });
    const r = await executeFunction(ctx, 'bulk_update', wipeEverything, ledger);
    expect(r.ok).toBe(true);
    expect((await active.db.query('contacts', {})).every((x) => x.body === null)).toBe(true);
  });
});

describe('a refusal is not lifted by a coin flip', () => {
  it('keeps the refusal when two answers to the same act are indistinguishable in time', async () => {
    // The history is ordered by the stored millisecond timestamps, and past those the
    // ordering used to fall through to `id DESC` — a RANDOM UUID. Two answers to the
    // same act landing in the same millisecond therefore resolved to whichever id
    // happened to sort higher, so the IDENTICAL conversation gated one way on one run
    // and the other way on the next. A no that might be the user's last word must not
    // be discarded on a tiebreak.
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
    const scope = { threadId: 't1', ownerUserId: null };
    const wipeEverything = { table: 'contacts', set: { body: null } };
    const grant = await grantFor(ctx, 'bulk_update', wipeEverything);

    const noId = await mintConsent(active.db, {
      ...scope,
      grants: [grant],
      affirmIndex: 0,
      optionCount: 2,
      ttlMs: 60_000,
    });
    const yesId = await mintConsent(active.db, {
      ...scope,
      grants: [grant],
      affirmIndex: 0,
      optionCount: 2,
      ttlMs: 60_000,
    });
    expect((await resolveConsent(active.db, noId, 1, scope)).status).toBe('declined');
    expect((await resolveConsent(active.db, yesId, 0, scope)).status).toBe('granted');

    // Force the exact tie the clock only produces sometimes: identical stamps on both
    // records, so nothing in the store can say which answer came last. The ids are
    // pinned too, and pinned so the GRANT sorts first under the old `id DESC`
    // tiebreak — otherwise this spec passes half the time on a coin flip, which is the
    // very thing it exists to rule out.
    const stamp = '2026-01-01T00:00:00.000Z';
    const pinned = new Map([
      [noId, 'consent-aaa-declined'],
      [yesId, 'consent-zzz-granted'],
    ]);
    for (const [was, now] of pinned) {
      await runAsyncOrSync(
        active.db.adapter,
        `UPDATE "${CONSENT_TABLE}" SET "answered_at" = ?, "created_at" = ?, "id" = ? WHERE "id" = ?`,
        [stamp, stamp, now, was],
      );
    }
    const grantedId = pinned.get(yesId) ?? '';

    const refusals = await refusalsForThread(active.db, scope);
    const ledger = new TurnOutcomeLedger({
      refusals,
      consent: {
        status: 'granted',
        grants: await loadGrants(active, grantedId),
        spend: (i, by) => spendGrant(active.db, grantedId, i, by),
      },
    });
    const r = await executeFunction(ctx, 'bulk_update', wipeEverything, ledger);
    // THE assertion: the records keep their text, deterministically, whichever uuid
    // happened to sort higher.
    const bodies = [...new Set((await active.db.query('contacts', {})).map((x) => x.body))];
    expect(bodies).toEqual(['keep me']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('REFUSED');
    // ...and the store says the act reads as refused, which is why.
    expect([...refusals.targets]).toEqual(['contacts']);
    expect([...refusals.grantedActs]).toEqual([]);
  });
});

/** The grants on a stored consent record, as the route hands them to the ledger. */
async function loadGrants(active: ActiveDb, id: string): Promise<ConsentGrant[]> {
  const { loadConsent } = await import('../../src/gui/ai/consent-store.js');
  return (await loadConsent(active.db, id))?.grants ?? [];
}
