import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  excelFormulaSummary,
  excelImportWarnings,
  excelToRecords,
  __test,
} from '../../src/import/excel.js';
import { inferSchema } from '../../src/import/infer.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a messy fund-style workbook to a temp .xlsx and return its path:
 *  a 1-cell nav tab, a single-column prose Disclaimer, and a data tab with a
 *  title preamble + a totals row (the real-world shape). The data tab carries
 *  two formula columns: per-row formulas (Fee) and a shared-formula
 *  master/slave pair (Net). */
async function writeFixture(): Promise<string> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();

  const nav = wb.addWorksheet('Summary >>');
  nav.getCell('A1').value = 'See the other tabs';

  const dis = wb.addWorksheet('Disclaimer');
  ['Confidential', 'This document is provided for...', 'Past performance is not...'].forEach(
    (t, i) => {
      dis.getCell(i + 1, 1).value = t;
    },
  );

  const fs = wb.addWorksheet('Funds');
  fs.getCell('A1').value = 'Confidential';
  fs.getCell('A2').value = 'Acme Capital — Track Record';
  fs.getCell('A3').value = '($ in Millions)';
  // row 4 intentionally blank
  fs.getRow(5).values = [null, 'Code', 'Name', 'Vintage', 'Size', 'Fee', 'Net'];
  fs.getRow(6).values = [null, 'Fund A', 'Alpha Fund', 2022, 100];
  fs.getRow(7).values = [null, 'Fund B', 'Beta Fund', 2018, 250];
  // Per-row formulas (column F) — values still import from the cached results.
  fs.getCell('F6').value = { formula: 'E6*0.02', result: 2 };
  fs.getCell('F7').value = { formula: 'E7*0.02', result: 5 };
  // Shared formula (column G): a master + a same-column slave.
  fs.getCell('G6').value = { formula: 'E6-F6', shareType: 'shared', ref: 'G6:G7', result: 98 };
  fs.getCell('G7').value = { sharedFormula: 'G6', result: 245 };
  fs.getRow(8).values = [null, 'Total', null, 2020, 350]; // totals row → dropped

  const dir = mkdtempSync(join(tmpdir(), 'lattice-xlsx-'));
  dirs.push(dir);
  const path = join(dir, 'book.xlsx');
  await wb.xlsx.writeFile(path);
  return path;
}

describe('cellValue', () => {
  it('flattens dates, formulas, rich text, and primitives', () => {
    expect(__test.cellValue(new Date('2022-03-31T00:00:00Z'))).toBe('2022-03-31');
    expect(__test.cellValue({ formula: 'A1*2', result: 42 })).toBe(42);
    expect(__test.cellValue({ richText: [{ text: 'a' }, { text: 'b' }] })).toBe('ab');
    expect(__test.cellValue(7)).toBe(7);
    expect(__test.cellValue(null)).toBeNull();
  });
});

describe('excelToRecords', () => {
  it('detects the header past the preamble, drops totals, skips nav/prose sheets', async () => {
    const path = await writeFixture();
    const out = await excelToRecords(path);

    // Only the real data tab survives.
    expect(Object.keys(out)).toEqual(['Funds']);
    const funds = out.Funds!;
    expect(funds).toHaveLength(2); // totals row dropped
    expect(Object.keys(funds[0]!).sort()).toEqual([
      'Code',
      'Fee',
      'Name',
      'Net',
      'Size',
      'Vintage',
    ]);
    expect(funds[0]).toMatchObject({ Code: 'Fund A', Name: 'Alpha Fund', Vintage: 2022 });
    expect(funds.some((r) => r.Code === 'Total')).toBe(false);

    // Formula cells still import their cached RESULTS, exactly as before.
    expect(funds.map((r) => r.Fee)).toEqual([2, 5]);
    expect(funds.map((r) => r.Net)).toEqual([98, 245]);

    // And it feeds the existing inference pipeline cleanly.
    const schema = inferSchema(out);
    const entity = schema.entities.find((e) => e.name === 'funds');
    expect(entity).toBeTruthy();
    expect(entity!.columns.find((c) => c.name === 'vintage')?.type).toBe('integer');
  });

  it('summarizes per-column formulas, incl. same-column shared-formula slaves', async () => {
    const path = await writeFixture();
    await excelToRecords(path);
    const summary = excelFormulaSummary(path);
    const funds = summary.Funds!;

    // The header layout is exposed so formula refs map back onto columns.
    expect(funds.columnLetters).toMatchObject({ B: 'Code', E: 'Size', F: 'Fee', G: 'Net' });

    // Per-row formulas normalize to one shared row-local pattern.
    expect(funds.columns.Fee).toEqual({
      total: 2,
      formulaRows: 2,
      patterns: { '[E]*0.02': 2 },
      example: 'E6*0.02',
    });
    // The shared-formula slave sits in the master's COLUMN, so it reuses the
    // master's pattern.
    expect(funds.columns.Net).toEqual({
      total: 2,
      formulaRows: 2,
      patterns: { '[E]-[F]': 2 },
      example: 'E6-F6',
    });
    // Plain-value columns carry no formula stats.
    expect(funds.columns.Code).toBeUndefined();
    expect(funds.columns.Size).toBeUndefined();
  });
});

