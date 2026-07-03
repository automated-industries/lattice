import { describe, expect, it } from 'vitest';
import { inferFieldType, inferSchema, normalizeName } from '../../src/import/infer.js';

/** A fixture that mirrors the fund dashboard's data.json shapes: a clean keyed
 *  entity (funds), a keyless entity with an array ref + categorical dimensions
 *  (investments), a columnar entity (grossDeploy + grossDeployCols), and derived
 *  objects that must be skipped. */
function fixture() {
  const regions = ['Europe', 'N. America', 'Asia'];
  const countries = ['United Kingdom', 'United States', 'China'];
  const industries = ['Technology', 'Healthcare', 'Energy'];
  const stages = ['Early Stage', 'Growth'];
  const statuses = ['Realized', 'Active'];
  const codes = ['Fund EP', 'Fund GG'];

  const investments = Array.from({ length: 12 }, (_, i) => ({
    company: 'Company ' + (i % 8), // repeats → not unique → keyless
    funds: [codes[i % 2]],
    fundsRaw: codes[i % 2], // redundant scalar ref to the same target
    dateInitial: `20${String(10 + (i % 9)).padStart(2, '0')}-01-15`,
    invested: 1.5 + i,
    region: regions[i % 3],
    country: countries[i % 3],
    industry: industries[i % 3],
    stage: stages[i % 2],
    status: statuses[i % 2],
    description: 'A longer unique free-text description number ' + i,
  }));

  return {
    meta: { title: 'Track Record', fundCount: 2 }, // derived/meta → skip
    funds: [
      { code: 'Fund EP', name: 'Fund Early Plays', vintage: 1999, fundSize: 100.5, grossIRR: 0.2 },
      { code: 'Fund GG', name: 'Fund Global Growth', vintage: 2022, fundSize: 200, grossIRR: 0.3 },
    ],
    investments,
    grossDeploy: [
      [1999, 'Fund EP', 'Early Stage', 'Europe', 'Technology', 'United Kingdom', 5, 0, 0],
      [2022, 'Fund GG', 'Growth', 'N. America', 'Healthcare', 'United States', 8, 1, 9],
      [2023, 'Fund GG', 'Growth', 'Asia', 'Energy', 'China', 3, 0, 4],
    ],
    grossDeployCols: [
      'year',
      'fund',
      'stage',
      'region',
      'industry',
      'country',
      'invested',
      'proceeds',
      'nav',
    ],
    total: { invested: 999 }, // derived → skip
  };
}

describe('inferFieldType', () => {
  it('detects scalar types', () => {
    expect(inferFieldType([1, 2, 3])).toBe('integer');
    expect(inferFieldType([1.5, 2])).toBe('real');
    expect(inferFieldType([true, false])).toBe('boolean');
    expect(inferFieldType(['2020-01-01', '2021-02-02'])).toBe('date');
    expect(inferFieldType(['2020-01-01T10:00:00Z'])).toBe('datetime');
    expect(inferFieldType(['a', 'b'])).toBe('text');
    expect(inferFieldType([null, undefined, ''])).toBe('text');
  });
});

describe('normalizeName', () => {
  it('snake-cases keys safely', () => {
    expect(normalizeName('grossIRR')).toBe('gross_irr');
    expect(normalizeName('fundSize')).toBe('fund_size');
    expect(normalizeName('Date Initial')).toBe('date_initial');
    expect(normalizeName('123abc')).toBe('f_123abc');
  });
});

