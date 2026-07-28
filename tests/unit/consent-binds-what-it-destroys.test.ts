import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import {
  destructiveIntent,
  executeFunction,
  TurnOutcomeLedger,
  type DispatchCtx,
} from '../../src/gui/ai/dispatch.js';
import { runChat, type LlmClient, type TurnResult } from '../../src/gui/ai/chat.js';
import type { ChatStreamEvent } from '../../src/gui/ai/sse.js';
import { loadConsent, type ConsentGrant } from '../../src/gui/ai/consent-store.js';

/**
 * A GRANT MUST BIND WHAT THE CALL ACTUALLY DESTROYS.
 *
 * The gate compares a stored grant against the call about to run. Everything the
 * comparison does NOT bind is a degree of freedom the caller keeps — it can approve
 * one act and perform a different one of the same shape. Five such freedoms were
 * measured, each with rows really gone at the end of it:
 *
 *  1. `merge_rows` and `dedup` bound NOTHING about their targets. `verbKey` returned
 *     '' for both under a docstring claiming they "have no such argument key" —
 *     measurably false: merge_rows' entire API is survivor_id + duplicate_ids, and
 *     dedup's `fuzzy` decides whether it merges 0 records or hundreds.
 *  2. `update_row` was not in REMOVAL_TOOLS at all, so the identical destruction
 *     `bulk_update` classifies as `clear` was ungated — including straight after a
 *     recorded refusal.
 *  3. The row-selecting filter was compared through a 32-BIT FNV-1a hash while the
 *     caller controls both preimages. That is not an authorization primitive; a
 *     colliding pair is found in seconds, and the two filters below are one.
 *  4. `args.id` — unvalidated model text — was interpolated into the card line the
 *     user reads and persisted verbatim into the durable grant, contradicting the
 *     "no field can carry model-authored prose" contract it rides in.
 *  5. Column names were validated with the `in` operator, so every
 *     Object.prototype name passed as a real column of the table.
 *
 * Every assertion below is on the DATA — rows still there, or really gone — or on
 * the card the user is actually shown. A privilege bit or a key comparison passing
 * is what each of these defects already did.
 */

/** A scripted LlmClient that returns queued turns. */
function scriptedClient(turns: { text: string; toolUses?: TurnResult['toolUses'] }[]): LlmClient {
  let i = 0;
  return {
    runTurn(params) {
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      if (turn?.text) params.onText(turn.text);
      const toolUses = turn?.toolUses ?? [];
      return Promise.resolve({
        stopReason: toolUses.length > 0 ? 'tool_use' : 'end_turn',
        text: turn?.text ?? '',
        toolUses,
      });
    },
  };
}

async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const SCOPE = { threadId: 'thread-1', ownerUserId: 'user-1', askedMsgId: 'msg-1' };

/**
 * Two `bulk_update` filters that COLLIDE under FNV-1a 32-bit and select disjoint
 * halves of `notes`. Found by birthday search in under three seconds of one core —
 * the caller controls both preimages, so a birthday search is all it ever needed.
 *
 * The padding is a SECOND, entirely legitimate clause: every row's body is "keep me",
 * so `body != <anything else>` matches all of them and the pad changes the hash
 * without changing a single row selected. It is deliberately padding that SURVIVES
 * `parseBulkFilters` — junk that the parser drops would be neutralised by keying on
 * the parsed clause list alone, and the hash width would never be tested.
 */
const COLLIDING_ARCHIVED = [
  { col: 'owner', op: 'eq', val: 'archived' },
  { col: 'body', op: 'ne', val: 'pad-a26br5' },
];
const COLLIDING_ACTIVE = [
  { col: 'owner', op: 'eq', val: 'active' },
  { col: 'body', op: 'ne', val: 'pad-b3eb0' },
];

/** The measured card line: reassurance in an `id` the model wrote, not a record id. */
const PROSE_ID = 'n_1 (a test copy — the real data is untouched, safe)';
/**
 * The same sentence, but as the id of a record that REALLY EXISTS.
 *
 * The assistant creates records and chooses their ids, so a row whose primary key is
 * a sentence is not hypothetical — and a card line built by interpolating the id of a
 * real row would print it. Requiring the id to name a real record closes the common
 * case; requiring it to be SHAPED like an identifier closes this one.
 */
