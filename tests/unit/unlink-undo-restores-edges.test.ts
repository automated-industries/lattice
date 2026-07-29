import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { destructiveIntent, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import {
  linkRows,
  unlinkRows,
  undoLast,
  undoGroup,
  type MutationCtx,
} from '../../src/gui/mutations.js';
import { mergeDuplicates, type DedupServiceCtx } from '../../src/gui/dedup-service.js';

/**
 * Undoing an unlink must RE-LINK the removed edge — not silently do nothing.
 *
 * The removed edge is recorded in the audit entry's `before` image (an unlink has
 * no `after` — the row is gone). So the inverse of an unlink has to re-link from
 * `before`, exactly as the inverse of a delete re-inserts from `before`. Reading
 * the (always-null) `after` instead made undo a no-op that flipped the entry to
 * "undone" and reported success while restoring nothing — a false promise the whole
 * "an unlink is reversible, undo re-links it" contract rests on. These tests assert
 * the edge really comes back, through both undo paths (`undoLast` and `undoGroup`),
 * and that a merge (which unlinks the loser's edges internally) round-trips whole.
 */
describe('undo of an unlink restores the removed edge', () => {
  let root: string;
  let db: Lattice;
  let feed: FeedBus;
  let ctx: DispatchCtx;
  let configPath: string;
  let outputDir: string;

  /** The canonical MutationCtx a GUI request builds for this session. */
  function mctx(overrides: Partial<MutationCtx> = {}): MutationCtx {
    return {
      db,
      feed,
      softDeletable: new Set(['companies', 'files']),
      source: 'gui',
      sessionId: 'sess-1',
      ...overrides,
    };
  }

  async function liveLinks(): Promise<Record<string, unknown>[]> {
    return (await db.query('files_companies', {})) as Record<string, unknown>[];
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lattice-unlink-undo-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    configPath = join(root, 'lattice.config.yml');
    outputDir = join(root, 'context');
    writeFileSync(
      configPath,
      [
        'db: ./data/test.db',
        '',
        'entities:',
        '  companies:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '      created_at: { type: timestamp }',
        '      deleted_at: { type: timestamp }',
        '    outputFile: companies.md',
        '  files:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '      deleted_at: { type: timestamp }',
        '    outputFile: files.md',
        '  files_companies:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      file_id: { type: uuid }',
        '      companies_id: { type: uuid }',
        '    relations:',
        '      file: { type: belongsTo, table: files, foreignKey: file_id }',
        '      company: { type: belongsTo, table: companies, foreignKey: companies_id }',
        '    outputFile: files-companies.md',
        // A table with NO deleted_at column — a merge here HARD-removes the loser
        // (no trash), so its classification must not claim trash-recoverability.
        '  imported:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '    outputFile: imported.md',
        '',
      ].join('\n'),
    );
    db = new Lattice({ config: configPath }, { encryptionKey: 'unlink-undo-test-key' });
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
        session_id: 'TEXT',
        source: 'TEXT',
        op_group: 'TEXT',
      },
      render: () => '',
      outputFile: '.lattice-gui/audit.md',
    });
    await db.init();
    feed = new FeedBus();
    ctx = {
      db,
      feed,
      validTables: new Set(['companies', 'files', 'files_companies', 'imported']),
      junctionTables: new Set(['files_companies']),
      softDeletable: new Set(['companies', 'files']),
      configPath,
      outputDir,
      sessionId: 'sess-1',
    };
    await db.insert('companies', { id: 'c1', name: 'Acme', created_at: '2026-01-01T00:00:00Z' });
    await db.insert('companies', {
      id: 'c2',
      name: 'Acme Inc',
      created_at: '2026-01-02T00:00:00Z',
    });
    await db.insert('files', { id: 'f1', name: 'deck.pdf' });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('undoLast re-links the edge a single unlink removed', async () => {
    await linkRows(mctx(), 'files_companies', { id: 'l1', file_id: 'f1', companies_id: 'c1' });
    expect(await liveLinks()).toHaveLength(1);

    await unlinkRows(mctx(), 'files_companies', { file_id: 'f1', companies_id: 'c1' });
    expect(await liveLinks()).toHaveLength(0);

    // The bug: undoLast flips the entry to "undone" and reports success, but the
    // edge is NOT put back — the inverse read the (null) `after` instead of `before`.
    const reverted = await undoLast(mctx());
    expect(reverted?.operation).toBe('unlink');
    const links = await liveLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ file_id: 'f1', companies_id: 'c1' });
  });

  it('undoGroup re-links the edge a grouped unlink removed', async () => {
    const group = 'grp-1';
    await linkRows(mctx({ opGroup: group }), 'files_companies', {
      id: 'l1',
      file_id: 'f1',
      companies_id: 'c1',
    });
    await unlinkRows(mctx({ opGroup: group }), 'files_companies', {
      file_id: 'f1',
      companies_id: 'c1',
    });
    expect(await liveLinks()).toHaveLength(0);

    // Undo the whole group: it reverses the unlink (re-link) AND the link (unlink).
    // Net: back to zero live edges — but crucially the unlink's inverse is a real
    // re-link, not a no-op, which the per-step audit proves.
    const out = await undoGroup(mctx(), group);
    expect(out.ok).toBe(true);

    // Every entry in the group is now flagged undone (nothing was silently skipped).
    const entries = (await db.query('_lattice_gui_audit', {
      filters: [{ col: 'op_group', op: 'eq', val: group }],
    })) as Record<string, unknown>[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => Number(e.undone) === 1)).toBe(true);
  });

  it('undoGroup restores EVERY edge of a wide unlink, not a silent no-op', async () => {
    // A wide unlink: many edges removed under ONE operation group (exactly the shape a
    // merge/bulk unlink produces). Each unlink fully specifies its edge, so `before`
    // records the whole row and the inverse can re-link it. With the bug, undoGroup
    // flips all entries to "undone" and reports success while restoring NONE.
    const group = 'grp-wide';
    const N = 5;
    for (let i = 0; i < N; i++) {
      await db.insert('files', { id: `wf${String(i)}`, name: `f${String(i)}.pdf` });
      await linkRows(mctx({ opGroup: `seed-${String(i)}` }), 'files_companies', {
        id: `wl${String(i)}`,
        file_id: `wf${String(i)}`,
        companies_id: 'c1',
      });
    }
    expect(await liveLinks()).toHaveLength(N);

    // Remove all N edges, each as its own fully-specified unlink, under one group.
    for (let i = 0; i < N; i++) {
      await unlinkRows(mctx({ opGroup: group }), 'files_companies', {
        file_id: `wf${String(i)}`,
        companies_id: 'c1',
      });
    }
    expect(await liveLinks()).toHaveLength(0);

    const out = await undoGroup(mctx(), group);
    expect(out).toMatchObject({ ok: true, undone: N });

    // ALL N edges are back — the group undo re-linked every one, not zero.
    const restored = await liveLinks();
    expect(restored).toHaveLength(N);
    const pairs = restored.map((l) => `${String(l.file_id)}→${String(l.companies_id)}`).sort();
    expect(pairs).toEqual(Array.from({ length: N }, (_, i) => `wf${String(i)}→c1`).sort());
  });

  it('undoGroup restores EVERY edge a PARTIAL-CONDITION unlink removed', async () => {
    // The load-bearing case the single-condition recording could not handle: ONE unlink
    // call with a PARTIAL condition (just the hub key) is a SET delete — `DELETE FROM t
    // WHERE companies_id = ?` — that cuts EVERY edge of the hub in one statement.
    // Recording only that condition let undo re-link a single partial row, not the N
    // specific edges actually removed. The fix captures each matched edge, so undoGroup
    // re-links all N.
    const group = 'grp-partial';
    const N = 4;
    for (let i = 0; i < N; i++) {
      await db.insert('files', { id: `pf${String(i)}`, name: `p${String(i)}.pdf` });
      await linkRows(mctx({ opGroup: `seed-p-${String(i)}` }), 'files_companies', {
        id: `pl${String(i)}`,
        file_id: `pf${String(i)}`,
        companies_id: 'c1',
      });
    }
    expect(await liveLinks()).toHaveLength(N);

    // ONE unlink, a PARTIAL condition (only the hub key) — removes all N of c1's edges
    // in a single SET delete.
    await unlinkRows(mctx({ opGroup: group }), 'files_companies', { companies_id: 'c1' });
    expect(await liveLinks()).toHaveLength(0);

    // With the old single-condition recording, exactly ONE audit entry exists for the
    // whole cut (before = { companies_id }), so the group holds one entry and undo puts
    // back at most one partial row — undone === 1, not N. The fix writes one entry PER
    // removed edge, so undoGroup reverses N and re-links every specific edge.
    const out = await undoGroup(mctx(), group);
    expect(out).toMatchObject({ ok: true, undone: N });

    const restored = await liveLinks();
    expect(restored).toHaveLength(N);
    const pairs = restored.map((l) => `${String(l.file_id)}→${String(l.companies_id)}`).sort();
    expect(pairs).toEqual(Array.from({ length: N }, (_, i) => `pf${String(i)}→c1`).sort());
  });

  it('undo of a merge restores the loser row AND its original links', async () => {
    // c2 has a file linked to it; merge c2 into c1. The merge re-points the edge onto
    // c1 (link), drops c2's edge (unlink), and soft-deletes c2 (update). Undoing the
    // whole group must restore c2 AND put its edge back — the unlink inverse is the
    // load-bearing step that the bug broke.
    await db.insert('files_companies', { id: 'l1', file_id: 'f1', companies_id: 'c2' });

    const opGroup = 'merge-grp';
    const svc: DedupServiceCtx = {
      db,
      feed,
      softDeletable: ctx.softDeletable,
      configPath,
      outputDir,
      sessionId: 'sess-1',
      opGroup,
    };
    const r = await mergeDuplicates(svc, 'companies', 'c1', ['c2']);
    expect(r).toMatchObject({ merged: 1, relinked: 1 });

    // Post-merge: c2 is soft-deleted and the edge points at the survivor c1.
    expect((await db.get('companies', 'c2'))?.deleted_at).toBeTruthy();
    const afterMerge = (await liveLinks()).filter((l) => !l.deleted_at);
    expect(afterMerge.filter((l) => l.companies_id === 'c1')).toHaveLength(1);
    expect(afterMerge.some((l) => l.companies_id === 'c2')).toBe(false);

    const out = await undoGroup(mctx(), opGroup);
    expect(out.ok).toBe(true);

    // The loser is live again...
    expect((await db.get('companies', 'c2'))?.deleted_at).toBeFalsy();
    // ...its original edge is back on c2 (the unlink inverse re-linked it)...
    const restored = (await liveLinks()).filter((l) => !l.deleted_at);
    expect(restored.some((l) => l.file_id === 'f1' && l.companies_id === 'c2')).toBe(true);
    // ...and the survivor's merge-added edge is gone again (the link inverse unlinked it).
    expect(restored.some((l) => l.file_id === 'f1' && l.companies_id === 'c1')).toBe(false);
  });

  it('undo of a link still removes it (the link inverse is unchanged)', async () => {
    await linkRows(mctx(), 'files_companies', { id: 'l1', file_id: 'f1', companies_id: 'c1' });
    expect(await liveLinks()).toHaveLength(1);
    const reverted = await undoLast(mctx());
    expect(reverted?.operation).toBe('link');
    expect(await liveLinks()).toHaveLength(0);
  });

  // ── merge/dedup must not claim trash-recoverability for a HARD delete ──────────

  it('classifies a merge on a soft-deletable object as reversible, and says trash', async () => {
    await db.insert('companies', {
      id: 'c3',
      name: 'Acme Corp',
      created_at: '2026-01-03T00:00:00Z',
    });
    const intent = await destructiveIntent(ctx, 'merge_rows', {
      table: 'companies',
      survivor_id: 'c1',
      duplicate_ids: ['c2', 'c3'],
    });
    expect(intent).not.toBeNull();
    expect(intent?.reversible).toBe(true);
    expect(intent?.detail).toMatch(/trash \(recoverable\)/i);
  });

  it('classifies a merge on a NON-soft-deletable object as irreversible, and never says trash', async () => {
    // `imported` has no deleted_at, so the merge HARD-deletes the loser. Claiming
    // "recoverable from the trash" here is a false statement — the loser is gone.
    await db.insert('imported', { id: 'i1', name: 'row one' });
    await db.insert('imported', { id: 'i2', name: 'row two' });
    const intent = await destructiveIntent(ctx, 'merge_rows', {
      table: 'imported',
      survivor_id: 'i1',
      duplicate_ids: ['i2'],
    });
    expect(intent).not.toBeNull();
    expect(intent?.reversible).toBe(false);
    // No false promise of recoverability. Saying "this object has no trash" is honest
    // (and the word "trash" appears there); the claim we must never make is that the
    // hard-deleted loser is RECOVERABLE.
    expect(intent?.detail).not.toMatch(/recoverable/i);
    expect(intent?.detail).toMatch(/permanent/i);
  });

  it('classifies a dedup on a NON-soft-deletable object as irreversible, and never says trash', async () => {
    await db.insert('imported', { id: 'i1', name: 'dupe' });
    await db.insert('imported', { id: 'i2', name: 'dupe' });
    const intent = await destructiveIntent(ctx, 'dedup', { table: 'imported', fuzzy: false });
    expect(intent).not.toBeNull();
    expect(intent?.reversible).toBe(false);
    expect(intent?.detail).not.toMatch(/recoverable/i);
    expect(intent?.detail).toMatch(/permanent/i);
  });

  it('classifies a dedup on a soft-deletable object as reversible, and says trash', async () => {
    const intent = await destructiveIntent(ctx, 'dedup', { table: 'companies', fuzzy: false });
    expect(intent).not.toBeNull();
    expect(intent?.reversible).toBe(true);
    expect(intent?.detail).toMatch(/trash \(recoverable\)/i);
  });

  // ── the negatives still hold ──────────────────────────────────────────────────

  it('still refuses an irreversible object delete (delete_data), and never prompts for consent', async () => {
    const intent = await destructiveIntent(ctx, 'delete_entity', {
      name: 'companies',
      resolution: 'delete_data',
    });
    expect(intent?.reversible).toBe(false);
  });
});
