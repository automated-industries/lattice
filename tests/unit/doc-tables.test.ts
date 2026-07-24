import { describe, it, expect } from 'vitest';
import { docxXmlToRecords, pptxSlideXmlToRecords } from '../../src/gui/ai/doc/doc-tables.js';
import { hasSubstantiveDocTable } from '../../src/gui/import-auto.js';
import { isAnonymousName } from '../../src/import/name-policy.js';
import { normalizeName } from '../../src/import/infer-core.js';

/**
 * Deterministic extraction of embedded tables from Office documents into records,
 * NAMED from the document (5.2). These test the pure XML → records core (no zip I/O);
 * `docxToRecords` / `pptxToRecords` are thin unzip wrappers over these.
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
function wTableCaptioned(caption: string, rows: string[][]): string {
  return (
    `<w:tbl><w:tblPr><w:tblCaption w:val="${caption}"/></w:tblPr>` +
    rows.map(wRow).join('') +
    '</w:tbl>'
  );
}
function wHeading(text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}
function wPara(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}
function wDoc(...parts: string[]): string {
  return '<w:document><w:body>' + parts.join('') + '</w:body></w:document>';
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
function aSlide(title: string | null, ...tables: string[]): string {
  const titleShape =
    title != null
      ? `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
        `<p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>`
      : '';
  return '<p:sld>' + titleShape + tables.join('') + '</p:sld>';
}

/** Every emitted table name must be meaningful — never a positional placeholder. */
function expectNoAnonymousKeys(out: Record<string, unknown[]>): void {
  for (const key of Object.keys(out)) {
    expect(isAnonymousName(normalizeName(key)), `key "${key}" is anonymous`).toBe(false);
  }
}

describe('docxXmlToRecords — extraction (unchanged semantics)', () => {
  it('extracts EVERY row of a table (no truncation — the "4 of 46" regression)', () => {
    const header = ['School', 'ELA', 'Math'];
    const data = Array.from({ length: 46 }, (_, i) => [
      `School ${String(i + 1)}`,
      `${String(80 + (i % 20))}%`,
      `${String(70 + (i % 25))}%`,
    ]);
    const out = docxXmlToRecords(wDoc(wTable([header, ...data])));
    const recs = Object.values(out)[0];
    expect(recs).toHaveLength(46); // NOT 4
    expect(recs?.[0]).toEqual({ School: 'School 1', ELA: '80%', Math: '70%' });
    expect(recs?.[45]).toMatchObject({ School: 'School 46' });
    expectNoAnonymousKeys(out);
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
    expect(Object.values(out)[0]).toEqual([
      { Name: 'Ada', Role: 'Eng' },
      { Name: 'Grace', Role: 'Sci' },
    ]);
    expectNoAnonymousKeys(out);
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
    expect(Object.values(out)[0]).toEqual([{ Name: 'a', 'Name 2': 'b', 'Column 3': 'c' }]);
    expectNoAnonymousKeys(out);
  });

  it('skips blank rows and returns {} for a document with no tables', () => {
    const withBlank = docxXmlToRecords(wDoc(wTable([['H'], [''], ['v'], ['']])));
    expect(Object.values(withBlank)[0]).toEqual([{ H: 'v' }]);
    expect(
      docxXmlToRecords(
        '<w:document><w:body><w:p><w:r><w:t>no tables</w:t></w:r></w:p></w:body></w:document>',
      ),
    ).toEqual({});
  });
});

