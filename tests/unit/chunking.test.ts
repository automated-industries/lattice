import { describe, it, expect } from 'vitest';
import { semanticChunker, chunkText } from '../../src/search/chunking.js';

describe('semanticChunker', () => {
  it('returns a single chunk for short text', () => {
    const chunks = semanticChunker({ maxChars: 1000 })('hello world');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, content: 'hello world', start: 0, end: 11 });
  });

  it('returns no chunks for empty / whitespace-only text', () => {
    expect(semanticChunker()('')).toEqual([]);
    expect(semanticChunker()('   \n  ')).toEqual([]);
  });

  it('splits at paragraph boundaries and covers the whole text contiguously', () => {
    const text = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.';
    const chunks = semanticChunker({ maxChars: 25 })(text);
    expect(chunks.length).toBeGreaterThan(1);
    // every chunk's content matches its offsets
    for (const c of chunks) expect(c.content).toBe(text.slice(c.start, c.end));
    // indices are sequential
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    // overlap=0 → fully covers the text with no gap
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[chunks.length - 1]!.end).toBe(text.length);
    let prevEnd = 0;
    for (const c of chunks) {
      expect(c.start).toBe(prevEnd);
      prevEnd = c.end;
    }
    // first chunk breaks at the paragraph, not mid-word
    expect(chunks[0]!.content).toBe('First paragraph here.\n\n');
  });

  it('applies overlap so the next chunk repeats trailing context', () => {
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj';
    const chunks = semanticChunker({ maxChars: 20, overlap: 6 })(text);
    expect(chunks.length).toBeGreaterThan(1);
    // chunk 2 starts before chunk 1 ends (overlap)
    expect(chunks[1]!.start).toBeLessThan(chunks[0]!.end);
  });

  it('hard-splits text with no soft boundary', () => {
    const text = 'x'.repeat(50);
    const chunks = semanticChunker({ maxChars: 20 })(text);
    expect(chunks).toHaveLength(3); // 20 + 20 + 10
    expect(chunks[0]!.content.length).toBe(20);
  });

  it('rejects invalid options', () => {
    expect(() => semanticChunker({ maxChars: 0 })).toThrow(/maxChars/);
    expect(() => semanticChunker({ maxChars: 10, overlap: 10 })).toThrow(/overlap/);
  });
});

describe('chunkText', () => {
  it('returns one chunk when no chunker is given', () => {
    expect(chunkText('hello')).toEqual([{ chunkIndex: 0, content: 'hello' }]);
  });

  it('prepends a context prefix to every chunk', () => {
    const out = chunkText('body text', semanticChunker({ maxChars: 1000 }), 'Title');
    expect(out[0]!.content).toBe('Title\n\nbody text');
  });

  it('chunks and prefixes each chunk', () => {
    const text = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.';
    const out = chunkText(text, semanticChunker({ maxChars: 25 }), 'Doc');
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.content.startsWith('Doc\n\n')).toBe(true);
    expect(out.map((c) => c.chunkIndex)).toEqual(out.map((_, i) => i));
  });
});
