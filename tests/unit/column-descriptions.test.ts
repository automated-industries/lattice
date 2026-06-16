import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import {
  resolveColumnDescription,
  resolveTableDescription,
  builtinColumnDescription,
  builtinTableDescription,
  upsertColumnMeta,
  upsertTableMeta,
  generateAndStoreColumnDescriptions,
  generateAndStoreTableDescription,
} from '../../src/gui/column-descriptions.js';
import type { LlmClient } from '../../src/gui/ai/chat.js';

/** Minimal meta-table fixtures matching server.ts's openConfig defines. */
function defineMeta(db: Lattice): void {
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
  // A user table the auto-generators are allowed to touch.
  db.define('widgets', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      sku: 'TEXT',
      gross_weight: 'TEXT',
      created_at: "TEXT DEFAULT (datetime('now'))",
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: 'widgets.md',
  });
}

/** A fake LlmClient that returns a canned reply and counts calls. */
function fakeClient(reply: string): LlmClient & { calls: number } {
  const c = {
    calls: 0,
    runTurn() {
      c.calls += 1;
      return Promise.resolve({ stopReason: 'end_turn', text: reply, toolUses: [] });
    },
  };
  return c as unknown as LlmClient & { calls: number };
}

describe('column + table definitions', () => {
  let tmpDir: string;
  let db: Lattice;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-defs-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    defineMeta(db);
    await db.init();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('built-ins + resolution', () => {
    it('resolves native-entity column built-ins', () => {
      expect(builtinColumnDescription('files', 'sha256')).toMatch(/SHA-256/);
      expect(resolveColumnDescription('files', 'mime')).toMatch(/MIME/);
      // System columns share a built-in across every table.
      expect(resolveColumnDescription('anything', 'created_at')).toMatch(/created/i);
      // Unknown user column → undefined (caller falls back to type/role).
      expect(resolveColumnDescription('widgets', 'sku')).toBeUndefined();
    });

    it('an authored value wins over the built-in; blank clears to built-in', () => {
      expect(resolveColumnDescription('files', 'mime', 'Custom note')).toBe('Custom note');
      expect(resolveColumnDescription('files', 'mime', '   ')).toMatch(/MIME/);
    });

    it('resolves table built-ins and honors authored override', () => {
      expect(builtinTableDescription('files')).toMatch(/files|documents/i);
      expect(resolveTableDescription('files')).toMatch(/files|documents/i);
      expect(resolveTableDescription('files', 'My docs')).toBe('My docs');
      expect(resolveTableDescription('widgets')).toBeUndefined();
    });
  });

  describe('upsertColumnMeta / upsertTableMeta (consolidated)', () => {
    it('inserts then updates a column meta row, applying only provided fields', async () => {
      await upsertColumnMeta(db, 'widgets', 'sku', { description: 'Stock-keeping unit' });
      let rows = (await db.query('_lattice_gui_column_meta', {
        filters: [
          { col: 'table_name', op: 'eq', val: 'widgets' },
          { col: 'column_name', op: 'eq', val: 'sku' },
        ],
      })) as { id: string; secret: number; description: string | null }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.description).toBe('Stock-keeping unit');
      expect(rows[0]?.secret).toBe(0);

      // A secret-only update must not wipe the description.
      await upsertColumnMeta(db, 'widgets', 'sku', { secret: 1 });
      rows = (await db.query('_lattice_gui_column_meta', {
        filters: [
          { col: 'table_name', op: 'eq', val: 'widgets' },
          { col: 'column_name', op: 'eq', val: 'sku' },
        ],
      })) as typeof rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.secret).toBe(1);
      expect(rows[0]?.description).toBe('Stock-keeping unit');

      // A blank description clears it (stored NULL).
      await upsertColumnMeta(db, 'widgets', 'sku', { description: '   ' });
      rows = (await db.query('_lattice_gui_column_meta', {
        filters: [
          { col: 'table_name', op: 'eq', val: 'widgets' },
          { col: 'column_name', op: 'eq', val: 'sku' },
        ],
      })) as typeof rows;
      expect(rows[0]?.description ?? null).toBeNull();
    });

    it('inserts then updates a table meta row keyed by entity_name', async () => {
      await upsertTableMeta(db, 'widgets', { description: 'Inventory widgets' });
      let row = (await db.get('_lattice_gui_meta', 'widgets')) as {
        icon: string | null;
        description: string | null;
      } | null;
      expect(row?.description).toBe('Inventory widgets');

      await upsertTableMeta(db, 'widgets', { icon: '🧩' });
      row = (await db.get('_lattice_gui_meta', 'widgets')) as typeof row;
      expect(row?.icon).toBe('🧩');
      // Icon-only update preserved the description.
      expect(row?.description).toBe('Inventory widgets');
    });
  });

  describe('auto-generation (fake LlmClient)', () => {
    it('no-ops when the client is null', async () => {
      await generateAndStoreColumnDescriptions(db, 'widgets', ['sku'], null);
      const rows = await db.query('_lattice_gui_column_meta', {});
      expect(rows).toHaveLength(0);
    });

    it('generates definitions for user columns, skipping system/built-in/authored', async () => {
      // Pre-author one column; the generator must not overwrite it.
      await upsertColumnMeta(db, 'widgets', 'sku', { description: 'authored' });
      const client = fakeClient(
        JSON.stringify({ sku: 'overwrite', gross_weight: 'Weight incl. packaging' }),
      );
      await generateAndStoreColumnDescriptions(
        db,
        'widgets',
        ['id', 'created_at', 'sku', 'gross_weight'],
        client,
      );
      // One batched call: id/created_at are system columns and sku already has an
      // authored value, so both are filtered out of the candidate set — only
      // gross_weight remains, which is enough to make the single Haiku call.
      expect(client.calls).toBe(1);
      const sku = (await db.query('_lattice_gui_column_meta', {
        filters: [
          { col: 'table_name', op: 'eq', val: 'widgets' },
          { col: 'column_name', op: 'eq', val: 'sku' },
        ],
      })) as { description: string | null }[];
      expect(sku[0]?.description).toBe('authored'); // not overwritten
      const gw = (await db.query('_lattice_gui_column_meta', {
        filters: [
          { col: 'table_name', op: 'eq', val: 'widgets' },
          { col: 'column_name', op: 'eq', val: 'gross_weight' },
        ],
      })) as { description: string | null }[];
      expect(gw[0]?.description).toBe('Weight incl. packaging');
    });

    it('skips native entities entirely (no model call)', async () => {
      const client = fakeClient('{}');
      await generateAndStoreColumnDescriptions(db, 'files', ['mime'], client);
      expect(client.calls).toBe(0);
    });

    it('is fail-silent when the model throws', async () => {
      const throwing = {
        runTurn() {
          return Promise.reject(new Error('model down'));
        },
      } as unknown as LlmClient;
      await expect(
        generateAndStoreColumnDescriptions(db, 'widgets', ['gross_weight'], throwing),
      ).resolves.toBeUndefined();
      expect(await db.query('_lattice_gui_column_meta', {})).toHaveLength(0);
    });

    it('generates a table definition and does not overwrite an authored one', async () => {
      const client = fakeClient('A line of widgets.');
      await generateAndStoreTableDescription(db, 'widgets', ['sku', 'gross_weight'], client);
      let row = (await db.get('_lattice_gui_meta', 'widgets')) as {
        description: string | null;
      } | null;
      expect(row?.description).toBe('A line of widgets.');

      // Authored value present → no model call, no overwrite.
      await upsertTableMeta(db, 'widgets', { description: 'Mine' });
      const client2 = fakeClient('Should not be used.');
      await generateAndStoreTableDescription(db, 'widgets', ['sku'], client2);
      expect(client2.calls).toBe(0);
      row = (await db.get('_lattice_gui_meta', 'widgets')) as typeof row;
      expect(row?.description).toBe('Mine');
    });

    it('skips native tables for table generation (no model call)', async () => {
      const client = fakeClient('nope');
      await generateAndStoreTableDescription(db, 'files', ['mime'], client);
      expect(client.calls).toBe(0);
    });
  });
});
