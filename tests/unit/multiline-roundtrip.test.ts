import { describe, it, expect } from 'vitest';
import { renderFieldBullet } from '../../src/framework/canonical-context.js';
import { parseEntityProfileContent } from '../../src/reverse-seed/engine.js';
import { deriveUpdatesFromFile } from '../../src/reverse-sync/default-reverse-sync.js';
import type { Row } from '../../src/types.js';

/**
 * Multi-line field round-trip (finding #13). The default renderer used to inline
 * a value's newlines into a single `- **key:** value` bullet, and the reverse-sync
 * parser read one line per field — so a multi-line value was silently truncated to
 * its first line on the next save. The renderer now writes 2-space-indented
 * continuation lines and the parser accumulates them, so a value survives a full
 * render → parse → render cycle. These pin that contract, including the shapes that
 * would otherwise confuse the parser (values that look like bullets, headings, or
 * key:value lines) and the neighbor-edit case that first exposed the bug.
 */

/** Compose a self-block exactly like renderSelf: `# Title\n\n<bullets>\n`. */
function block(fields: Record<string, unknown>): string {
  const bullets = Object.entries(fields)
    .map(([k, v]) => renderFieldBullet(k, v))
    .join('\n');
  return `# Title\n\n${bullets}\n`;
}

function roundTrip(fields: Record<string, unknown>): Record<string, unknown> {
  return parseEntityProfileContent(block(fields));
}

describe('multi-line field round-trip', () => {
  it('renders a single-line value inline and round-trips it', () => {
    expect(renderFieldBullet('name', 'Alpha')).toBe('- **name:** Alpha');
    expect(roundTrip({ name: 'Alpha' })).toEqual({ name: 'Alpha' });
  });

  it('renders a multi-line value with indented continuation lines', () => {
    expect(renderFieldBullet('body', 'one\ntwo\nthree')).toBe('- **body:** one\n  two\n  three');
  });

  it('round-trips a multi-line value fully (not truncated to the first line)', () => {
    const body = 'Para one.\nPara two.\nPara three.';
    expect(roundTrip({ body }).body).toBe(body);
  });

  it('preserves an interior blank line inside a value', () => {
    const body = 'Para one.\n\nPara three.';
    expect(roundTrip({ body }).body).toBe(body);
  });

  it("round-trips a value whose lines look like bullets or 'key: value' pairs", () => {
    const body = '- item one\n- **fake:** not a field\nplain: text';
    expect(roundTrip({ body }).body).toBe(body);
  });

  it('round-trips a value whose lines look like headings or dividers', () => {
    const body = '# heading-like\n---\n> quote-like';
    expect(roundTrip({ body }).body).toBe(body);
  });

  it("preserves a value line's own indentation (only the 2-space marker is stripped)", () => {
    const body = 'root\n  indented child\n    deeper';
    expect(roundTrip({ body }).body).toBe(body);
  });

  it('does not let a multi-line field swallow the following field', () => {
    expect(roundTrip({ body: 'line1\nline2', status: 'open' })).toEqual({
      body: 'line1\nline2',
      status: 'open',
    });
  });

  it('is idempotent across render → parse → render (incl. an interior blank line)', () => {
    const once = block({ body: 'A\nB\n\nC', name: 'X' });
    const twice = block(parseEntityProfileContent(once));
    expect(twice).toBe(once);
  });

  it('preserves a multi-line neighbor when only another field is edited (#13)', () => {
    const row: Row = { id: 'r1', body: 'Line 1\nLine 2\nLine 3', status: 'open' };
    // The file as rendered from the row, then the user changes status open → done.
    const edited = block({ body: row.body, status: 'done' });
    const updates = deriveUpdatesFromFile(edited, row, { table: 't', pkCols: ['id'] });
    // Exactly one update — status — with the multi-line body left intact (not
    // dropped to its first line, which is the regression this whole feature fixes).
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set).toEqual({ status: 'done' });
  });

  it('detects a genuine edit to a multi-line field', () => {
    const row: Row = { id: 'r1', body: 'Line 1\nLine 2', status: 'open' };
    const edited = block({ body: 'Line 1\nLine 2 EDITED', status: 'open' });
    const updates = deriveUpdatesFromFile(edited, row, { table: 't', pkCols: ['id'] });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set).toEqual({ body: 'Line 1\nLine 2 EDITED' });
  });
});
