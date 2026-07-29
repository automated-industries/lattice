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
  DESTRUCTIVE_ROW_THRESHOLD,
  type DispatchCtx,
} from '../../src/gui/ai/dispatch.js';

/**
 * CLASSIFICATION IS WHAT MAKES THE GATE FIRE.
 *
 * The gate only ever acts on a call the classifier recognises: a tool outside
 * REMOVAL_TOOLS is never measured, so it never counts toward the turn. What the gate
 * DOES with a classified call now depends on one property — reversibility. A REVERSIBLE
 * change (a clear/blank, an unlink, a merge or dedup, a soft row delete to the trash)
 * proceeds at any scale, because undo/version-history/trash is the safety net. Only an
 * IRREVERSIBLE hard removal (delete_data / delete_cascade) still hits the size wall.
 * So classification is load-bearing twice over: it decides whether a call is measured
 * at all, and it decides which arm — reversible or not — the call falls into.
 *
 * The classification defects this file guards, each measured with rows really gone:
 *
 *  1. `merge_rows` and `dedup` were not classified at all, so a single call was invisible
 *     to the gate. `dedup`'s `fuzzy` in particular decides whether it merges 0 records or
 *     hundreds, and its size is stated as a BOUND, not a scan.
 *  2. `update_row` was not in REMOVAL_TOOLS either, so the identical destruction
 *     `bulk_update` classifies as `clear` was invisible one row at a time.
 *  3. A clear whose blast radius could not be COUNTED came back as "not destructive"; it
 *     must still classify (as unknown), even though a reversible clear proceeds anyway.
 *  4. `args.id` — unvalidated model text — was interpolated into the sentence the user
 *     reads, and column names were validated with the `in` operator, so every
 *     Object.prototype name passed as a real column of the table.
 *
 * Every assertion below is on the DATA — rows still there, or really gone — or on the
 * exact sentence the user is shown.
 */
/** The measured sentence: reassurance in an `id` the model wrote, not a record id. */
const PROSE_ID = 'n_1 (a test copy — the real data is untouched, safe)';
/**
 * The same sentence, but as the id of a record that REALLY EXISTS.
 *
 * The assistant creates records and chooses their ids, so a row whose primary key is
 * a sentence is not hypothetical — and a line built by interpolating the id of a real
 * row would print it. Requiring the id to name a real record closes the common case;
 * requiring it to be SHAPED like an identifier closes this one.
 */
const PROSE_ROW_ID = 'n_2 — SAFE: a scratch copy, nothing real is lost';

/**
 * Records per owner-half of `notes`.
 *
 * DERIVED from the threshold, never a literal. EACH half alone has to clear the refusal
 * line on its own: the merge test names its duplicates out of the `archived` half, and
 * the turn-accumulation test walks the `active` half one record at a time. Written this
 * way so the fixtures move with the product decision rather than silently sliding under
 * the line the next time it changes — which is what stranded every literal in this file
 * when it moved from 25 to 200.
 */
const NOTE_HALF = DESTRUCTIVE_ROW_THRESHOLD + 5;
/**
 * Live records in `people` — over the refusal line on its own.
 *
 * DERIVED from the threshold for the same reason NOTE_HALF is. A dedup is measured by a
 * BOUND, not by the duplicate scan: a table of N live records can lose at most N−1 to
 * merging, and the scan is deliberately never run inside the gate (see the `dedup`
 * branch in dispatch.ts — running it there froze the event loop for ~104s on a 1,200-row
 * table). So what puts a dedup over the line is the table's SIZE, and this is the table
 * that is over it.
 */
const PEOPLE_ROWS = DESTRUCTIVE_ROW_THRESHOLD + 2;
/** Byte-identical records in `people` — what an EXACT pass there would have to merge. */
const EXACT_TRIO = 3;

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

