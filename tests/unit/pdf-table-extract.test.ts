import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pdfItemsToGrid, pdfToRecords, type PdfTextItem } from '../../src/import/pdf-tables.js';

/**
 * A PDF carries no table structure — only glyphs at coordinates. A ruled table is
 * recovered from that geometry: text on a shared baseline is one row, text sharing
 * an x position DOWN the page is one column. These tests pin both the pure geometry
 * pass and the end-to-end read of a real PDF, including the cases where there is no
 * table and one must not be invented.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Minimal single-page PDF placing each string at an absolute (x, y). */
function buildPdf(items: { x: number; y: number; text: string }[]): Buffer {
  const esc = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const ops = ['BT', '/F1 10 Tf'];
  for (const it of items) {
    ops.push(`1 0 0 1 ${String(it.x)} ${String(it.y)} Tm`, `(${esc(it.text)}) Tj`);
  }
  ops.push('ET');
  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(Buffer.byteLength(content))} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${String(objs.length + 1)}\n0000000000 65535 f \n`;
  for (const o of offsets) out += String(o).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${String(objs.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefAt)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function writePdf(name: string, items: { x: number; y: number; text: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-pdftbl-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, buildPdf(items));
  return path;
}

/** Three columns at fixed x, one header row and two data rows. */
const RULED_TABLE = [
  { x: 72, y: 700, text: 'Name' },
  { x: 220, y: 700, text: 'Region' },
  { x: 360, y: 700, text: 'Students' },
  { x: 72, y: 680, text: 'North High' },
  { x: 220, y: 680, text: 'North' },
  { x: 360, y: 680, text: '412' },
  { x: 72, y: 660, text: 'South High' },
  { x: 220, y: 660, text: 'South' },
  { x: 360, y: 660, text: '388' },
];

function item(x: number, y: number, str: string): PdfTextItem {
  return { str, x, y, width: str.length * 5, height: 10 };
}

describe('pdf text geometry to a grid', () => {
  it('recovers rows and columns from text sharing baselines and x positions', () => {
    const items = RULED_TABLE.map((i) => item(i.x, i.y, i.text));
    const grid = pdfItemsToGrid(items);
    expect(grid).toEqual([
      ['Name', 'Region', 'Students'],
      ['North High', 'North', '412'],
      ['South High', 'South', '388'],
    ]);
  });

  it('reads the page top-down regardless of the order glyphs were drawn in', () => {
    // Nothing requires a PDF to emit its text in reading order.
    const shuffled = [...RULED_TABLE].reverse().map((i) => item(i.x, i.y, i.text));
    expect(pdfItemsToGrid(shuffled)[0]).toEqual(['Name', 'Region', 'Students']);
  });

  it('keeps an empty cell as an empty cell instead of shifting the row left', () => {
    const items = [
      item(72, 700, 'Name'),
      item(220, 700, 'Region'),
      item(360, 700, 'Students'),
      item(72, 680, 'North High'),
      item(360, 680, '412'), // no region
    ];
    expect(pdfItemsToGrid(items)[1]).toEqual(['North High', '', '412']);
  });

  it('tolerates a baseline that is a fraction off rather than splitting the row', () => {
    const items = [
      item(72, 700, 'Name'),
      item(220, 700.4, 'Region'),
      item(72, 680, 'North High'),
      item(220, 679.6, 'North'),
    ];
    expect(pdfItemsToGrid(items)).toHaveLength(2);
  });

  it('finds no grid in prose, where nothing lines up down the page', () => {
    const items = [
      item(72, 700, 'This report describes the district and its intake process.'),
      item(72, 686, 'It was prepared for the board and covers the current year.'),
      item(72, 672, 'No tabular data appears anywhere on this page at all.'),
    ];
    expect(pdfItemsToGrid(items)).toEqual([]);
  });

  it('finds no grid in a single line of columns, which could be anything', () => {
    // One row proves no alignment: columns are only columns when they REPEAT.
    const items = [item(72, 700, 'Name'), item(220, 700, 'Region'), item(360, 700, 'Students')];
    expect(pdfItemsToGrid(items)).toEqual([]);
  });
});

describe('reading a real PDF', () => {
  it('extracts deterministic records from a ruled table', async () => {
    const path = writePdf('schools.pdf', RULED_TABLE);
    const out = await pdfToRecords(path, 'schools.pdf');
    const tables = Object.values(out);
    expect(tables).toHaveLength(1);
    const rows = tables[0] as Record<string, unknown>[];
    expect(rows).toEqual([
      { Name: 'North High', Region: 'North', Students: '412' },
      { Name: 'South High', Region: 'South', Students: '388' },
    ]);
  });

  it('produces the same records every time it reads the same bytes', async () => {
    const path = writePdf('stable.pdf', RULED_TABLE);
    const a = await pdfToRecords(path, 'stable.pdf');
    const b = await pdfToRecords(path, 'stable.pdf');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('names the table from the line above it when there is one', async () => {
    const path = writePdf('report.pdf', [
      { x: 72, y: 730, text: 'Enrolled Schools' },
      ...RULED_TABLE,
    ]);
    const out = await pdfToRecords(path, 'report.pdf');
    expect(Object.keys(out)).toContain('Enrolled Schools');
  });

  it('falls back to the document name when the table has no heading', async () => {
    const path = writePdf('district-roster.pdf', RULED_TABLE);
    const out = await pdfToRecords(path, 'district-roster.pdf');
    const key = Object.keys(out)[0] ?? '';
    expect(key.toLowerCase()).toContain('district');
  });

  it('returns nothing for a PDF of prose, rather than inventing a table', async () => {
    const path = writePdf('memo.pdf', [
      { x: 72, y: 700, text: 'This memo explains the intake process in detail.' },
      { x: 72, y: 686, text: 'There are no tables in it and none should be found.' },
    ]);
    expect(await pdfToRecords(path, 'memo.pdf')).toEqual({});
  });

  it('returns nothing for bytes that are not a PDF, rather than throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-pdftbl-'));
    dirs.push(dir);
    const path = join(dir, 'not-a.pdf');
    writeFileSync(path, 'plainly not a pdf at all');
    expect(await pdfToRecords(path, 'not-a.pdf')).toEqual({});
  });
});