const PROSE_ROW_ID = 'n_2 — SAFE: a scratch copy, nothing real is lost';

describe('a consent grant binds what the call actually destroys', () => {
  let tmpDir: string;
  let db: Lattice;
  let ctx: DispatchCtx;

  /** Names that are pairwise near-duplicates but never exact ones — fuzzy-only. */
  const PAIR_WORDS = [
    'alpha',
    'bravo',
    'charlie',
    'delta',
    'echo',
    'foxtrot',
    'golf',
    'hotel',
    'india',
    'juliett',
    'kilo',
    'lima',
    'mike',
    'november',
    'oscar',
    'papa',
    'quebec',
    'romeo',
    'sierra',
    'tango',
    'uniform',
    'victor',
  ];
  const baseName = (w: string): string => `Northwind Trading Company Limited Partnership ${w}`;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-binds-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', owner: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    db.define('people', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'people.md',
    });
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
    // 30 archived + 30 active. Equal halves on purpose: the COUNT is then identical
    // either way, so only the filter (or the id list) can tell the two sets apart.
    for (const owner of ['archived', 'active']) {
      for (let i = 0; i < 30; i++) {
        await db.insert('notes', { id: `n_${owner}_${String(i)}`, body: 'keep me', owner });
      }
    }
    // A record whose primary key is a sentence. The assistant picks ids when it
    // creates records, so this is reachable, and it is the residue left over once
    // "the id must name a real record" is enforced.
    // (A third owner value, so the two 30-record halves above stay exactly equal.)
    await db.insert('notes', { id: PROSE_ROW_ID, body: 'keep me', owner: 'scratch' });
    // 22 near-duplicate PAIRS: an exact pass merges nothing, a fuzzy pass merges 22.
    for (const w of PAIR_WORDS) {
      await db.insert('people', { id: `p_${w}`, name: baseName(w) });
      await db.insert('people', { id: `p_${w}_x`, name: `${baseName(w)}x` });
    }
    // A REAL config on disk: `merge_rows` / `dedup` walk it to find the junctions
    // they must re-point before soft-deleting. Without it the merge throws before
    // it destroys anything, and a test asserting "the rows are still there" would
    // pass for the wrong reason.
    const configPath = join(tmpDir, 'lattice.config.yml');
    const outputDir = join(tmpDir, 'context');
    writeFileSync(
      configPath,
      [
        'db: ./test.db',
        '',
        'entities:',
        '  notes:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      body: { type: text }',
        '      owner: { type: text }',
        '      deleted_at: { type: text }',
        '    render: default-list',
        '    outputFile: notes.md',
        '  people:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '      deleted_at: { type: text }',
        '    render: default-list',
        '    outputFile: people.md',
        '',
      ].join('\n'),
    );
    ctx = {
      db,
      feed: new FeedBus(),
      validTables: new Set(['notes', 'people']),
      junctionTables: new Set(),
      softDeletable: new Set(['notes', 'people']),
      configPath,
      outputDir,
      deleteEntity: () => Promise.resolve({ ok: true as const, droppedLinkTables: [] }),
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A grant built the way the SERVER builds one — from the pre-flight classifier's
   * own output, never from a hand-written key. Mirrors `planConsent`, so a test can
   * never accidentally agree with the gate about a key neither derives in production.
   */
  async function grantFor(tool: string, args: Record<string, unknown>): Promise<ConsentGrant> {
    const intent = await destructiveIntent(ctx, tool, args);
    if (!intent) throw new Error(`"${tool}" was not classified as destructive — nothing to grant`);
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
  function ledgerWith(
    grants: ConsentGrant[],
    status: 'granted' | 'declined' = 'granted',
  ): TurnOutcomeLedger {
    const live = grants.map((g) => ({ ...g }));
    return new TurnOutcomeLedger({
      consent: {
        status,
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

  /** The `question` event a confirm-bearing ask_user turn produces, if any. */
  async function askToConfirm(
    confirm: { tool: string; args: Record<string, unknown> }[],
  ): Promise<Extract<ChatStreamEvent, { type: 'question' }> | undefined> {
    const client = scriptedClient([
      {
        text: 'One moment.',
        toolUses: [
          {
            id: 'tu1',
            name: 'ask_user',
            input: { question: 'MODEL QUESTION', options: ['MODEL YES', 'MODEL NO'], confirm },
          },
        ],
      },
    ]);
    const events = await collect(
      runChat({ client, dispatch: ctx, userMessage: 'go on then', consentScope: SCOPE }),
    );
    const q = events.find((e) => e.type === 'question');
    return q?.type === 'question' ? q : undefined;
  }

  /** Ids of the rows of `table` that are still live (not soft-deleted). */
  async function liveIds(table: string): Promise<string[]> {
    const rows = await db.query(table, { filters: [{ col: 'deleted_at', op: 'isNull' }] });
    return rows.map((r) => String(r.id)).sort();
  }

  // ── 1. merge_rows binds the records it collapses ────────────────────────────

  it('will not spend a merge approved for 26 NAMED records on 26 different ones', async () => {
    const approved = {
      table: 'notes',
      survivor_id: 'n_archived_0',
      duplicate_ids: Array.from({ length: 26 }, (_, i) => `n_archived_${String(i + 1)}`),
    };
    const swapped = {
      table: 'notes',
      survivor_id: 'n_active_0',
      duplicate_ids: Array.from({ length: 26 }, (_, i) => `n_active_${String(i + 1)}`),
    };
    const ledger = ledgerWith([await grantFor('merge_rows', approved)]);

    const wrong = await executeFunction(ctx, 'merge_rows', swapped, ledger);
    // THE assertion: the records the user never named are still there. A grant that
    // binds only "26 records in notes" covers this call exactly.
    expect(await liveIds('notes')).toContain('n_active_13');
    expect((await liveIds('notes')).filter((id) => id.startsWith('n_active_'))).toHaveLength(30);
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain('REFUSED');

    // ...and the merge they DID approve still runs, so this is a binding and not a
    // blanket refusal of merges.
    const right = await executeFunction(ctx, 'merge_rows', approved, ledger);
    expect(right.ok).toBe(true);
    const archivedLive = (await liveIds('notes')).filter((id) => id.startsWith('n_archived_'));
    expect(archivedLive).toHaveLength(4); // 30 − 26 merged away
  });

  // ── 2. dedup binds which scan it runs ───────────────────────────────────────

  it('will not spend an EXACT-duplicate approval on a fuzzy pass', async () => {
    const exact = { table: 'people', fuzzy: false };
    const fuzzy = { table: 'people', fuzzy: true };
    const ledger = ledgerWith([await grantFor('dedup', exact)]);

    const wrong = await executeFunction(ctx, 'dedup', fuzzy, ledger);
    // Every one of the 44 records is still there: the approval was for a pass that
    // finds no duplicates at all in this table.
    expect(await liveIds('people')).toHaveLength(44);
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain('REFUSED');

    // The approved (exact) pass runs and — truthfully — merges nothing here.
    const right = await executeFunction(ctx, 'dedup', exact, ledger);
    expect(right.ok).toBe(true);
    expect(await liveIds('people')).toHaveLength(44);

    // ...and a fuzzy pass really does destroy, so the refusal above was not vacuous.
    const fuzzyLedger = ledgerWith([await grantFor('dedup', fuzzy)]);
    const approvedFuzzy = await executeFunction(ctx, 'dedup', fuzzy, fuzzyLedger);
    expect(approvedFuzzy.ok).toBe(true);
    expect(await liveIds('people')).toHaveLength(22);
  });

  it('says on the card WHICH duplicate scan is being approved', async () => {
    const exact = await destructiveIntent(ctx, 'dedup', { table: 'people', fuzzy: false });
    const fuzzy = await destructiveIntent(ctx, 'dedup', { table: 'people', fuzzy: true });
    // Two different acts — one merges nothing here, the other merges 22 records — so
    // they must not read as the same sentence on the one screen the user decides from.
    expect(exact?.detail).not.toEqual(fuzzy?.detail);
    expect(fuzzy?.detail).toMatch(/similar|fuzzy/i);
    expect(exact?.detail).toMatch(/exact|identical/i);
  });

  // ── 3. update_row is the same destruction as bulk_update ────────────────────

  it('refuses update_row clears on an object the user has just refused', async () => {
    const ledger = ledgerWith(
      [await grantFor('bulk_update', { table: 'notes', set: { body: null } })],
      'declined',
    );
    const targets = ['n_active_0', 'n_active_1', 'n_active_2'];
    for (const id of targets) {
      const r = await executeFunction(
        ctx,
        'update_row',
        { table: 'notes', id, values: { body: null } },
        ledger,
      );
      expect(r.ok).toBe(false);
      expect(r.error).toContain('REFUSED');
    }
    // THE assertion: the three records the user refused to have wiped still hold
    // their text. Chipping a refused plan away one call at a time is the same plan.
    for (const id of targets) {
      expect((await db.get('notes', id))?.body).toBe('keep me');
    }
  });

  it('counts an update_row clear toward the turn’s destructive plan', async () => {
    // No consent at all. 26 single-row clears is the same destruction as one
    // bulk_update over 26 rows, and must reach the same threshold.
    const ledger = new TurnOutcomeLedger();
    let refusedAt = -1;
    for (let i = 0; i < 30; i++) {
      const r = await executeFunction(
        ctx,
        'update_row',
        { table: 'notes', id: `n_active_${String(i)}`, values: { body: null } },
        ledger,
      );
      if (!r.ok && r.error?.includes('REFUSED')) {
        refusedAt = i;
        break;
      }
    }
    expect(refusedAt).toBeGreaterThan(-1);
    // ...and it stopped at the threshold rather than after the object was empty.
    const wiped = (await db.query('notes', { filters: [{ col: 'body', op: 'isNull' }] })).length;
    expect(wiped).toBeLessThanOrEqual(26);
  });

  // ── 4. the filter is an authorization comparison, not a 32-bit hash ─────────

  it('will not spend a filtered clear on a filter that merely COLLIDES with it', async () => {
    const approved = { table: 'notes', set: { body: null }, filter: COLLIDING_ARCHIVED };
    const collides = { table: 'notes', set: { body: null }, filter: COLLIDING_ACTIVE };
    const ledger = ledgerWith([await grantFor('bulk_update', approved)]);

    const wrong = await executeFunction(ctx, 'bulk_update', collides, ledger);
    // THE assertion, on the data: the 30 ACTIVE records still hold their text.
    const active = await db.query('notes', {
      filters: [{ col: 'owner', op: 'eq', val: 'active' }],
    });
    expect(active.map((r) => r.body)).toEqual(Array.from({ length: 30 }, () => 'keep me'));
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain('REFUSED');

    // The records the user actually approved are still clearable.
    const right = await executeFunction(ctx, 'bulk_update', approved, ledger);
    expect(right.ok).toBe(true);
    const archived = await db.query('notes', {
      filters: [{ col: 'owner', op: 'eq', val: 'archived' }],
    });
    expect(archived.every((r) => r.body === null)).toBe(true);
  });

  it('matches a filter the model re-wrote but did not change the meaning of', async () => {
    // The comparison is STRUCTURAL: it is made on the parsed, column-validated clause
    // list, not on the raw argument text. Two consequences, and this test is the
    // second one — the first is that junk a parser drops cannot pad a collision
    // search, and the second is that the model re-emitting the same selection with an
    // extra ignored key is the SAME act and must not be refused for no reason.
    // Refusing it would teach the model that answers are arbitrary, which is how a
    // gate gets worked around rather than obeyed.
    const approved = {
      table: 'notes',
      set: { body: null },
      filter: [{ col: 'owner', op: 'eq', val: 'archived' }],
    };
    const rewritten = {
      table: 'notes',
      set: { body: null },
      // `note` is not a clause field; parseBulkFilters reads only col/op/val.
      filter: [{ col: 'owner', op: 'eq', val: 'archived', note: 'the archived ones' }],
    };
    const ledger = ledgerWith([await grantFor('bulk_update', approved)]);
    const r = await executeFunction(ctx, 'bulk_update', rewritten, ledger);
    expect(r.ok).toBe(true);
    const archived = await db.query('notes', {
      filters: [{ col: 'owner', op: 'eq', val: 'archived' }],
    });
    expect(archived.every((x) => x.body === null)).toBe(true);
    // ...and the ACTIVE half — which no filter here selects — is untouched, so this
    // is an equivalence and not a loophole.
    const active = await db.query('notes', {
      filters: [{ col: 'owner', op: 'eq', val: 'active' }],
    });
    expect(active.every((x) => x.body === 'keep me')).toBe(true);
  });

  it('treats a clear whose blast radius cannot be counted as WIDE, not as harmless', async () => {
    // The pre-flight count is the only thing that says how big a clear is. When it
    // fails, the classifier used to return null — "not destructive" — and the call
    // ran ungated. Every other counted branch already treats an uncountable target
    // as wide; this is the one that did not.
    const real = db.boundedCount.bind(db);
    (db as unknown as { boundedCount: unknown }).boundedCount = () =>
      Promise.reject(new Error('count exploded'));
    try {
      const r = await executeFunction(
        ctx,
        'bulk_update',
        { table: 'notes', set: { body: null } },
        new TurnOutcomeLedger(),
      );
      expect(r.ok).toBe(false);
      expect(r.error).toContain('REFUSED');
    } finally {
      (db as unknown as { boundedCount: unknown }).boundedCount = real;
    }
    // Nothing was cleared.
    const wiped = (await db.query('notes', { filters: [{ col: 'body', op: 'isNull' }] })).length;
    expect(wiped).toBe(0);
  });

  // ── 5. no model prose on the card, and no fake columns ──────────────────────

  it('mints no card at all when a delete_row names something that is not a record', async () => {
    const q = await askToConfirm([
      // A genuinely destructive call, so the prose has a REAL grant to ride alongside
      // — the exact shape that was measured.
      { tool: 'bulk_update', args: { table: 'notes', set: { body: null } } },
      { tool: 'delete_row', args: { table: 'notes', id: PROSE_ID } },
    ]);
    expect(q).toBeUndefined();
  });

  it('keeps a sentence off the card even when it really is a record’s id', async () => {
    // The record exists, so this call genuinely destroys something and there IS a
    // card. What must not happen is the sentence being read out as the record's name,
    // which is what interpolating `args.id` did.
    const q = await askToConfirm([
      { tool: 'delete_row', args: { table: 'notes', id: PROSE_ROW_ID } },
    ]);
    if (!q) throw new Error('no question event');
    const card = `${q.consent?.headline ?? ''}\n${(q.consent?.lines ?? []).join('\n')}`;
    expect(card).not.toContain('SAFE: a scratch copy');
    expect(card).not.toContain('nothing real is lost');
    // The user is still told, truthfully, what the approval covers.
    expect(card).toMatch(/1 record/);
    expect(card).toContain('"notes"');
  });

  it('names a real record on the card and keeps the raw id out of the durable grant', async () => {
    const q = await askToConfirm([
      { tool: 'delete_row', args: { table: 'notes', id: 'n_archived_0' } },
      { tool: 'bulk_update', args: { table: 'notes', set: { body: null } } },
    ]);
    if (!q) throw new Error('no question event');
    const card = `${q.consent?.headline ?? ''}\n${(q.consent?.lines ?? []).join('\n')}`;
    // The user is still told WHICH record — the point of binding the row at all.
    expect(card).toContain('n_archived_0');
    // ...but the durable record carries no model-authored string in the field
    // documented to carry none. `detail` is the server-composed sentence; `verbKey`
    // is a comparison key and must not be a channel for anything the model wrote.
    const record = await loadConsent(db, q.id ?? '');
    const keys = (record?.grants ?? []).map((g) => g.verbKey);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).not.toContain('n_archived_0');
  });

  it('does not accept Object.prototype names as columns of the table', async () => {
    // `'constructor' in cols` is true for every plain object, so a set of prototype
    // names read as a real destructive clear and reached the card.
    const q = await askToConfirm([
      { tool: 'bulk_update', args: { table: 'notes', set: { constructor: null, toString: '' } } },
    ]);
    expect(q).toBeUndefined();

    // ...and the same check on the FILTER side. The clause must be refused BY THE
    // TOOL'S OWN VALIDATION — the message names the argument the model has to fix.
    // With `in`, the clause passed validation and was handed to the query builder as
    // a real column; the storage layer happens to reject it today, which is exactly
    // the "something further down will catch it" assumption that stops holding the
    // moment a different adapter or a different call path is in the way.
    const r = await executeFunction(ctx, 'bulk_update', {
      table: 'notes',
      set: { body: 'x' },
      filter: [{ col: 'hasOwnProperty', op: 'isNotNull' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('filter references unknown column');
  });
});