describe('what a destructive call is classified as, and how big it is measured to be', () => {
  let tmpDir: string;
  let db: Lattice;
  let ctx: DispatchCtx;

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
    // NOTE_HALF archived + NOTE_HALF active. Equal halves on purpose: the COUNT is then
    // identical either way, so only the filter (or the id list) can tell the two sets
    // apart. Each half is over the refusal line on its own — see NOTE_HALF.
    for (const owner of ['archived', 'active']) {
      for (let i = 0; i < NOTE_HALF; i++) {
        await db.insert('notes', { id: `n_${owner}_${String(i)}`, body: 'keep me', owner });
      }
    }
    // A record whose primary key is a sentence. The assistant picks ids when it
    // creates records, so this is reachable, and it is the residue left over once
    // "the id must name a real record" is enforced.
    // (A third owner value, so the two NOTE_HALF halves above stay exactly equal.)
    await db.insert('notes', { id: PROSE_ROW_ID, body: 'keep me', owner: 'scratch' });
    // 22 near-duplicate PAIRS. Each `_x` row is one character off its partner, which a
    // fuzzy pass merges and an exact pass does not — so the two passes over ONE table
    // destroy measurably different amounts.
    for (const w of PAIR_WORDS) {
      await db.insert('people', { id: `p_${w}`, name: baseName(w) });
      await db.insert('people', { id: `p_${w}_x`, name: `${baseName(w)}x` });
    }
    // One genuinely IDENTICAL trio, so the exact pass has something of its own to
    // merge. Lowest id sorts first, so `p_dup_0` is the survivor.
    for (let i = 0; i < EXACT_TRIO; i++) {
      await db.insert('people', { id: `p_dup_${String(i)}`, name: 'Duplicate Person' });
    }
    // Ordinary, mutually distinct records bringing the table up to PEOPLE_ROWS — the
    // several hundred rows a real table is mostly made of. They are duplicates of
    // nothing, and the scan proves it: they are what makes this "a big table holding a
    // handful of duplicates" rather than a small one.
    for (let i = PAIR_WORDS.length * 2 + EXACT_TRIO; i < PEOPLE_ROWS; i++) {
      await db.insert('people', { id: `p_solo_${String(i)}`, name: `Unique Person ${String(i)}` });
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

  /** Ids of the rows of `table` that are still live (not soft-deleted). */
  async function liveIds(table: string): Promise<string[]> {
    const rows = await db.query(table, { filters: [{ col: 'deleted_at', op: 'isNull' }] });
    return rows.map((r) => String(r.id)).sort();
  }

  // ── 1. merge_rows and dedup are classified — and, being reversible, proceed ──

  it('merges however many records the request names — a reversible merge has no size wall', async () => {
    // Well over the old line. A merge soft-deletes the losers to the recoverable trash
    // and undoes as one action, so there is no scale at which it is refused — undo is
    // the safety net. Every id names a record that really exists.
    const dupes = DESTRUCTIVE_ROW_THRESHOLD + 1;
    const merge = {
      table: 'notes',
      survivor_id: 'n_archived_0',
      duplicate_ids: Array.from({ length: dupes }, (_, i) => `n_archived_${String(i + 1)}`),
    };
    const r = await executeFunction(ctx, 'merge_rows', merge, new TurnOutcomeLedger());
    expect(r.ok).toBe(true);
    expect(r.error ?? '').not.toContain('REFUSED');
    // THE assertion, on the data: the merged-away records are gone from the live set
    // (survivor + the three archived rows the merge did not name remain)...
    const liveArchived = (await liveIds('notes')).filter((id) => id.startsWith('n_archived_'));
    expect(liveArchived).toHaveLength(NOTE_HALF - dupes);
    // ...and they are RECOVERABLE — soft-deleted to the trash, not destroyed.
    const trashed = (
      await db.query('notes', { filters: [{ col: 'deleted_at', op: 'isNotNull' }] })
    ).filter((r) => String(r.id).startsWith('n_archived_'));
    expect(trashed).toHaveLength(dupes);
  });

  it('still merges a handful of named records — the threshold is a size, not a ban', async () => {
    const small = {
      table: 'notes',
      survivor_id: 'n_archived_0',
      duplicate_ids: ['n_archived_1', 'n_archived_2'],
    };
    const r = await executeFunction(ctx, 'merge_rows', small, new TurnOutcomeLedger());
    expect(r.ok).toBe(true);
    expect((await liveIds('notes')).filter((id) => id.startsWith('n_archived_'))).toHaveLength(
      NOTE_HALF - 2,
    );
  });

  // ── 1b. a dedup's size is a BOUND — but, being reversible, it is never refused ─

  it('dedups a table of any size — a reversible dedup has no size wall', async () => {
    // The table is well over the old line, and a dedup is reversible: the losers go to
    // the recoverable trash and the pass undoes as one action, so it proceeds whatever
    // its size. The exact pass here merges only the byte-identical trio; the rest of the
    // table is untouched.
    expect(PEOPLE_ROWS - 1).toBeGreaterThan(DESTRUCTIVE_ROW_THRESHOLD);
    const r = await executeFunction(
      ctx,
      'dedup',
      { table: 'people', fuzzy: false },
      new TurnOutcomeLedger(),
    );
    expect(r.ok).toBe(true);
    expect(r.error ?? '').not.toContain('REFUSED');
    // THE assertion, on the data: the identical trio collapsed to ONE survivor (two
    // merged away), and every other record is still live.
    const liveDup = (await liveIds('people')).filter((id) => id.startsWith('p_dup_'));
    expect(liveDup).toHaveLength(1);
    expect(await liveIds('people')).toHaveLength(PEOPLE_ROWS - (EXACT_TRIO - 1));
    // ...and the merged-away pair is recoverable, not destroyed.
    const trashed = (
      await db.query('people', { filters: [{ col: 'deleted_at', op: 'isNotNull' }] })
    ).filter((r) => String(r.id).startsWith('p_dup_'));
    expect(trashed).toHaveLength(EXACT_TRIO - 1);
  });

  it('says WHICH duplicate scan it is describing, and states its size as a BOUND', async () => {
    const exact = await destructiveIntent(ctx, 'dedup', { table: 'people', fuzzy: false });
    const fuzzy = await destructiveIntent(ctx, 'dedup', { table: 'people', fuzzy: true });
    // Two different acts over one table: an exact pass merges only records that are
    // already identical (often none), a fuzzy pass merges whatever a similarity score
    // calls close enough. The refused sentence is what the person acts on themselves, so
    // it has to say which one it is.
    expect(exact?.detail).not.toEqual(fuzzy?.detail);
    expect(fuzzy?.detail).toMatch(/similar|fuzzy/i);
    expect(exact?.detail).toMatch(/exact|identical/i);
    // ...and the SIZE is live-rows−1 for both, because the bound cannot tell the two
    // passes apart — the only thing that could is the scan, which is never run here.
    // So it must read as a ceiling, not a count: a person reading "up to N" goes and
    // looks, a person reading "N" believes it.
    expect(exact?.rows).toBe(PEOPLE_ROWS - 1);
    expect(fuzzy?.rows).toBe(PEOPLE_ROWS - 1);
    expect(fuzzy?.detail).toMatch(/bound/i);
    expect(fuzzy?.detail).toContain(`up to ${String(PEOPLE_ROWS - 1)}`);
  });

  // ── 2. update_row is the same destruction as bulk_update — and reversible ────

  it('never refuses a reversible clear, however many records the turn spans', async () => {
    // A single-row clear is the same destruction as one bulk_update over all of them,
    // and both are reversible — the prior value is kept in the audit image and the undo
    // restores it. So a whole object cleared one record at a time proceeds end to end,
    // however far over the old line it runs: undo is the safety net, not a size limit.
    //
    // These are real, separate calls on purpose: accumulating across the turn IS the
    // code path that used to refuse, so there is no cheaper construction that proves it
    // no longer does.
    expect(NOTE_HALF).toBeGreaterThan(DESTRUCTIVE_ROW_THRESHOLD);
    const ledger = new TurnOutcomeLedger();
    let refusedAt = -1;
    for (let i = 0; i < NOTE_HALF; i++) {
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
    // Never refused, and every record in the active half really was cleared.
    expect(refusedAt).toBe(-1);
    const wiped = (
      await db.query('notes', {
        filters: [
          { col: 'body', op: 'isNull' },
          { col: 'owner', op: 'eq', val: 'active' },
        ],
      })
    ).length;
    expect(wiped).toBe(NOTE_HALF);
  });

  it('leaves an ordinary one-row edit alone', async () => {
    // Clearing one field on one record is not a wide act, and the gate must not turn
    // into a tax on ordinary editing.
    const r = await executeFunction(
      ctx,
      'update_row',
      { table: 'notes', id: 'n_active_0', values: { body: null } },
      new TurnOutcomeLedger(),
    );
    expect(r.ok).toBe(true);
    expect((await db.get('notes', 'n_active_0'))?.body).toBeNull();
  });

  // ── 3. an unmeasurable clear still classifies — and, being reversible, proceeds ─

  it('still classifies an uncountable clear (marks it unknown), but does not refuse it', async () => {
    // The pre-flight count is the only thing that says how big a clear is. When it fails,
    // the classifier must still return a destructive intent that reads UNKNOWN — never
    // null ("not destructive"), which would hide the act from honest reporting. But a
    // clear is reversible, so an uncountable one is NOT refused: undo is the safety net,
    // and the size the count could not establish would only ever have governed a wall
    // that no longer applies to reversible acts.
    const real = db.boundedCount.bind(db);
    (db as unknown as { boundedCount: unknown }).boundedCount = () =>
      Promise.reject(new Error('count exploded'));
    try {
      // Classified, and honest that it could not measure itself.
      const intent = await destructiveIntent(ctx, 'bulk_update', {
        table: 'notes',
        set: { body: null },
      });
      expect(intent).not.toBeNull();
      expect(intent?.rowsUnknown).toBe(true);
      expect(intent?.reversible).toBe(true);
      expect(intent?.detail).toContain('record count unknown');

      // ...and it proceeds rather than being refused.
      const r = await executeFunction(
        ctx,
        'bulk_update',
        { table: 'notes', set: { body: null } },
        new TurnOutcomeLedger(),
      );
      expect(r.ok).toBe(true);
      expect(r.error ?? '').not.toContain('REFUSED');
    } finally {
      (db as unknown as { boundedCount: unknown }).boundedCount = real;
    }
    // Every record really was cleared — the clear ran in full.
    const wiped = (await db.query('notes', { filters: [{ col: 'body', op: 'isNull' }] })).length;
    expect(wiped).toBe(2 * NOTE_HALF + 1);
  });

  // ── 4. no model prose in the sentence, and no fake columns ──────────────────

  it('classifies nothing when a delete_row names something that is not a record', async () => {
    // An id that names no record destroys nothing — and it is unvalidated model text,
    // so this is also what keeps a sentence from being read out as a record's name.
    const intent = await destructiveIntent(ctx, 'delete_row', { table: 'notes', id: PROSE_ID });
    expect(intent).toBeNull();
  });

  it('keeps a sentence out of the refusal even when it really is a record’s id', async () => {
    // The record exists, so this call genuinely destroys something and there IS a
    // sentence. What must not happen is the prose being read out as the record's name,
    // which is what interpolating `args.id` did.
    const intent = await destructiveIntent(ctx, 'delete_row', {
      table: 'notes',
      id: PROSE_ROW_ID,
    });
    expect(intent).not.toBeNull();
    expect(intent?.detail).not.toContain('SAFE: a scratch copy');
    expect(intent?.detail).not.toContain('nothing real is lost');
    // The user is still told, truthfully, what is at stake.
    expect(intent?.detail).toMatch(/1 record/);
    expect(intent?.detail).toContain('"notes"');
  });

  it('names a real record, so a refusal points at the right one', async () => {
    const intent = await destructiveIntent(ctx, 'delete_row', {
      table: 'notes',
      id: 'n_archived_0',
    });
    expect(intent?.detail).toContain('n_archived_0');
  });

  it('does not accept Object.prototype names as columns of the table', async () => {
    // `'constructor' in cols` is true for every plain object, so a set of prototype
    // names read as a real destructive clear.
    const intent = await destructiveIntent(ctx, 'bulk_update', {
      table: 'notes',
      set: { constructor: null, toString: '' },
    });
    expect(intent).toBeNull();

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
