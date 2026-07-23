import { describe, it, expect } from 'vitest';
import { extractObjects, type SchemaEntity } from '../../src/gui/ai/summarize.js';
import {
  extractionTruncationNote,
  chunkTextForExtraction,
} from '../../src/ai/summarize.js';
import type { LlmClient, TurnResult } from '../../src/gui/ai/chat.js';

// The section markers seeded through a big document. Windows are 12k wide,
// stepping by 11k (1k overlap). The doc is laid out so no window holds more than
// three markers (the per-call parseObjects cap), and OVERLAP straddles the
// window-0 / window-1 boundary so it is handed to the model twice.
const MARKERS = ['SEC1', 'SEC2', 'OVERLAP', 'SEC3', 'SEC4', 'SEC5'];

// A client that returns one object per marker present in the window it is handed
// (≤3, matching the real parseObjects cap), so the merge is what surfaces the
// sections spread across windows.
function markerClient(): { client: LlmClient; calls: () => number } {
  let calls = 0;
  const client: LlmClient = {
    runTurn(params): Promise<TurnResult> {
      calls += 1;
      const first = params.messages[0];
      const content = typeof first?.content === 'string' ? first.content : '';
      const found = MARKERS.filter((m) => content.includes(m));
      const objs = found.map((m) => ({
        entity: 'topic',
        isNew: false,
        label: m,
        columns: ['name'],
        values: { name: m },
      }));
      return Promise.resolve({ stopReason: 'end_turn', text: JSON.stringify(objs), toolUses: [] });
    },
  };
  return { client, calls: () => calls };
}

// Build a ~30k doc placing each marker at a controlled offset. SEC3/SEC4/SEC5 sit
// past the first 12k window (invisible to the pre-chunking single-slice path).
function buildDoc(): string {
  const parts: string[] = [];
  let pos = 0;
  const put = (offset: number, marker: string): void => {
    parts.push('x'.repeat(offset - pos));
    parts.push(marker);
    pos = offset + marker.length;
  };
  put(1000, 'SEC1');
  put(6000, 'SEC2');
  put(11500, 'OVERLAP'); // straddles the window-0 / window-1 overlap band
  put(13000, 'SEC3');
  put(19000, 'SEC4');
  put(25000, 'SEC5');
  parts.push('x'.repeat(30000 - pos));
  return parts.join('');
}

const schema: SchemaEntity[] = [];

describe('full-document object extraction (chunk + merge)', () => {
  it('surfaces sections past the first 12k, deduped across the overlap band', async () => {
    const doc = buildDoc();
    const { client, calls } = markerClient();
    const out = await extractObjects(client, doc, 'big.txt', schema);
    const labels = out.map((o) => o.label);

    // A ~30k doc is scanned in three overlapping windows.
    expect(calls()).toBe(chunkTextForExtraction(doc).length);
    expect(chunkTextForExtraction(doc).length).toBe(3);

    // All five sections surface — the pre-fix single-slice path returned only the
    // two markers inside the first 12k, so this fails before the fix.
    for (const s of ['SEC1', 'SEC2', 'SEC3', 'SEC4', 'SEC5']) {
      expect(labels).toContain(s);
    }
    // The overlap-band marker was handed to the model twice but merges to one.
    expect(labels.filter((l) => l === 'OVERLAP')).toHaveLength(1);
  });

  it('a small (≤12k) document makes exactly one extraction call (unchanged path)', async () => {
    const { client, calls } = markerClient();
    const out = await extractObjects(client, 'SEC1 then SEC2', 'small.txt', schema);
    expect(calls()).toBe(1);
    expect(out.map((o) => o.label).sort()).toEqual(['SEC1', 'SEC2']);
  });

  it('extractionTruncationNote is null within the window budget, non-null past it', () => {
    expect(extractionTruncationNote('f', 5_000)).toBeNull();
    expect(extractionTruncationNote('f', 30_000)).toBeNull();
    // Budget is 6 windows: 5·11k step + 12k window = 67k chars covered.
    expect(extractionTruncationNote('f', 67_000)).toBeNull();
    const note = extractionTruncationNote('big.txt', 120_000);
    expect(note).not.toBeNull();
    expect(note).toContain('67,000');
    expect(note).toContain('120,000');
  });
});
