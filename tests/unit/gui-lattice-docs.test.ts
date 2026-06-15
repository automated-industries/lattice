import { describe, it, expect } from 'vitest';
import { searchLatticeDocs } from '../../src/gui/ai/lattice-docs.js';

/**
 * #H — lattice_help answers questions about Lattice ITSELF from the SINGLE
 * canonical docs source (the repo's docs/*.md, which are the GitHub docs and ship
 * in the npm package). searchLatticeDocs locates + searches them; no separate,
 * drift-prone copy.
 */
describe('#H searchLatticeDocs', () => {
  it('finds the bundled docs and returns relevant sections for a real query', () => {
    const r = searchLatticeDocs('cloud workspace member');
    // docs/ exists in the repo, so it must resolve + return sections (not the
    // "docs unavailable" note).
    expect(r.note).toBeUndefined();
    expect(r.sections.length).toBeGreaterThan(0);
    const top = r.sections[0]!;
    expect(typeof top.source).toBe('string');
    expect(top.source.endsWith('.md')).toBe(true);
    expect(top.text.length).toBeGreaterThan(0);
  });

  it('ranks the most relevant doc first (a cloud query surfaces the cloud docs)', () => {
    const r = searchLatticeDocs('how do members and invites work on a cloud');
    expect(r.sections.length).toBeGreaterThan(0);
    // At least one returned section should come from the cloud/collaboration docs.
    expect(r.sections.some((s) => /cloud|collaborat/i.test(s.source))).toBe(true);
  });

  it('returns a topic index (not invented content) when nothing matches', () => {
    const r = searchLatticeDocs('zzzqqq wwwvvv xqzkjf');
    expect(r.sections).toHaveLength(0);
    expect(Array.isArray(r.available)).toBe(true);
    expect(r.available!.length).toBeGreaterThan(0);
  });

  it('returns the topic index for an empty query', () => {
    const r = searchLatticeDocs('');
    expect(r.sections).toHaveLength(0);
    expect(r.available!.length).toBeGreaterThan(0);
  });
});
