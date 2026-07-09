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
  it('does NOT truncate at an in-table blank spacer row (single-gap tolerance)', async () => {
    // A header, 3 rows, a blank spacer, then 2 MORE rows in the same columns. The old reader
    // stopped at the first blank (keeping only 3); the block reader keeps all 5.
    const path = await writeGridSheet('Data', [
      ['Code', 'Name', 'Region', 'Amount'],
      ['A', 'Alpha', 'East', 10],
      ['B', 'Beta', 'West', 20],
      ['C', 'Gamma', 'East', 30],
      null, // in-table spacer
      ['D', 'Delta', 'West', 40],
      ['E', 'Epsilon', 'East', 50],
    ]);
    const rows = (await excelToRecords(path)).Data!;
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.Code)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(excelImportWarnings(path)).toEqual([]); // one table, nothing left behind
  });

  it('imports the LARGEST table on a stacked-table sheet and warns about the rest', async () => {
    // A small summary table, a REAL gap (two blank rows → not bridged), then a larger detail
    // table. The old reader kept the FIRST (summary); the block reader keeps the largest.
    const path = await writeGridSheet('Book', [
      ['Code', 'Name', 'Region', 'Amount'], // summary header
      ['S1', 'Sum One', 'East', 1],
      ['S2', 'Sum Two', 'West', 2],
      null,
      null, // two blanks → a real table boundary
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
});