/** Write a workbook with ONE sheet whose cells are set from a row-major grid (row 1 = grid
 *  index 0; a `null` grid row is a blank spacer row). Returns the .xlsx path. */
async function writeGridSheet(sheet: string, grid: (unknown[] | null)[]): Promise<string> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  grid.forEach((cells, i) => {
    if (cells) ws.getRow(i + 1).values = [null, ...cells]; // leading null → 1-based columns
  });
  const dir = mkdtempSync(join(tmpdir(), 'lattice-xlsx-'));
  dirs.push(dir);
  const path = join(dir, 'grid.xlsx');
  await wb.xlsx.writeFile(path);
  return path;
}

describe('excelToRecords — multi-block sheets', () => {
  it('never merges a narrower separate table into the one above it (no silent corruption)', async () => {
    // A 4-column table, ONE blank row, then a NARROWER 2-column table (its columns are a subset
    // of the first's). These are two DISTINCT tables — the reader must NOT bridge the single
    // blank and read the second table's header + rows under the first table's column names.
    const path = await writeGridSheet('Book', [
      ['Code', 'Name', 'Region', 'Amount'], // table 1 header (cols 1-4)
      ['A', 'Alpha', 'East', 10],
      ['B', 'Beta', 'West', 20],
      null, // single blank — a boundary, NOT an in-table spacer
      ['Ticker', 'Company', 'Sector'], // table 2 header (cols 1-3, a subset of table 1's)
      ['AAA', 'Acme', 'Tech'],
      ['BBB', 'Beta Corp', 'Retail'],
      ['CCC', 'Ceta LLC', 'Finance'],
    ]);
    const rows = (await excelToRecords(path)).Book!;
    // The larger table (table 2, 3 rows) is imported under ITS OWN header — never a row where a
    // header label ("Ticker"/"Code") leaked in as data (which the buggy single-blank bridge did).
    expect(rows).toHaveLength(3);
    expect(Object.keys(rows[0]!).sort()).toEqual(['Company', 'Sector', 'Ticker']);
    expect(rows.map((r) => r.Ticker)).toEqual(['AAA', 'BBB', 'CCC']);
    expect(rows.some((r) => r.Ticker === 'Ticker' || r.Code === 'Code')).toBe(false);
    // The other table is surfaced, not silently swallowed.
    expect(excelImportWarnings(path)).toHaveLength(1);
  });

  it('imports the LARGEST table on a stacked-table sheet and warns about the rest', async () => {
    // A small summary table, a blank gap, then a larger detail table. The old reader kept the
    // FIRST (summary); the block reader keeps the largest and reports the rest.
    const path = await writeGridSheet('Book', [
      ['Code', 'Name', 'Region', 'Amount'], // summary header
      ['S1', 'Sum One', 'East', 1],
      ['S2', 'Sum Two', 'West', 2],
      null, // blank → a table boundary
      ['Code', 'Name', 'Region', 'Amount'], // detail header
      ['D1', 'Det One', 'East', 10],
      ['D2', 'Det Two', 'West', 20],
      ['D3', 'Det Three', 'East', 30],
      ['D4', 'Det Four', 'West', 40],
    ]);
    const rows = (await excelToRecords(path)).Book!;
    expect(rows).toHaveLength(4); // the detail table, not the 2-row summary
    expect(rows.map((r) => r.Code)).toEqual(['D1', 'D2', 'D3', 'D4']);
    // The dropped summary block is surfaced, not silently lost.
    const warns = excelImportWarnings(path);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/not imported/i);
  });

  it('drops a true totals row but KEEPS a real row whose label starts with "Total"', async () => {
    const path = await writeGridSheet('Sales', [
      ['Company', 'Category', 'Revenue'],
      ['Acme', 'Tech', 300],
      ['Total Wine & More', 'Retail', 500], // real company — other TEXT cell → kept
      ['Total', null, 800], // aggregate — only numbers besides the label → dropped
    ]);
    const rows = (await excelToRecords(path)).Sales!;
    expect(rows.map((r) => r.Company)).toEqual(['Acme', 'Total Wine & More']);
  });

  it('imports a narrow table even when a stray far-right cell inflates the sheet width', async () => {
    // A note in column 10 makes ws.columnCount=10, so a sheet-wide threshold (floor(10*0.4)=4)
    // would reject the 3-column table's header. The per-block threshold uses the block's own
    // width (3), so the table is detected and imported.
    const path = await writeGridSheet('Data', [
      ['Code', 'Name', 'Amount'], // 3-col table (cols B–D)
      ['A', 'Alpha', 10],
      ['B', 'Beta', 20],
      [null, null, null, null, null, null, null, null, 'a stray note'], // a lone cell in col 10
    ]);
    const rows = (await excelToRecords(path)).Data!;
    expect(rows.map((r) => r.Code)).toEqual(['A', 'B']); // table imported; the note row skipped
    expect(Object.keys(rows[0]!).sort()).toEqual(['Amount', 'Code', 'Name']);
  });

  it('imports a TWO-column table (previously dropped by the header-density floor)', async () => {
    // A 2-col table can never reach a floor of 3 filled cells, so it used to be omitted whole.
    // Written at A1 (no empty leading column) so the sheet is genuinely 2 columns wide.
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Balances');
    const grid: [string, number][] = [
      ['Checking', 1200],
      ['Savings', 8400],
      ['Credit', -300],
    ];
    ws.getCell('A1').value = 'Account';
    ws.getCell('B1').value = 'Balance';
    grid.forEach(([acct, bal], i) => {
      ws.getCell('A' + String(i + 2)).value = acct;
      ws.getCell('B' + String(i + 2)).value = bal;
    });
    const dir = mkdtempSync(join(tmpdir(), 'lattice-xlsx-'));
    dirs.push(dir);
    const path = join(dir, 'balances.xlsx');
    await wb.xlsx.writeFile(path);

    const rows = (await excelToRecords(path)).Balances!;
    expect(rows).toEqual([
      { Account: 'Checking', Balance: 1200 },
      { Account: 'Savings', Balance: 8400 },
      { Account: 'Credit', Balance: -300 },
    ]);
  });
});