describe('inferSchema', () => {
  const schema = inferSchema(fixture());
  const entity = (n: string) => schema.entities.find((e) => e.name === n);

  it('detects the three entities incl. the columnar one, skips derived objects', () => {
    expect(schema.entities.map((e) => e.name).sort()).toEqual([
      'funds',
      'gross_deploy',
      'investments',
    ]);
    expect(entity('gross_deploy')?.columnar).toBe(true);
    const skippedKeys = schema.skipped.map((s) => s.key);
    expect(skippedKeys).toContain('meta');
    expect(skippedKeys).toContain('total');
    // The column dictionary is consumed, not an entity and not skipped noise.
    expect(schema.entities.some((e) => e.sourceKey === 'grossDeployCols')).toBe(false);
    expect(skippedKeys).not.toContain('grossDeployCols');
  });

  it('picks a natural key when one exists, keyless otherwise', () => {
    expect(entity('funds')?.naturalKey).toBe('code');
    expect(entity('investments')?.naturalKey).toBeNull();
  });

  it('infers column types and excludes linkage/dimension fields from scalar columns', () => {
    const funds = entity('funds')!;
    expect(funds.columns.find((c) => c.name === 'vintage')?.type).toBe('integer');
    expect(funds.columns.find((c) => c.name === 'fund_size')?.type).toBe('real');

    const inv = entity('investments')!;
    const colNames = inv.columns.map((c) => c.name);
    expect(colNames).toContain('company'); // free-text, kept as column
    expect(colNames).toContain('description');
    expect(colNames).not.toContain('industry'); // became a dimension
    expect(colNames).not.toContain('funds'); // became a linkage
    expect(inv.columns.find((c) => c.name === 'date_initial')?.type).toBe('date');
  });

  it('infers the array ref as one many-to-many link to funds (deduped from fundsRaw)', () => {
    const toFunds = schema.linkages.filter(
      (l) => l.fromEntity === 'investments' && l.toEntity === 'funds',
    );
    expect(toFunds).toHaveLength(1);
    expect(toFunds[0]!.kind).toBe('many-to-many');
    expect(toFunds[0]!.confidence).toBeGreaterThan(0.9);
    // gross_deploy.fund resolves to funds too (scalar → many-to-one).
    expect(
      schema.linkages.some((l) => l.fromEntity === 'gross_deploy' && l.toEntity === 'funds'),
    ).toBe(true);
  });

  it('normalizes shared categorical fields into dimensions', () => {
    const dimNames = schema.dimensions.map((d) => d.name);
    expect(dimNames).toEqual(expect.arrayContaining(['industry', 'region', 'stage', 'country']));
    const industry = schema.dimensions.find((d) => d.name === 'industry')!;
    // industry appears in BOTH investments and gross_deploy.
    expect(industry.fromEntities.sort()).toEqual(['gross_deploy', 'investments']);
    expect(industry.distinctValues).toBe(3);
    // and each contributor gets a dimension linkage
    expect(
      schema.linkages.some(
        (l) =>
          l.kind === 'dimension' && l.fromEntity === 'investments' && l.toEntity === 'industry',
      ),
    ).toBe(true);
  });

  it('returns an empty marginal-link list when every reference is confident', () => {
    expect(schema.marginalLinks).toEqual([]);
  });

  it('does not turn a numeric ratio column with text sentinels into a dimension', () => {
    // Real financial export shape: a "TEV/EBITDA" of mostly-distinct numbers with
    // "NM" sentinels (here 55% "NM", so numericFraction < 0.5) — must NOT become a
    // dimension. Counting only string values would see distinct=1 ("nm") and let it
    // slip in as a junk, high-cardinality dimension table.
    const rows = Array.from({ length: 200 }, (_, i) => ({
      company: 'Co ' + i,
      tevEbitda: i % 100 < 55 ? 'NM' : 10 + i * 0.137, // ~90 distinct numerics + "NM"
      region: ['NA', 'EU', 'Asia'][i % 3], // a genuine low-cardinality categorical
    }));
    const dimNames = inferSchema({ companies: rows }).dimensions.map((d) => d.name);
    expect(dimNames).toContain('region');
    expect(dimNames).not.toContain('tev_ebitda');
  });
});