describe('docxXmlToRecords — naming ladder (5.2)', () => {
  const rows = [
    ['Region', 'Revenue'],
    ['East', '10'],
    ['West', '20'],
  ];

  it('rung 1 — names a table from its explicit <w:tblCaption>', () => {
    const out = docxXmlToRecords(wDoc(wTableCaptioned('Quarterly Revenue', rows)));
    expect(Object.keys(out)).toEqual(['Quarterly Revenue']);
    expectNoAnonymousKeys(out);
  });

  it('rung 2 — names a table from a preceding heading', () => {
    const out = docxXmlToRecords(wDoc(wHeading('Sales by Region'), wTable(rows)));
    expect(Object.keys(out)).toEqual(['Sales by Region']);
    expectNoAnonymousKeys(out);
  });

  it('does NOT name a table after an introductory sentence', () => {
    const out = docxXmlToRecords(
      wDoc(
        wPara('The following table summarizes quarterly revenue performance across every region.'),
        wTable(rows),
      ),
    );
    // Falls through to the document basename — never the sentence text.
    expect(Object.keys(out)).toEqual(['document']);
    expect(Object.keys(out)[0]).not.toContain('following');
    expectNoAnonymousKeys(out);
  });

  it('a caption literally reading "Table 1" falls through (anonymous → rejected)', () => {
    const out = docxXmlToRecords(wDoc(wTableCaptioned('Table 1', rows)), 'Q3 Report.docx');
    expect(Object.keys(out)).toEqual(['Q3 Report']); // basename, NOT table_1
    expectNoAnonymousKeys(out);
  });

  it('rung 4 — a single un-nameable table takes the document basename', () => {
    const out = docxXmlToRecords(wDoc(wTable(rows)), '/tmp/Regional Sales.docx');
    expect(Object.keys(out)).toEqual(['Regional Sales']);
    expectNoAnonymousKeys(out);
  });

  it("the second table's heading lookback never reaches into the first table's cells", () => {
    // Two adjacent tables, DIFFERENT signatures, no heading between them. Without the
    // bounded lookback the second would be named after the first's last cell text.
    const first = wTable([
      ['Widget Name', 'SKU'],
      ['Acme Sprocket', 'A-1'],
      ['Globex Gear', 'G-2'],
    ]);
    const second = wTable([
      ['City', 'Population'],
      ['Denver', '700000'],
      ['Austin', '960000'],
    ]);
    const out = docxXmlToRecords(wDoc(first, second));
    for (const key of Object.keys(out)) {
      expect(key).not.toContain('Globex'); // never the first table's last cell
      expect(key).not.toContain('Gear');
    }
    expectNoAnonymousKeys(out);
    // Both tables' data survive.
    const allRows = Object.values(out).flat();
    expect(allRows.length).toBe(4);
  });

  it('two tables under one heading uniquify — the first is never overwritten', () => {
    // Heading names the first; the second (bounded lookback finds no heading) folds to
    // the basename. Both survive under distinct, non-anonymous keys.
    const a = wTable([
      ['Metric', 'Q1'],
      ['Revenue', '10'],
      ['Cost', '4'],
    ]);
    const b = wTable([
      ['Metric', 'Q2'],
      ['Revenue', '12'],
      ['Cost', '5'],
    ]);
    const out = docxXmlToRecords(wDoc(wHeading('Financials'), a, b), 'FY.docx');
    const keys = Object.keys(out);
    expect(keys.length).toBe(2);
    expect(new Set(keys).size).toBe(2); // distinct — no overwrite
    expectNoAnonymousKeys(out);
    expect(Object.values(out).flat().length).toBe(4); // all rows from both tables
  });

  it('merges two adjacent same-signature tables (page-break split), canonicalizing header case', () => {
    // Same normalized signature, differing header case, no heading between → one logical
    // table. Rows must be fully populated (no half-empty rows from `Rate` vs `rate`).
    const part1 = wTable([
      ['Rate', 'Year'],
      ['3.1', '2024'],
      ['3.4', '2025'],
    ]);
    const part2 = wTable([
      ['rate', 'year'],
      ['3.8', '2026'],
    ]);
    const out = docxXmlToRecords(wDoc(part1, part2), 'Rates.docx');
    expect(Object.keys(out)).toEqual(['Rates']);
    const recs = out.Rates;
    expect(recs).toHaveLength(3); // merged, not two tables
    // Canonicalized to the first member's spelling; every row fully populated.
    for (const r of recs ?? []) {
      expect(Object.keys(r as object).sort()).toEqual(['Rate', 'Year']);
    }
    expect(recs?.[2]).toEqual({ Rate: '3.8', Year: '2026' });
    expectNoAnonymousKeys(out);
  });

  it('a heading between two same-signature tables prevents the merge', () => {
    const t = (h: string): string =>
      wTable([
        ['Rate', 'Year'],
        [h, '2024'],
        [`${h}b`, '2025'],
      ]);
    const out = docxXmlToRecords(wDoc(wHeading('Prime'), t('1'), wHeading('Secondary'), t('2')));
    expect(Object.keys(out).sort()).toEqual(['Prime', 'Secondary']);
    expectNoAnonymousKeys(out);
  });
});

