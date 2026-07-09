import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDelimited, csvToRecords } from '../../src/import/csv.js';
import { inferSchema } from '../../src/import/infer.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-csv-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('parseDelimited', () => {
  it('parses simple comma-separated rows', () => {
    expect(parseDelimited('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles a final row with no trailing newline', () => {
    expect(parseDelimited('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseDelimited('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a quoted field that contains the delimiter and a newline', () => {
    expect(parseDelimited('name,note\n"Doe, John","line1\nline2"\n')).toEqual([
      ['name', 'note'],
      ['Doe, John', 'line1\nline2'],
    ]);
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(parseDelimited('q\n"she said ""hi"""\n')).toEqual([['q'], ['she said "hi"']]);
  });

  it('auto-detects a semicolon delimiter', () => {
    expect(parseDelimited('a;b;c\n1;2;3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('auto-detects a tab delimiter', () => {
    expect(parseDelimited('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips a leading BOM', () => {
    expect(parseDelimited('﻿a,b\n1,2')[0]).toEqual(['a', 'b']);
  });

  it('preserves empty cells between delimiters', () => {
    expect(parseDelimited('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });
});

describe('csvToRecords', () => {
  it('reads a CSV into {entity: rows}, keyed by the file name, coercing clean numbers', () => {
    const path = writeFile('customers.csv', 'name,revenue,region\nAcme,300,East\nBeta,500,West\n');
    const out = csvToRecords(path, 'customers.csv');
    expect(Object.keys(out)).toEqual(['customers']);
    expect(out.customers).toEqual([
      { name: 'Acme', revenue: 300, region: 'East' },
      { name: 'Beta', revenue: 500, region: 'West' },
    ]);
    // Coerced numbers type the column numerically through the real inference pipeline.
    const schema = inferSchema(out);
    const entity = schema.entities.find((e) => e.name === 'customers');
    expect(entity?.columns.find((c) => c.name === 'revenue')?.type).toBe('integer');
  });

  it('keeps ids with leading zeros (and dates) as strings, not numbers', () => {
    const path = writeFile('t.csv', 'code,when,amount\n007,2021-03-31,42\n');
    const out = csvToRecords(path, 't.csv');
    expect(out.t![0]).toEqual({ code: '007', when: '2021-03-31', amount: 42 });
  });

  it('de-dups repeated / blank header names', () => {
    const path = writeFile('d.csv', 'a,a,,b\n1,2,3,4\n');
    const out = csvToRecords(path, 'd.csv');
    expect(Object.keys(out.d![0]!).sort()).toEqual(['a', 'a 2', 'b', 'column_3']);
  });

  it('returns {} for an empty file or a header-only file', () => {
    expect(csvToRecords(writeFile('e.csv', ''), 'e.csv')).toEqual({});
    expect(csvToRecords(writeFile('h.csv', 'a,b,c\n'), 'h.csv')).toEqual({});
  });

  it('imports every row of a large file — no summarizing or dropping', () => {
    const lines = ['id,name'];
    for (let i = 1; i <= 200; i++) lines.push(`${String(i)},Row ${String(i)}`);
    const path = writeFile('big.csv', lines.join('\n'));
    const out = csvToRecords(path, 'big.csv');
    expect(out.big).toHaveLength(200);
  });
});
