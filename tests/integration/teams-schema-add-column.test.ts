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

/**
 * Regression: on a direct-Postgres team every member shares the SAME physical
 * database, so a shared table ALWAYS physically exists for the member. The
 * previous applySchemaSpec only registered (defineLate) a table when it did NOT
 * physically exist (introspectColumns returned 0 columns), so the member's
 * Lattice never learned about the shared table — it stayed out of
 * getRegisteredTableNames → validTables → /api/entities, and the member saw an
 * empty workspace even though the owner had shared a table.
 */
describe('applySchemaSpec — registers an existing-but-unregistered shared table', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-shared-vis-'));
    file = join(tmpDir, 't.db');
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers a physically-existing table not declared in this Lattice instance', async () => {
    // Owner creates + populates the table (the physical shared table).
    const owner = new Lattice(file);
    owner.define('people', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: () => '',
      outputFile: 'people.md',
    });
    await owner.init();
    await owner.insert('people', { id: 'p1', name: 'Alice' });
    owner.close();

    // Member opens the SAME physical DB WITHOUT declaring 'people' — it exists
    // physically but is not registered in this Lattice instance (the member's case).
    const member = new Lattice(file);
    await member.init();
    expect(member.getRegisteredTableNames()).not.toContain('people');

    const spec: SchemaSpec = {
      columns: { id: { type: 'TEXT', pk: true }, name: { type: 'TEXT' } },
      primaryKey: 'id',
      schemaVersion: 1,
    };
    const changed = await applySchemaSpec(member, 'people', spec);

    // Now registered (so it reaches validTables/entities) and reported as a change.
    expect(changed).toBe(true);
    expect(member.getRegisteredTableNames()).toContain('people');
    // Non-destructive: the owner's row is intact.
    const rows = (await member.query('people', {})) as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe('Alice');
    member.close();
  });
});
