import { describe, expect, it } from 'vitest';
import { detectAsOf, detectAsOfCandidates, scanText } from '../../src/import/asof.js';

describe('detectAsOf', () => {
  it('reads a US-format date near the end, ignoring a leading section number', () => {
    // "2.2.4" must NOT be read as a date (year 2004 is filtered as implausible);
    // the real snapshot date "3.31.26" wins.
    expect(detectAsOf('2.2.4 Track Record File - 3.31.26.xlsx')).toBe('2026-03-31');
  });

  it('reads ISO dates', () => {
    expect(detectAsOf('report_2026-03-31.xlsx')).toBe('2026-03-31');
    expect(detectAsOf('snapshot 2025.06.30.json')).toBe('2025-06-30');
  });

  it('reads US dates with various separators + 2- or 4-digit years', () => {
    expect(detectAsOf('data 6.30.25.xlsx')).toBe('2025-06-30');
    expect(detectAsOf('q1 3/31/2026.xlsx')).toBe('2026-03-31');
    expect(detectAsOf('export-12-31-24.csv')).toBe('2024-12-31');
  });

  it('returns null when there is no plausible date', () => {
    expect(detectAsOf('book.xlsx')).toBeNull();
    expect(detectAsOf('2.2.4-portfolio.xlsx')).toBeNull(); // 2004 is implausible → ignored
    expect(detectAsOf('')).toBeNull();
  });

  it('rejects impossible month/day', () => {
    expect(detectAsOf('weird 13.40.26.xlsx')).toBeNull();
  });
});

describe('scanText (in-content detection)', () => {
  it('finds an "as of" phrase with high confidence + evidence, incl. long-month form', () => {
    const c = scanText(
      'Acme Capital — Track Record\n(USD in thousands) as of March 31, 2026',
      'title',
    );
    expect(c[0]?.date).toBe('2026-03-31');
    expect(c[0]?.confidence).toBeGreaterThan(0.9);
    expect(c[0]?.source).toBe('content');
    expect(c[0]?.evidence).toContain('March 31, 2026');
  });

  it('finds a bare date but with lower confidence than a keyworded one', () => {
    const bare = scanText('printed 06/30/2025 footer', 'footer')[0];
    const keyworded = scanText('period ended 06/30/2025', 'title')[0];
    expect(bare?.date).toBe('2025-06-30');
    expect(keyworded!.confidence).toBeGreaterThan(bare!.confidence);
  });
});

describe('detectAsOfCandidates (ranking across signals)', () => {
  it('ranks an in-content "as of" date above a filename date', () => {
    const cands = detectAsOfCandidates({
      fileName: 'export 12.31.2025.xlsx',
      texts: [{ label: 'title', text: 'Report as of 3/31/2026' }],
    });
    expect(cands[0]?.date).toBe('2026-03-31'); // content beats filename
    expect(cands[0]?.source).toBe('content');
    expect(cands.map((c) => c.date)).toContain('2025-12-31'); // filename still offered
  });

  it('falls back to the filename when there is no in-content date', () => {
    const cands = detectAsOfCandidates({ fileName: 'snapshot 3.31.26.xlsx', texts: [] });
    expect(cands[0]?.date).toBe('2026-03-31');
    expect(cands[0]?.source).toBe('filename');
  });
});