/** Write a one-sheet workbook via direct cell writes + explicit merged ranges (the
 *  grouped-header shapes need mergeCells, which the grid helper cannot express). */
async function writeMergedSheet(
  sheet: string,
  build: (ws: import('exceljs').Worksheet) => void,
): Promise<string> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  build(ws);
  const dir = mkdtempSync(join(tmpdir(), 'lattice-xlsx-'));
  dirs.push(dir);
  const path = join(dir, 'merged.xlsx');
  await wb.xlsx.writeFile(path);
  return path;
}

describe('excelToRecords — grouped (two-row) headers', () => {
  it('combines a merged band row + label row into human-readable column names', async () => {
    // The classic grouped layout: a full-width merged title, then a BAND row of merged
    // period labels (Q1 over two columns, Q2 over two columns) with a vertical "Region"
    // stub merged through both header rows, then the label row, then data. A human reads
    // the columns as "Q1 Revenue", "Q1 Costs", ... — the importer must too. Column F has
    // a label but no band above it: its name stays the plain label.
    const path = await writeMergedSheet('Quarters', (ws) => {
      ws.mergeCells('A1:E1');
      ws.getCell('A1').value = 'Acme Quarterly Report'; // title, NOT a band
      ws.mergeCells('A2:A3'); // vertical stub: one label spanning both header rows
      ws.getCell('A2').value = 'Region';
      ws.mergeCells('B2:C2');
      ws.getCell('B2').value = 'Q1';
      ws.mergeCells('D2:E2');
      ws.getCell('D2').value = 'Q2';
      ws.getCell('B3').value = 'Revenue';
      ws.getCell('C3').value = 'Costs';
      ws.getCell('D3').value = 'Revenue';
      ws.getCell('E3').value = 'Costs';
      ws.getCell('F3').value = 'Notes'; // label-only column (no band above)
      const data: unknown[][] = [
        ['East', 10, 5, 12, 6, 'ok'],
        ['West', 20, 7, 22, 8, 'meh'],
      ];
      data.forEach((row, i) => {
        row.forEach((v, j) => {
          ws.getCell(4 + i, 1 + j).value = v as import('exceljs').CellValue;
        });
      });
    });
    const rows = (await excelToRecords(path)).Quarters!;
    // Exact records: band+label combined names, the vertical stub collapsed to its single
    // label (never "Region Region"), no duplicate-suffix names ("Revenue 2"), no title text.
    expect(rows).toEqual([
      {
        Region: 'East',
        'Q1 Revenue': 10,
        'Q1 Costs': 5,
        'Q2 Revenue': 12,
        'Q2 Costs': 6,
        Notes: 'ok',
      },
      {
        Region: 'West',
        'Q1 Revenue': 20,
        'Q1 Costs': 7,
        'Q2 Revenue': 22,
        'Q2 Costs': 8,
        Notes: 'meh',
      },
    ]);
  });

  it('does not mistake a merged full-width title for a band (or a header)', async () => {
    // A single merged cell spanning the table is a TITLE: exceljs proxies its value into
    // every covered cell, so by raw cell counts the row looks dense — but it carries ONE
    // value and must be skipped, with the real single-row header used as-is beneath it.
    const path = await writeMergedSheet('Sales', (ws) => {
      ws.mergeCells('A1:C1');
      ws.getCell('A1').value = 'Sales Report';
      ws.getCell('A2').value = 'Code';
      ws.getCell('B2').value = 'Name';
      ws.getCell('C2').value = 'Amount';
      ws.getCell('A3').value = 'X';
      ws.getCell('B3').value = 'Xco';
      ws.getCell('C3').value = 9;
      ws.getCell('A4').value = 'Y';
      ws.getCell('B4').value = 'Yco';
      ws.getCell('C4').value = 4;
    });
    const rows = (await excelToRecords(path)).Sales!;
    expect(rows).toEqual([
      { Code: 'X', Name: 'Xco', Amount: 9 },
      { Code: 'Y', Name: 'Yco', Amount: 4 },
    ]);
    // The title text never leaks into a column name.
    for (const key of Object.keys(rows[0]!)) expect(key).not.toMatch(/sales report/i);
  });

  it('leaves single-row-header sheets without merges exactly as before', async () => {
    // No merges anywhere → the pre-grouped-header detection path runs unchanged.
    const path = await writeGridSheet('Plain', [
      ['Code', 'Name', 'Amount'],
      ['A', 'Alpha', 10],
      ['B', 'Beta', 20],
    ]);
    expect((await excelToRecords(path)).Plain).toEqual([
      { Code: 'A', Name: 'Alpha', Amount: 10 },
      { Code: 'B', Name: 'Beta', Amount: 20 },
    ]);
  });

  it('keeps a cosmetic merged header cell on a single-row header out of the band path', async () => {
    // A merged header cell with plain DATA (not a second label row) beneath it is not a
    // grouped header: only one cell is filled under the merge span per row, so the band
    // rule does not fire and the row imports as an ordinary (proxied) single-row header.
    const path = await writeMergedSheet('Wide', (ws) => {
      ws.mergeCells('A1:B1'); // cosmetic width merge over ONE logical column
      ws.getCell('A1').value = 'Fund';
      ws.getCell('C1').value = 'Vintage';
      ws.getCell('D1').value = 'Size';
      ws.getCell('A2').value = 'Alpha';
      ws.getCell('C2').value = 2022;
      ws.getCell('D2').value = 100;
      ws.getCell('A3').value = 'Beta';
      ws.getCell('C3').value = 2018;
      ws.getCell('D3').value = 250;
    });
    const rows = (await excelToRecords(path)).Wide!;
    // Row 1 stays the header (the merge proxies "Fund" into A and B — the de-dup suffix
    // is the long-standing single-row behavior); row 2 is DATA, not a label row.
    expect(rows).toEqual([
      { Fund: 'Alpha', Vintage: 2022, Size: 100 },
      { Fund: 'Beta', Vintage: 2018, Size: 250 },
    ]);
  });
});
