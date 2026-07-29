import { describe, expect, it } from 'vitest';
import {
  MAX_WORKBOOK_TABLES,
  parseSheetFileRef,
  sheetFileRef,
  splitSheetJobs,
} from '../../src/import/sheet-jobs.js';

// ─────────────────────────────────────────────────────────────────────────────
// The per-sheet split primitive: one small import unit per source sheet, so a
// large workbook lands as many ordinary imports instead of one over-cap plan.
// ─────────────────────────────────────────────────────────────────────────────

describe('splitSheetJobs', () => {
  it('isolates each record-array key into its own single-key sub-source', () => {
    const data = {
      funds: [{ code: 'EP' }],
      investments: [{ company: 'Acme' }],
    };
    const jobs = splitSheetJobs(data);
    expect(jobs.map((j) => j.key)).toEqual(['funds', 'investments']);
    // Each job's data is JUST its own key — no other sheet bleeds in.
    expect(jobs[0]!.data).toEqual({ funds: [{ code: 'EP' }] });
    expect(jobs[1]!.data).toEqual({ investments: [{ company: 'Acme' }] });
  });

  it('preserves source-key order (a workbook imports its sheets left-to-right)', () => {
    const data: Record<string, unknown> = {};
    for (let i = 0; i < 6; i++) data['sheet' + String(i)] = [{ id: i }];
    expect(splitSheetJobs(data).map((j) => j.key)).toEqual([
      'sheet0',
      'sheet1',
      'sheet2',
      'sheet3',
      'sheet4',
      'sheet5',
    ]);
  });

  it('carries a paired <key>Cols header block with its base key, and never as its own job', () => {
    const data = {
      grossDeploy: [[2022, 'Fund GG']],
      grossDeployCols: ['year', 'fund'],
    };
    const jobs = splitSheetJobs(data);
    // Only ONE job — the Cols block is metadata for grossDeploy, not a table.
    expect(jobs.map((j) => j.key)).toEqual(['grossDeploy']);
    // …and it travels WITH its base key so single-sheet inference still sees the headers.
    expect(jobs[0]!.data).toEqual({
      grossDeploy: [[2022, 'Fund GG']],
      grossDeployCols: ['year', 'fund'],
    });
  });

  it('ignores non-array keys (scalars, metadata objects)', () => {
    const data = {
      meta: { title: 'X' },
      note: 'just a string',
      rows: [{ a: 1 }],
    };
    expect(splitSheetJobs(data).map((j) => j.key)).toEqual(['rows']);
  });

  it('returns no jobs for a source with no record arrays', () => {
    expect(splitSheetJobs({ greeting: 'hi', count: 3 })).toEqual([]);
  });
});

describe('sheetFileRef / parseSheetFileRef', () => {
  it('gives two sheets of the SAME file distinct references', () => {
    const fileId = 'file-abc';
    const a = sheetFileRef(fileId, 'Funds');
    const b = sheetFileRef(fileId, 'Investments');
    expect(a).not.toBe(b);
    // Distinct even for many sheets — one ref per sheet.
    const refs = new Set(
      Array.from({ length: 60 }, (_, i) => sheetFileRef(fileId, 'Sheet ' + String(i))),
    );
    expect(refs.size).toBe(60);
  });

  it('round-trips a base id and sheet name (including one with a #)', () => {
    const round = (id: string, sheet: string) => parseSheetFileRef(sheetFileRef(id, sheet));
    expect(round('file-abc', 'Funds')).toEqual({ fileId: 'file-abc', sheet: 'Funds' });
    // A sheet name containing the separator survives because it is percent-encoded.
    expect(round('file-abc', 'Q1 #1')).toEqual({ fileId: 'file-abc', sheet: 'Q1 #1' });
  });

  it('reads a bare files-row id as the whole file (sheet null)', () => {
    expect(parseSheetFileRef('file-abc')).toEqual({ fileId: 'file-abc', sheet: null });
  });
});

describe('MAX_WORKBOOK_TABLES', () => {
  it('clears a large multi-tab workbook with room to spare', () => {
    // 77 sheets at even a handful of tables each stays well under the ceiling.
    expect(MAX_WORKBOOK_TABLES).toBeGreaterThan(77 * 6);
  });
});