describe('docxXmlToRecords — fold (D1)', () => {
  it('folds un-nameable fragments into one basename table with the explicit column union', () => {
    // A large un-named fragment (substantive on its own) plus a later fragment with a
    // unique column. The fold must emit the column union so the unique column — which
    // appears only past the inferrer's first-300-row discovery window — survives with
    // explicit nulls on the rows that lack it.
    const big = [['X', 'Z'], ...Array.from({ length: 305 }, (_, i) => [`x${String(i)}`, 'z'])];
    const small = [
      ['X', 'Y'],
      ['x-late', 'y-late'],
    ];
    const out = docxXmlToRecords(wDoc(wTable(big), wTable(small)), 'Merged.docx');
    expect(Object.keys(out)).toEqual(['Merged']);
    const recs = out.Merged ?? [];
    expect(recs).toHaveLength(306);
    // Every record carries the full union (missing cells → null).
    for (const r of recs) expect('Y' in (r as object)).toBe(true);
    expect(recs[0]).toEqual({ X: 'x0', Z: 'z', Y: null });
    expect(recs[305]).toEqual({ X: 'x-late', Z: null, Y: 'y-late' });
    expectNoAnonymousKeys(out);
  });

  it('does NOT combine a prose document of tiny layout grids (keeps it a reference file)', () => {
    // Three 1-row, 2-col grids: none is individually substantive (>=2 rows). Combining
    // them would create one 3-row table and flip the import decision — so no combine.
    // Asserted against the REAL import gate, not a reimplementation of it.
    const grid = (a: string, b: string): string =>
      wTable([
        ['K', 'V'],
        [a, b],
      ]);
    const out = docxXmlToRecords(wDoc(grid('a', '1'), grid('b', '2'), grid('c', '3')));
    expect(hasSubstantiveDocTable(out)).toBe(false);
    expectNoAnonymousKeys(out);
  });
});

