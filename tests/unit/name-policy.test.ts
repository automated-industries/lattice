import { describe, it, expect } from 'vitest';
import {
  MAX_IMPORT_TABLES,
  MAX_SOURCE_LABEL_CHARS,
  applySourceNameFallback,
  capLabel,
  checkDimensionName,
  checkEntityShape,
  isAnonymousName,
  labelFromFilename,
} from '../../src/import/name-policy.js';
import { normalizeName } from '../../src/import/infer-core.js';
import { docxXmlToRecords } from '../../src/gui/ai/doc/doc-tables.js';
import { deterministicRowOwner } from '../../src/gui/ai/enrich.js';

/**
 * The one shared table-name policy. `isAnonymousName` is applied to the
 * POST-`normalizeName` form — `normalizeName` inserts a separator only at a
 * lower→UPPER camel boundary, never before a digit (`Table 1` → `table_1` but
 * `Sheet1` → `sheet1`), so both separator shapes must be covered.
 */

describe('isAnonymousName', () => {
  const anonymous = [
    // Both separator shapes for each stem (the real Excel case is `sheet1`).
    'table_1',
    'table1',
    'table_12',
    'sheet_1',
    'sheet1',
    'sheet3',
    'tab_2',
    'tab7',
    // Bare placeholder words with no ordinal.
    'table',
    'sheet',
    'untitled',
    'unnamed',
    // normalizeName's own fallbacks: '' → 'field'; digit-leading → 'f_…' (the
    // artifact always carries the underscore).
    'field',
    'field_2',
    'f_1',
    'f_2026',
  ];
  it.each(anonymous)('flags %s', (name) => {
    expect(isAnonymousName(name)).toBe(true);
  });

  const legitimate = [
    // csvToRecords' basename fallback is a real, deliberate name.
    'data',
    // f_<digits> only when BARE: normalizeName prefixes digit-leading names with
    // f_, so f_2026_rates is a real name (2026 Rates.xlsx), not a placeholder.
    'f_2026_rates',
    // A literal f1/f2 (no underscore) is a user-typed name — a fund tab, a form
    // code — never the normalizeName artifact, which always has the underscore.
    'f1',
    'f2',
    'f',
    // column_N is a COLUMN-name artifact, not a table-name concern (and dimension
    // names derive from column names — a blank-headered categorical must degrade
    // gracefully, not be refused).
    'column_3',
    'col_2',
    'columns',
    // Ordinary names that merely contain a stem.
    'tables_of_contents',
    'timetable',
    'sheets_summary',
    'tabulations',
    'quarterly_revenue',
    'invoices',
    'field_offices',
  ];
  it.each(legitimate)('passes %s', (name) => {
    expect(isAnonymousName(name)).toBe(false);
  });

  it('agrees with the post-normalizeName form of real-world raw names', () => {
    expect(isAnonymousName(normalizeName('Table 1'))).toBe(true); // table_1
    expect(isAnonymousName(normalizeName('Sheet1'))).toBe(true); // sheet1
    expect(isAnonymousName(normalizeName('2026 Rates'))).toBe(false); // f_2026_rates
    expect(isAnonymousName(normalizeName(''))).toBe(true); // field
    expect(isAnonymousName(normalizeName('Quarterly Revenue'))).toBe(false);
  });
});

describe('checkEntityShape', () => {
  it('N1 — rejects an anonymous name', () => {
    expect(checkEntityShape({ name: 'table_1', rowCount: 10 }).ok).toBe(false);
    expect(checkEntityShape({ name: 'invoices', rowCount: 10 }).ok).toBe(true);
  });

  it('N2 — requires >= 1 row only when rows are being written', () => {
    const empty = { name: 'invoices', rowCount: 0 };
    expect(checkEntityShape(empty, { requireRows: true }).ok).toBe(false);
    expect(checkEntityShape(empty, { requireRows: false }).ok).toBe(true);
    expect(checkEntityShape(empty).ok).toBe(true); // default: schema-only is fine
  });

  it('has NO column-count bar (a one-column entity is legitimate post-inference)', () => {
    // infer.ts strips dimension/linkage fields before emitting, so a real entity
    // can arrive with a single column — the shape gate must not reject it.
    expect(checkEntityShape({ name: 'invoices', rowCount: 3 }, { requireRows: true }).ok).toBe(
      true,
    );
  });
});

describe('checkDimensionName', () => {
  it('N1 only — name check, nothing shape-related', () => {
    expect(checkDimensionName({ name: 'sheet1' }).ok).toBe(false);
    expect(checkDimensionName({ name: 'region' }).ok).toBe(true);
    // Column-artifact names pass (see isAnonymousName rationale above).
    expect(checkDimensionName({ name: 'column_3' }).ok).toBe(true);
  });
});

