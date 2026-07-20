import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { propagateComputedFieldAudiences, audienceViewSql } from '../../src/cloud/audience.js';

/**
 * Security regression: a #10 computed field materializes into an ordinary physical column,
 * so a field derived from an owner-masked column would pass that column's value through the
 * cell-masking `<t>_v` view RAW (a member reads NULL for `salary` but the exact value through
 * `salary_copy`). The effective audience must fold the source column's mask onto the derived
 * column so it is masked too.
 */
describe('computed fields inherit their source column masking (cloud)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function peopleDb(): Lattice {
    const d = new Lattice(':memory:');
    d.define('people', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT',
        salary: 'INTEGER',
        salary_copy: 'INTEGER',
        high_earner: 'INTEGER',
      },
      computedFields: {
        salary_copy: { kind: 'alias', source: 'salary' },
        high_earner: { kind: 'calc', expr: 'salary >= 100000', type: 'boolean' },
      },
      render: () => '',
      outputFile: 'p.md',
    });
    return d;
  }

  it('a masked source column masks every field derived from it', async () => {
    db = peopleDb();
    await db.init();
    const eff = propagateComputedFieldAudiences(db, 'people', { salary: 'owner' });
    expect(eff.salary_copy).toBe('owner'); // alias of a masked column → masked
    expect(eff.high_earner).toBe('owner'); // calc over a masked column → masked
    expect(eff.name).toBeUndefined(); // independent column, untouched

    // The mask view wraps the derived columns in a CASE (no raw pass-through).
    const cols = ['id', 'name', 'salary', 'salary_copy', 'high_earner'];
    const sql = audienceViewSql('people', cols, ['id'], eff, 'members');
    expect(sql).toContain('THEN "salary_copy" END AS "salary_copy"');
    expect(sql).toContain('THEN "high_earner" END AS "high_earner"');
    // name is a plain pass-through (unmasked).
    expect(sql).toMatch(/(^|[ (])"name"([ ,)])/);
  });

  it('an explicit audience on the derived column wins over the inherited one', async () => {
    db = peopleDb();
    await db.init();
    // salary_copy already declared 'everyone' (row/default) — inheriting owner would be a
    // downgrade the operator did NOT ask for, so an EXPLICIT non-row audience is preserved…
    const eff = propagateComputedFieldAudiences(db, 'people', {
      salary: 'owner',
      high_earner: 'members', // explicit, more permissive than owner — kept as the operator set it
    });
    expect(eff.high_earner).toBe('members');
    expect(eff.salary_copy).toBe('owner'); // no explicit audience → inherits
  });

  it('no source masking → no derived masking (propagation is a no-op)', async () => {
    db = peopleDb();
    await db.init();
    const eff = propagateComputedFieldAudiences(db, 'people', {});
    expect(eff.salary_copy).toBeUndefined();
    expect(eff.high_earner).toBeUndefined();
  });
});