describe('docxXmlToRecords — review-round regressions', () => {
  const rows = [
    ['Region', 'Revenue'],
    ['East', '10'],
    ['West', '20'],
  ];

  it.each(['untitled.docx', 'table.docx', '2024.docx', '1.docx', 'sheet1.docx'])(
    'an anonymous-normalizing FILE name (%s) falls to the generic label, never an anonymous key',
    (fileName) => {
      // Rung 4: a single un-captioned, un-headed substantive table.
      const single = docxXmlToRecords(wDoc(wTable(rows)), fileName);
      expect(Object.keys(single)).toEqual(['document']);
      expectNoAnonymousKeys(single);
      // Fold: two un-nameable substantive fragments.
      const folded = docxXmlToRecords(
        wDoc(
          wTable(rows),
          wTable([
            ['City', 'Population'],
            ['Denver', '700000'],
            ['Austin', '960000'],
          ]),
        ),
        fileName,
      );
      expectNoAnonymousKeys(folded);
      expect(Object.values(folded).flat().length).toBe(4); // fold, don't drop
    },
  );

  it('a record-less banner table is never read as the next table’s heading', () => {
    // A one-cell header-only table produces no records and used to vanish from the
    // lookback floor, leaving its cell text inside the next table's heading span.
    const banner = wTable([['Note from Legal']]);
    const out = docxXmlToRecords(wDoc(banner, wTable(rows)), 'Report.docx');
    for (const key of Object.keys(out)) {
      expect(key).not.toContain('Note from Legal');
    }
    expectNoAnonymousKeys(out);
  });

  it('a heading-named table absorbs its un-named page-break continuation', () => {
    // Same signature, adjacent, no heading between: the continuation has no caption
    // or heading of its own (that is what a page-break continuation looks like), so
    // it merges into the heading-named table instead of forking a basename table.
    const part2 = wTable([
      ['Region', 'Revenue'],
      ['North', '30'],
    ]);
    const out = docxXmlToRecords(wDoc(wHeading('Sales by Region'), wTable(rows), part2), 'FY.docx');
    expect(Object.keys(out)).toEqual(['Sales by Region']);
    expect(out['Sales by Region']).toHaveLength(3); // 2 + the continuation row
  });

  it('caps a ladder-derived name so the normalized identifier stays inside 63 bytes', () => {
    const longHeading =
      'Quarterly Consolidated Revenue Performance Summary Across All Operating Regions And Business Segments For The Fiscal Year';
    const out = docxXmlToRecords(wDoc(wHeading(longHeading), wTable(rows)));
    const key = Object.keys(out)[0] ?? '';
    expect(key.length).toBeLessThanOrEqual(40);
    expect(normalizeName(key).length).toBeLessThanOrEqual(63);
    expectNoAnonymousKeys(out);
  });

  it('uniquifies on the NORMALIZED identity — raw-distinct keys that collide downstream get suffixed', () => {
    // Two captions that differ only in case/punctuation normalize to the same
    // entity name; without normalized uniquify they would silently merge at inference.
    const a = wTableCaptioned('Rate Table', [
      ['X', 'Y'],
      ['1', '2'],
      ['3', '4'],
    ]);
    const b = wTableCaptioned('rate  table', [
      ['P', 'Q'],
      ['5', '6'],
    ]);
    const out = docxXmlToRecords(wDoc(a, b));
    const keys = Object.keys(out);
    expect(keys.length).toBe(2);
    expect(new Set(keys.map((k) => normalizeName(k))).size).toBe(2); // distinct downstream too
    expectNoAnonymousKeys(out);
  });
});

describe('pptxSlideXmlToRecords', () => {
  it('names tables from their slide title, every row', () => {
    const out = pptxSlideXmlToRecords([
      aSlide(
        'Attrition Metrics',
        aTable([
          ['Metric', 'Value'],
          ['Attrition', '8%'],
          ['Utilization', '61%'],
        ]),
      ),
      aSlide(
        'Products',
        aTable([
          ['Product', 'Owner'],
          ['Acme', 'A'],
          ['Globex', 'B'],
        ]),
      ),
    ]);
    expect(out['Attrition Metrics']).toEqual([
      { Metric: 'Attrition', Value: '8%' },
      { Metric: 'Utilization', Value: '61%' },
    ]);
    expect(out.Products).toEqual([
      { Product: 'Acme', Owner: 'A' },
      { Product: 'Globex', Owner: 'B' },
    ]);
    expectNoAnonymousKeys(out);
  });

  it('a titleless slide table folds to the presentation basename, never Table N', () => {
    const out = pptxSlideXmlToRecords(
      [
        aSlide(
          null,
          aTable([
            ['Product', 'Owner'],
            ['Acme', 'A'],
            ['Globex', 'B'],
          ]),
        ),
      ],
      'Deck.pptx',
    );
    expect(Object.keys(out)).toEqual(['Deck']);
    expectNoAnonymousKeys(out);
  });

  it('returns {} for slides with no tables', () => {
    expect(
      pptxSlideXmlToRecords(['<p:sld><a:p><a:r><a:t>title only</a:t></a:r></a:p></p:sld>']),
    ).toEqual({});
  });
});
