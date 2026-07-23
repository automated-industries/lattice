import { describe, it, expect } from 'vitest';
import { docxXmlToRecords, pptxSlideXmlToRecords } from '../../src/gui/ai/doc/doc-tables.js';

/**
 * Deterministic extraction of embedded tables from Office documents into records.
 * These test the pure XML → records core (no zip I/O); `docxToRecords` /
 * `pptxToRecords` are thin unzip wrappers over these.
 */

// ── builders for synthetic OOXML ──
function wCell(text: string): string {
  return `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
}
function wRow(cells: string[]): string {
  return '<w:tr>' + cells.map(wCell).join('') + '</w:tr>';
}
function wTable(rows: string[][]): string {
  return '<w:tbl>' + rows.map(wRow).join('') + '</w:tbl>';
}
function wDoc(...tables: string[]): string {
  return (
    '<w:document><w:body>' +
    tables.join('') +
    '<w:p><w:r><w:t>prose</w:t></w:r></w:p></w:body></w:document>'
  );
}

function aCell(text: string): string {
  return `<a:tc><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
}
function aRow(cells: string[]): string {
  return '<a:tr>' + cells.map(aCell).join('') + '</a:tr>';
}
function aTable(rows: string[][]): string {
  return '<a:tbl>' + rows.map(aRow).join('') + '</a:tbl>';
}

describe('docxXmlToRecords', () => {
  it('extracts EVERY row of a table (no truncation — the "4 of 46" regression)', () => {
    const header = ['School', 'ELA', 'Math'];
    const data = Array.from({ length: 46 }, (_, i) => [
      `School ${i + 1}`,
      `${80 + (i % 20)}%`,
      `${70 + (i % 25)}%`,
    ]);
    const out = docxXmlToRecords(wDoc(wTable([header, ...data])));
    const recs = out['Table 1'];
    expect(recs).toHaveLength(46); // NOT 4
    expect(recs?.[0]).toEqual({ School: 'School 1', ELA: '80%', Math: '70%' });
    expect(recs?.[45]?.School).toBe('School 46');
  });

  it('uses the first row as headers and keys each record by them', () => {
    const out = docxXmlToRecords(
      wDoc(
        wTable([
          ['Name', 'Role'],
          ['Ada', 'Eng'],
          ['Grace', 'Sci'],
        ]),
      ),
    );
    expect(out['Table 1']).toEqual([
      { Name: 'Ada', Role: 'Eng' },
      { Name: 'Grace', Role: 'Sci' },
    ]);
  });

  it('keys multiple tables separately', () => {
    const out = docxXmlToRecords(wDoc(wTable([['A'], ['1'], ['2']]), wTable([['B'], ['x']])));
    expect(Object.keys(out)).toEqual(['Table 1', 'Table 2']);
    expect(out['Table 1']).toHaveLength(2);
    expect(out['Table 2']).toEqual([{ B: 'x' }]);
  });

  it('deduplicates blank/duplicate headers so no column is dropped', () => {
    const out = docxXmlToRecords(
      wDoc(
        wTable([
          ['Name', 'Name', ''],
          ['a', 'b', 'c'],
        ]),
      ),
    );
    expect(out['Table 1']).toEqual([{ Name: 'a', 'Name 2': 'b', 'Column 3': 'c' }]);
  });

  it('skips blank rows and returns {} for a document with no tables', () => {
    const withBlank = docxXmlToRecords(wDoc(wTable([['H'], [''], ['v'], ['']])));
    expect(withBlank['Table 1']).toEqual([{ H: 'v' }]);
    expect(
      docxXmlToRecords(
        '<w:document><w:body><w:p><w:r><w:t>no tables</w:t></w:r></w:p></w:body></w:document>',
      ),
    ).toEqual({});
  });
});

describe('pptxSlideXmlToRecords', () => {
  it('extracts tables across slides, every row', () => {
    const slide1 =
      '<p:sld>' +
      aTable([
        ['Metric', 'Value'],
        ['Attrition', '8%'],
        ['Utilization', '61%'],
      ]) +
      '</p:sld>';
    const slide2 = '<p:sld>' + aTable([['Product'], ['Acme'], ['Globex']]) + '</p:sld>';
    const out = pptxSlideXmlToRecords([slide1, slide2]);
    expect(out['Table 1']).toEqual([
      { Metric: 'Attrition', Value: '8%' },
      { Metric: 'Utilization', Value: '61%' },
    ]);
    expect(out['Table 2']).toEqual([{ Product: 'Acme' }, { Product: 'Globex' }]);
  });

  it('returns {} for slides with no tables', () => {
    expect(
      pptxSlideXmlToRecords(['<p:sld><a:p><a:r><a:t>title only</a:t></a:r></a:p></p:sld>']),
    ).toEqual({});
  });
});