describe('shared constants', () => {
  it('MAX_IMPORT_TABLES is the single shared cap', () => {
    expect(MAX_IMPORT_TABLES).toBe(50);
  });
});

describe('capLabel + labelFromFilename', () => {
  it('caps at a word boundary and keeps the normalized identifier inside 63 bytes', () => {
    const long = 'Quarterly Consolidated Revenue Performance Summary Across All Operating Regions';
    const capped = capLabel(long);
    expect(capped.length).toBeLessThanOrEqual(MAX_SOURCE_LABEL_CHARS);
    expect(capped.endsWith(' ')).toBe(false);
    expect(normalizeName(capped).length).toBeLessThanOrEqual(63);
    // Short labels pass through untouched.
    expect(capLabel('Rates')).toBe('Rates');
  });

  it('derives a non-anonymous label from any file name', () => {
    expect(labelFromFilename('Q3 Report.docx')).toBe('Q3 Report');
    expect(labelFromFilename('/tmp/Regional Sales.xlsx')).toBe('Regional Sales');
    // Anonymous-normalizing basenames fall to the generic label — never a key
    // the materialize pre-flight would refuse.
    for (const f of [
      'untitled.docx',
      'table.xlsx',
      'sheet1.xlsx',
      '2024.docx',
      '1.json',
      '.docx',
    ]) {
      const label = labelFromFilename(f);
      expect(isAnonymousName(normalizeName(label)), `${f} → ${label}`).toBe(false);
    }
  });
});

describe('applySourceNameFallback (the Sheet1 backstop)', () => {
  it('renames anonymous top-level keys from the file name — the default-workbook case', () => {
    const rows = [
      { region: 'East', revenue: 10 },
      { region: 'West', revenue: 20 },
    ];
    const out = applySourceNameFallback({ Sheet1: rows }, 'Q3 Budget.xlsx');
    expect(Object.keys(out)).toEqual(['Q3 Budget']);
    expect(out['Q3 Budget']).toBe(rows); // same array, only the key moved
  });

  it('uniquifies multiple anonymous keys and leaves meaningful keys alone', () => {
    const out = applySourceNameFallback(
      { Sheet1: [{ a: 1 }], Sheet2: [{ b: 2 }], vendors: [{ v: 'x' }] },
      'Budget.xlsx',
    );
    expect(Object.keys(out).sort()).toEqual(['Budget', 'Budget 2', 'vendors']);
  });

  it('renames a columnar <key>Cols dictionary in lock-step with its data key', () => {
    const out = applySourceNameFallback(
      { table_1: [[1, 'x']], table_1Cols: ['id', 'label'] },
      'Deploys.json',
    );
    expect(Object.keys(out).sort()).toEqual(['Deploys', 'DeploysCols']);
    expect(out.DeploysCols).toEqual(['id', 'label']);
  });

  it('is a no-op when nothing is anonymous, and deterministic across doors', () => {
    const data = { vendors: [{ v: 'x' }] };
    expect(applySourceNameFallback(data, 'anything.xlsx')).toBe(data);
    const a = applySourceNameFallback({ Sheet1: [{ a: 1 }] }, 'Budget.xlsx');
    const b = applySourceNameFallback({ Sheet1: [{ a: 1 }] }, 'Budget.xlsx');
    expect(Object.keys(a)).toEqual(Object.keys(b)); // proposal door == apply door
  });

  it('an anonymous FILE name still yields a non-anonymous key', () => {
    const out = applySourceNameFallback({ Sheet1: [{ a: 1 }] }, 'sheet1.xlsx');
    expect(Object.keys(out)).toEqual(['document']);
  });
});

describe('deterministicRowOwner (the LLM-extractor gate)', () => {
  it('owns tabular files by TYPE, documents only when the importer actually ran', () => {
    expect(deterministicRowOwner('budget.xlsx', false)).toBe(true);
    expect(deterministicRowOwner('rows.csv', false)).toBe(true);
    // A document is owned only when the structured importer claimed it…
    expect(deterministicRowOwner('report.docx', true)).toBe(true);
    // …a prose document the importer declined still gets LLM extraction.
    expect(deterministicRowOwner('report.docx', false)).toBe(false);
    expect(deterministicRowOwner('notes.pdf', false)).toBe(false);
  });
});

describe('extractor determinism (verification: idempotence)', () => {
  it('running the doc-table extractor twice yields byte-identical names + records', () => {
    const xml =
      '<w:document><w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Sales by Region</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:p><w:r><w:t>East</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>10</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:p><w:r><w:t>West</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>20</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>City</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:p><w:r><w:t>Denver</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:p><w:r><w:t>Austin</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '</w:body></w:document>';
    const a = docxXmlToRecords(xml, 'Report.docx');
    const b = docxXmlToRecords(xml, 'Report.docx');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a)).toEqual(Object.keys(b));
  });
});
