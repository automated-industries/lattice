import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import { executeFunction, DISPATCHABLE, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { getFunction } from '../../src/gui/ai/registry.js';

/**
 * The `import_spreadsheet` tool: faithfully materialize an attached spreadsheet's rows via
 * the deterministic importer (the fix for a workbook collapsing to a lossy 3-row LLM
 * summary). The handler delegates to a `ctx.importAttachment(fileId)` closure — stubbed
 * here so the handler contract is tested without a real file/model.
 */
describe('import_spreadsheet tool', () => {
  let tmpDir: string;
  let db: Lattice;
  let feed: FeedBus;
  let base: Omit<DispatchCtx, 'importAttachment'>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-importss-'));
    db = new Lattice(join(tmpDir, 'test.db'), { encryptionKey: 'importss-test-key' });
    registerNativeEntities(db);
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
    feed = new FeedBus();
    base = {
      db,
      feed,
      validTables: new Set(['files']),
      junctionTables: new Set(),
      softDeletable: new Set(['files']),
    };
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is registered as a dispatchable, mutating row tool requiring file_id', () => {
    const fn = getFunction('import_spreadsheet');
    expect(fn?.mutates).toBe(true);
    expect(fn?.category).toBe('row');
    expect(fn?.args.required).toEqual(['file_id']);
    expect(DISPATCHABLE.has('import_spreadsheet')).toBe(true);
  });

  it('imports the attachment and reports the tables + row count, signalling the change', async () => {
    const events: FeedEvent[] = [];
    feed.subscribe((e) => events.push(e));
    const ctx: DispatchCtx = {
      ...base,
      importAttachment: (fileId: string) => {
        expect(fileId).toBe('f-123');
        return Promise.resolve({ tables: ['new', 'ups', 'churn', 'down'], rows: 53 });
      },
    };
    const res = await executeFunction(ctx, 'import_spreadsheet', { file_id: 'f-123' });
    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ rows: 53 });
    expect((res.result as { tables: string[] }).tables).toHaveLength(4);
    // The workspace is told data changed so the new tables/rows appear live.
    expect(events.some((e) => e.op === 'insert' && e.source === 'ai')).toBe(true);
  });

  it('fails cleanly (ok:false) when the file has no importable tabular data', async () => {
    const ctx: DispatchCtx = { ...base, importAttachment: () => Promise.resolve(null) };
    const res = await executeFunction(ctx, 'import_spreadsheet', { file_id: 'f-x' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/spreadsheet|no rows|ingest_text/i);
  });

  it('surfaces the real error when the file can’t be read', async () => {
    const ctx: DispatchCtx = {
      ...base,
      importAttachment: () => Promise.reject(new Error('Unknown import file: f-gone')),
    };
    const res = await executeFunction(ctx, 'import_spreadsheet', { file_id: 'f-gone' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('Unknown import file');
  });

  it('reports unavailable when no import closure is wired', async () => {
    const res = await executeFunction(base as DispatchCtx, 'import_spreadsheet', {
      file_id: 'f-1',
    });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/unavailable/i);
  });

  it('rejects a missing file_id', async () => {
    const ctx: DispatchCtx = { ...base, importAttachment: () => Promise.resolve(null) };
    expect((await executeFunction(ctx, 'import_spreadsheet', {})).ok).toBe(false);
  });
});
