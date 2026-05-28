import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { applySchemaSpec, type SchemaSpec } from '../../src/teams/schema-spec.js';

/**
 * Regression: a joined team member who refreshed saw NONE of the shared tables.
 * Cause — applying a cloud schema that adds a NOT NULL column (no default) to an
 * already-existing local table threw "Cannot add a NOT NULL column with default
 * value NULL"; that non-conflict error aborted the whole shared-schema sync, so
 * the member got zero tables. ADD COLUMN must add such columns nullable.
 */
describe('applySchemaSpec — additive ADD COLUMN safety', () => {
  let tmpDir: string;
  let db: Lattice;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-add-col-'));
    db = new Lattice(join(tmpDir, 't.db'));
    db.define('shared', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: () => '',
      outputFile: 'shared.md',
    });
    await db.init();
    await db.insert('shared', { id: 'r1', name: 'Row' }); // non-empty: worst case for ADD COLUMN
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds a cloud-only NOT NULL column (no default) without throwing', async () => {
    const spec: SchemaSpec = {
      columns: {
        id: { type: 'TEXT', pk: true },
        name: { type: 'TEXT' },
        status: { type: 'TEXT', notNull: true },
      },
      primaryKey: 'id',
      schemaVersion: 2,
    };
    const changed = await applySchemaSpec(db, 'shared', spec);
    expect(changed).toBe(true);
    const rows = (await db.query('shared', {})) as Record<string, unknown>[];
    expect(rows.length).toBe(1); // existing row intact
    expect('status' in (rows[0] ?? {})).toBe(true); // new column present
  });

  it('preserves NOT NULL when the cloud column carries a default', async () => {
    const spec: SchemaSpec = {
      columns: {
        id: { type: 'TEXT', pk: true },
        name: { type: 'TEXT' },
        kind: { type: 'TEXT', notNull: true, default: "'x'" },
      },
      primaryKey: 'id',
      schemaVersion: 2,
    };
    await expect(applySchemaSpec(db, 'shared', spec)).resolves.toBe(true);
  });
});