describe('inferSchema — link-confidence banding (act / ask / drop)', () => {
  /** A vendor reference where only `matched` of 10 distinct values resolve to
   *  the vendors table's natural key. */
  function partialRefFixture(matched: number) {
    return {
      vendors: Array.from({ length: 10 }, (_, i) => ({
        code: 'V' + i,
        name: 'Vendor ' + i,
      })),
      orders: Array.from({ length: 20 }, (_, i) => ({
        sku: 'SKU-' + i,
        vendor:
          i < 10
            ? i < matched
              ? 'V' + i
              : 'X' + i
            : i < 10 + matched
              ? 'V' + (i - 10)
              : 'X' + (i - 10),
        amount: 5 + i,
      })),
    };
  }

  it('reports the [floor, threshold) band as marginalLinks, uncreated', () => {
    // 5 of 10 distinct vendor values resolve → confidence 0.5, inside the
    // default band [0.3, 0.6).
    const schema = inferSchema(partialRefFixture(5));
    expect(schema.linkages.filter((l) => l.kind !== 'dimension')).toEqual([]);
    expect(schema.marginalLinks).toHaveLength(1);
    expect(schema.marginalLinks[0]).toMatchObject({
      kind: 'many-to-one',
      fromEntity: 'orders',
      fromField: 'vendor',
      toEntity: 'vendors',
      toKey: 'code',
      confidence: 0.5,
    });
    // The referencing column survives as a plain scalar column…
    const orders = schema.entities.find((e) => e.name === 'orders')!;
    expect(orders.columns.map((c) => c.name)).toContain('vendor');
    // …and is held out of dimension extraction (folding it into a dimension
    // would strip the column a later "yes, connect them" needs).
    expect(schema.dimensions.map((d) => d.name)).not.toContain('vendor');
  });

  it('creates the link at or above the threshold, exactly as before', () => {
    // 8 of 10 resolve → confidence 0.8 ≥ 0.6 → a real link, nothing marginal.
    const schema = inferSchema(partialRefFixture(8));
    const link = schema.linkages.find((l) => l.toEntity === 'vendors');
    expect(link).toMatchObject({ kind: 'many-to-one', fromEntity: 'orders', confidence: 0.8 });
    expect(schema.marginalLinks).toEqual([]);
    const orders = schema.entities.find((e) => e.name === 'orders')!;
    expect(orders.columns.map((c) => c.name)).not.toContain('vendor'); // consumed by the link
  });

  it('drops candidates below the floor as noise', () => {
    // 2 of 10 resolve → confidence 0.2 < 0.3 → neither created nor marginal.
    const schema = inferSchema(partialRefFixture(2));
    expect(schema.linkages.filter((l) => l.kind !== 'dimension')).toEqual([]);
    expect(schema.marginalLinks).toEqual([]);
  });

  it('honors a minLinkConfidence override in both directions', () => {
    // confidence 0.5: a 0.4 threshold creates it; a 0.9 threshold (floor 0.45)
    // keeps it marginal.
    const created = inferSchema(partialRefFixture(5), { minLinkConfidence: 0.4 });
    expect(created.linkages.some((l) => l.toEntity === 'vendors')).toBe(true);
    expect(created.marginalLinks).toEqual([]);
    const asked = inferSchema(partialRefFixture(5), { minLinkConfidence: 0.9 });
    expect(asked.linkages.filter((l) => l.kind !== 'dimension')).toEqual([]);
    expect(asked.marginalLinks).toHaveLength(1);
  });

  it('leaves dimension links (confidence 1) unaffected by the banding', () => {
    const data = {
      vendors: Array.from({ length: 10 }, (_, i) => ({ code: 'V' + i, name: 'Vendor ' + i })),
      orders: Array.from({ length: 20 }, (_, i) => ({
        sku: 'SKU-' + i,
        region: ['NA', 'EU', 'Asia'][i % 3],
      })),
    };
    const schema = inferSchema(data, { minLinkConfidence: 1 });
    const dim = schema.linkages.find((l) => l.kind === 'dimension' && l.toEntity === 'region');
    expect(dim).toMatchObject({ confidence: 1 });
    expect(schema.marginalLinks).toEqual([]);
  });
});
