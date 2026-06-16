import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import { executeFunction, DISPATCHABLE, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { getFunction } from '../../src/gui/ai/registry.js';

describe('set_definition + dedup assistant tools', () => {
  let root: string;
  let db: Lattice;
  let ctx: DispatchCtx;
  let configPath: string;
  let outputDir: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lattice-defs-dispatch-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    configPath = join(root, 'lattice.config.yml');
    outputDir = join(root, 'context');
    writeFileSync(
      configPath,
      [
        'db: ./data/test.db',
        '',
        'entities:',
        '  widgets:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      sku: { type: text }',
        '    outputFile: widgets.md',
        '',
      ].join('\n'),
    );
    db = new Lattice({ config: configPath }, { encryptionKey: 'defs-dispatch-key' });
    registerNativeEntities(db);
    db.define('_lattice_gui_meta', {
      columns: {
        entity_name: 'TEXT PRIMARY KEY',
        icon: 'TEXT',
        description: 'TEXT',
        updated_at: "TEXT DEFAULT (datetime('now'))",
      },
      primaryKey: 'entity_name',
      render: () => '',
      outputFile: '.lattice-gui/meta.md',
    });
    db.define('_lattice_gui_column_meta', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        table_name: 'TEXT NOT NULL',
        column_name: 'TEXT NOT NULL',
        secret: 'INTEGER NOT NULL DEFAULT 0',
        description: 'TEXT',
        updated_at: "TEXT DEFAULT (datetime('now'))",
      },
      render: () => '',
      outputFile: '.lattice-gui/column-meta.md',
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
    ctx = {
      db,
      feed: new FeedBus(),
      validTables: new Set(['widgets', 'files']),
      junctionTables: new Set(),
      softDeletable: new Set(['widgets', 'files']),
      configPath,
      outputDir,
    };
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('registers set_definition + dedup as dispatchable mutating tools', () => {
    const sd = getFunction('set_definition');
    expect(sd?.mutates).toBe(true);
    expect(sd?.category).toBe('schema');
    expect(sd?.args.required).toEqual(expect.arrayContaining(['table', 'description']));
    expect(DISPATCHABLE.has('set_definition')).toBe(true);

    const dd = getFunction('dedup');
    expect(dd?.mutates).toBe(true);
    expect(dd?.category).toBe('row');
    expect(DISPATCHABLE.has('dedup')).toBe(true);

    const sv = getFunction('set_visibility');
    expect(sv?.mutates).toBe(true);
    expect(sv?.args.required).toEqual(expect.arrayContaining(['table', 'visibility']));
    expect(DISPATCHABLE.has('set_visibility')).toBe(true);
  });

  it('set_visibility rejects a bad visibility, and reports cloud-only on local SQLite', async () => {
    expect(
      (await executeFunction(ctx, 'set_visibility', { table: 'widgets', visibility: 'nope' })).ok,
    ).toBe(false);
    // On a local (SQLite) workspace sharing doesn't apply — a clean, non-technical
    // error, not a thrown DB exception.
    const res = await executeFunction(ctx, 'set_visibility', {
      table: 'widgets',
      visibility: 'private',
    });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/cloud/i);
  });

  it('set_definition writes a COLUMN definition when column is present', async () => {
    const res = await executeFunction(ctx, 'set_definition', {
      table: 'widgets',
      column: 'sku',
      description: 'Stock-keeping unit',
    });
    expect(res.ok).toBe(true);
    const rows = (await db.query('_lattice_gui_column_meta', {
      filters: [
        { col: 'table_name', op: 'eq', val: 'widgets' },
        { col: 'column_name', op: 'eq', val: 'sku' },
      ],
    })) as { description: string | null }[];
    expect(rows[0]?.description).toBe('Stock-keeping unit');
  });

  it('set_definition writes a TABLE definition when column is absent', async () => {
    const res = await executeFunction(ctx, 'set_definition', {
      table: 'widgets',
      description: 'A catalog of widgets',
    });
    expect(res.ok).toBe(true);
    const row = (await db.get('_lattice_gui_meta', 'widgets')) as {
      description: string | null;
    } | null;
    expect(row?.description).toBe('A catalog of widgets');
  });

  it('dedup merges byte-identical files onto the oldest and reports the merge', async () => {
    const events: FeedEvent[] = [];
    ctx.feed.subscribe((e) => events.push(e));
    await db.insert('files', {
      id: 'f1',
      original_name: 'a.txt',
      mime: 'text/plain',
      sha256: 'DUPHASH',
      extracted_text: 'dup',
      extraction_status: 'extracted',
      created_at: '2026-01-01T00:00:00Z',
    });
    await db.insert('files', {
      id: 'f2',
      original_name: 'a-copy.txt',
      mime: 'text/plain',
      sha256: 'DUPHASH',
      extracted_text: 'dup',
      extraction_status: 'extracted',
      created_at: '2026-01-02T00:00:00Z',
    });

    const res = await executeFunction(ctx, 'dedup', { table: 'files' });
    expect(res.ok).toBe(true);
    const result = res.result as { table: string; duplicateGroups: number; rowsMerged: number };
    expect(result.duplicateGroups).toBe(1);
    expect(result.rowsMerged).toBe(1);

    // Oldest (f1) survives; the newer copy (f2) is soft-deleted.
    expect((await db.get('files', 'f1')) as Record<string, unknown>).toBeTruthy();
    const f2 = (await db.get('files', 'f2')) as { deleted_at?: string | null } | null;
    expect(f2?.deleted_at).toBeTruthy();
    expect(events.some((e) => e.source === 'system' && e.table === 'files')).toBe(true);
  });
});
