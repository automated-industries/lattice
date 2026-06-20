import { describe, expect, it } from 'vitest';
import { inferSchema } from '../../src/import/infer.js';
import { matchSchemaToExisting, renameEntities } from '../../src/import/match.js';

// A December import already in the workspace (with the importer's bookkeeping cols).
const existing = [
  { name: 'funds', columns: ['id', 'code', 'name', 'vintage', 'fund_size', 'as_of', 'content_key', 'deleted_at'] },
  { name: 'investments', columns: ['id', 'company', 'invested', 'region', 'as_of', 'content_key', 'deleted_at'] },
  { name: 'region', columns: ['id', 'value', 'deleted_at'] }, // a dimension
  { name: 'investments_region', columns: ['id', 'investments_id', 'region_id', 'as_of'] }, // a junction
];

describe('matchSchemaToExisting', () => {
  it('recognizes a new period of the same document (same sheet names)', () => {
    const march = {
      funds: [{ code: 'EP', name: 'Early Plays', vintage: 1999, fundSize: 100 }],
      investments: [{ company: 'Acme', invested: 5, region: 'Europe' }],
    };
    const m = matchSchemaToExisting(existing, inferSchema(march));
    expect(m.isKnownDocument).toBe(true);
    expect(m.matches.find((x) => x.from === 'funds')?.to).toBe('funds');
    expect(m.matches.find((x) => x.from === 'investments')?.to).toBe('investments');
    expect(Object.keys(m.rename)).toHaveLength(0); // names already match
  });

  it('matches by column overlap when a sheet was renamed + a column added', () => {
    // "holdings" is investments renamed, with one extra column → still matches.
    const renamed = {
      holdings: [{ company: 'Acme', invested: 5, region: 'Europe', sector: 'Tech' }],
    };
    const m = matchSchemaToExisting(existing, inferSchema(renamed));
    const hit = m.matches.find((x) => x.from === 'holdings');
    expect(hit?.to).toBe('investments');
    expect(hit?.overlap).toBeGreaterThanOrEqual(0.6);
    expect(m.rename.holdings).toBe('investments');
  });

  it('does NOT call an unrelated file a known document', () => {
    const other = {
      orders: [{ order_id: 1, sku: 'X', qty: 3, customer: 'Bob' }],
    };
    const m = matchSchemaToExisting(existing, inferSchema(other));
    expect(m.isKnownDocument).toBe(false);
    expect(m.matchedCount).toBe(0);
  });
});

describe('renameEntities', () => {
  it('rewrites entity + linkage + view names per the rename map', () => {
    const plan = inferSchema({
      holdings: [{ company: 'Acme', invested: 5, region: 'Europe' }],
    });
    const { plan: renamed } = renameEntities(plan, [], { holdings: 'investments' });
    expect(renamed.entities.map((e) => e.name)).toContain('investments');
    expect(renamed.entities.map((e) => e.name)).not.toContain('holdings');
    // The region dimension linkage's fromEntity is rewritten too.
    expect(renamed.linkages.every((l) => l.fromEntity !== 'holdings')).toBe(true);
  });
});
