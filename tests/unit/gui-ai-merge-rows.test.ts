import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { executeFunction, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { findTableDuplicates, type DedupServiceCtx } from '../../src/gui/dedup-service.js';

/**
 * The `merge_rows` tool: a targeted, reference-safe consolidation the assistant can call to
 * combine rows the USER identified as the same — including rows a similarity pass would NOT
 * group (e.g. "Acme", "Acme Inc", "Acme Corp"). Regression for the consolidation that
 * soft-deleted duplicates but left their file/junction links dangling (and then the assistant
 * claimed success). merge_rows must re-point every reference onto the survivor, soft-delete the
 * duplicates, and return the TRUE counts.
 */
describe('merge_rows tool — targeted, reference-safe consolidation', () => {
  let root: string;
  let db: Lattice;
  let feed: FeedBus;
  let ctx: DispatchCtx;
  let configPath: string;
  let outputDir: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lattice-merge-rows-'));
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
        '',
      ].join('\n'),
    );
    db = new Lattice({ config: configPath }, { encryptionKey: 'merge-rows-test-key' });
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
        // `buildAuditRow` ALWAYS writes these two. Omitting them here makes every
        // session-scoped filter match zero rows, so an undo test would pass while
        // reporting nothing to undo — green for the wrong reason, which is the exact
        // failure shape these tests exist to catch.
        session_id: 'TEXT',
        source: 'TEXT',
      },
      render: () => '',
      outputFile: '.lattice-gui/audit.md',
    });
    await db.init();
    feed = new FeedBus();
    ctx = {
      db,
      feed,
      validTables: new Set(['companies', 'files', 'files_companies']),
      junctionTables: new Set(['files_companies']),
      softDeletable: new Set(['companies', 'files']),
      configPath,
      outputDir,
      sessionId: 'sess-1',
    };
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('relinks references onto the survivor and soft-deletes the duplicates', async () => {
    // One real company, plus two differently-NAMED duplicates the user says are the same.
    await db.insert('companies', { id: 'c1', name: 'Acme', created_at: '2026-01-01T00:00:00Z' });
    await db.insert('companies', {
      id: 'c2',
      name: 'Acme Inc',
      created_at: '2026-01-02T00:00:00Z',
    });
    await db.insert('companies', {
      id: 'c3',
      name: 'Acme Corp',
      created_at: '2026-01-03T00:00:00Z',
    });
    // A file linked to EACH duplicate (not the survivor).
    await db.insert('files', { id: 'f1', name: 'deck.pdf' });
    await db.insert('files', { id: 'f2', name: 'memo.pdf' });
    await db.insert('files_companies', { id: 'l1', file_id: 'f1', companies_id: 'c2' });
    await db.insert('files_companies', { id: 'l2', file_id: 'f2', companies_id: 'c3' });

    // A similarity pass would NOT group these (distinct names) — proving why the explicit
    // merge_rows tool is needed over the automatic `dedup`.
    const dedupCtx: DedupServiceCtx = {
      db,
      feed,
      softDeletable: ctx.softDeletable,
      configPath,
      outputDir,
    };
    expect(await findTableDuplicates(dedupCtx, 'companies', {})).toHaveLength(0);

    const res = await executeFunction(ctx, 'merge_rows', {
      table: 'companies',
      survivor_id: 'c1',
      duplicate_ids: ['c2', 'c3'],
    });

    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ rowsMerged: 2, referencesRelinked: 2, survivor: 'c1' });

    // The duplicates are soft-deleted; the survivor stays live.
    expect((await db.get('companies', 'c2'))?.deleted_at).toBeTruthy();
    expect((await db.get('companies', 'c3'))?.deleted_at).toBeTruthy();
    expect((await db.get('companies', 'c1'))?.deleted_at).toBeFalsy();

    // Both file links now point at the survivor — none left dangling on a deleted company.
    // (Filter in JS: the source edges are removed by the merge, so what remains are the two
    // survivor edges.)
    const links = (await db.query('files_companies', {})).filter((l) => !l.deleted_at);
    const survivorLinks = links.filter((l) => l.companies_id === 'c1');
    expect(survivorLinks).toHaveLength(2);
    expect(links.some((l) => l.companies_id === 'c2' || l.companies_id === 'c3')).toBe(false);
  });

  it('rejects an empty duplicate list rather than pretending success', async () => {
    await db.insert('companies', { id: 'c1', name: 'Acme', created_at: '2026-01-01T00:00:00Z' });
    const res = await executeFunction(ctx, 'merge_rows', {
      table: 'companies',
      survivor_id: 'c1',
      duplicate_ids: [],
    });
    expect(res.ok).toBe(false);
  });

  /**
   * The merge writes through the audit log, so it must be stamped with the SAME GUI
   * session as every other assistant write. Unstamped, two things go wrong, and the
   * ledger's "you can undo these changes" offer is a false promise either way:
   *
   *   1. `undoLast` filters by session, so it cannot SEE the merge — the assistant's
   *      own `undo`, immediately after its own `merge_rows`, answers "Nothing to undo".
   *   2. Worse: `appendAudit` opens with `purgeRedoStack(db, sessionId)`, and
   *      `sessionUndoneFilters` omits the session filter entirely when the id is
   *      undefined — so every audited step of an unstamped merge issues a GLOBAL redo
   *      DELETE, destroying redo history belonging to other sessions (and, on a cloud,
   *      other members).
   */
  it('stamps the merge with the caller session, so undo can see it', async () => {
    await db.insert('companies', { id: 'c1', name: 'Acme', created_at: '2026-01-01T00:00:00Z' });
    await db.insert('companies', {
      id: 'c2',
      name: 'Acme Inc',
      created_at: '2026-01-02T00:00:00Z',
    });

    const merged = await executeFunction(ctx, 'merge_rows', {
      table: 'companies',
      survivor_id: 'c1',
      duplicate_ids: ['c2'],
    });
    expect(merged.ok).toBe(true);
    expect((await db.get('companies', 'c2'))?.deleted_at).toBeTruthy();

    // Every audit row the merge wrote carries the session — this is what both the
    // undo filter and the redo purge key on.
    const audit = (await db.query('_lattice_gui_audit', {})) as { session_id?: unknown }[];
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((a) => a.session_id === 'sess-1')).toBe(true);

    // ...so the assistant's own undo finds it rather than reporting nothing to undo.
    const undone = await executeFunction(ctx, 'undo', {});
    expect(undone.ok).toBe(true);
    expect((await db.get('companies', 'c2'))?.deleted_at).toBeFalsy();
  });
});
