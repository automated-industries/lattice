import { describe, it, expect } from 'vitest';
import { guardReservedColumns, type MutationCtx } from '../../src/gui/mutations.js';

/**
 * Regression (S1/S2 round-2): the files byte-location deny-list must live at the createRow/
 * updateRow CHOKEPOINT (guardReservedColumns), not only on the HTTP route — otherwise the AI
 * create_row / update_row / bulk_update tools (which call createRow directly) let a cloud member
 * forge a `files` row's ref_uri / source_json / blob_path and read another member's S3 object or
 * an arbitrary host path via the blob / import route. Only the trusted ingest/upload writer
 * (allowFileLocationCols) may set them.
 */
const ctx = (flags: Partial<MutationCtx> = {}): MutationCtx => flags as MutationCtx;

describe('guardReservedColumns — files byte-location columns (S1/S2 chokepoint)', () => {
  for (const col of ['ref_kind', 'ref_uri', 'ref_provider', 'blob_path', 'source_json']) {
    it(`refuses a generic write that sets files.${col}`, () => {
      expect(() => {
        guardReservedColumns(ctx(), 'files', { [col]: 'x' });
      }).toThrow(/location columns/i);
    });
  }

  it('the exploit shape (forged S3 ref) is refused', () => {
    expect(() => {
      guardReservedColumns(ctx(), 'files', {
        ref_kind: 'cloud_ref',
        ref_provider: 's3',
        source_json: JSON.stringify({ bucket: 'victim', key: 'secret' }),
      });
    }).toThrow(/location columns/i);
  });

  it('the trusted ingest/upload writer MAY set them (allowFileLocationCols)', () => {
    expect(() => {
      guardReservedColumns(ctx({ allowFileLocationCols: true }), 'files', {
        ref_kind: 'local_ref',
        ref_uri: '/tmp/ingested.pdf',
      });
    }).not.toThrow();
  });

  it('metadata-only files writes are unaffected', () => {
    expect(() => {
      guardReservedColumns(ctx(), 'files', { original_name: 'x', mime: 'text/plain', tags: 'a' });
    }).not.toThrow();
  });

  it('the guard is files-scoped — a non-files table with a ref_uri column is fine', () => {
    expect(() => {
      guardReservedColumns(ctx(), 'bookmarks', { ref_uri: 'https://x' });
    }).not.toThrow();
  });

  it('still reserves the executable-artifact marker (artifact_type=html) independently', () => {
    expect(() => {
      guardReservedColumns(ctx(), 'files', { artifact_type: 'html' });
    }).toThrow(/executable/i);
    // The trusted authoring tools bypass THAT check via allowReservedFileCols (but still can't set
    // location columns without allowFileLocationCols).
    expect(() => {
      guardReservedColumns(ctx({ allowReservedFileCols: true }), 'files', {
        artifact_type: 'html',
      });
    }).not.toThrow();
  });
});
