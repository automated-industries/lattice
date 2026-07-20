import { describe, it, expect } from 'vitest';
import { capAuditImage, AUDIT_TEXT_PREVIEW } from '../../src/gui/mutations.js';

// Phase 1b: a file's full `extracted_text` was copied verbatim into every audit
// row's before/after image (O(N) big blobs across a folder ingest). capAuditImage
// replaces a long extracted_text with a hash + short preview so audit rows — and
// every full-table scan of the audit log — stay small.

describe('capAuditImage', () => {
  it('caps a long extracted_text to a hash + preview, leaving other columns intact', () => {
    const big = 'x'.repeat(50_000);
    const out = capAuditImage({ id: 'a1', name: 'Doc', extracted_text: big }) as Record<
      string,
      unknown
    >;
    const et = String(out.extracted_text);
    // Much smaller than the original, carries the length + a sha256 marker + a preview.
    expect(et.length).toBeLessThan(600);
    expect(et).toContain('capped 50000 chars');
    expect(et).toMatch(/sha256:[0-9a-f]{16}/);
    // Other columns round-trip unchanged.
    expect(out.id).toBe('a1');
    expect(out.name).toBe('Doc');
  });

  it('leaves a short extracted_text (and non-files rows) untouched', () => {
    const shortRow = { id: 'b1', extracted_text: 'small' };
    expect(capAuditImage(shortRow)).toBe(shortRow); // same reference — no copy
    const noText = { id: 'c1', title: 'T' };
    expect(capAuditImage(noText)).toBe(noText);
    expect(capAuditImage(null)).toBeNull();
  });

  it('caps exactly above the preview threshold', () => {
    const atCap = { extracted_text: 'y'.repeat(AUDIT_TEXT_PREVIEW) };
    expect(capAuditImage(atCap)).toBe(atCap); // == threshold → untouched
    const overCap = { extracted_text: 'y'.repeat(AUDIT_TEXT_PREVIEW + 1) };
    expect(capAuditImage(overCap)).not.toBe(overCap); // > threshold → capped copy
  });
});
