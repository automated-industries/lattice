import { describe, it, expect } from 'vitest';
import {
  maskEncryptedJson,
  ENCRYPTED_VALUE_MASK,
  auditEntryWithoutImages,
} from '../../src/gui/mutations.js';

/**
 * Regression (S4 round-2): GET /api/history returns before_json / after_json audit images that
 * were captured via db.get (which DECRYPTS encrypted columns), so they must be masked before
 * leaving the process — the same credential leak S4 closed on /api/tables/:t/rows, via a route it
 * didn't touch. `secrets` entries are dropped entirely in the route; this covers the per-image
 * masking used for every other table's encrypted columns.
 */
describe('maskEncryptedJson — audit-image credential masking (S4)', () => {
  it('masks the encrypted columns in a row image, leaves the rest', () => {
    const img = JSON.stringify({ id: '1', name: 'gh', api_token: 'sk-secret-123', note: 'hi' });
    const out = maskEncryptedJson(img, new Set(['api_token']));
    const obj = JSON.parse(out!) as Record<string, unknown>;
    expect(obj.api_token).toBe(ENCRYPTED_VALUE_MASK);
    expect(obj.name).toBe('gh');
    expect(obj.note).toBe('hi');
    expect(out).not.toContain('sk-secret-123');
  });

  it('masks every encrypted column when several are present', () => {
    const img = JSON.stringify({ token: 'aaa', secret: 'bbb', plain: 'c' });
    const out = maskEncryptedJson(img, new Set(['token', 'secret']));
    const obj = JSON.parse(out!) as Record<string, unknown>;
    expect(obj.token).toBe(ENCRYPTED_VALUE_MASK);
    expect(obj.secret).toBe(ENCRYPTED_VALUE_MASK);
    expect(obj.plain).toBe('c');
  });

  it('is a no-op when the table has no encrypted columns', () => {
    const img = JSON.stringify({ a: 1 });
    expect(maskEncryptedJson(img, new Set())).toBe(img);
  });

  it('handles null / unparseable images without throwing', () => {
    expect(maskEncryptedJson(null, new Set(['x']))).toBeNull();
    expect(maskEncryptedJson('not json', new Set(['x']))).toBe('not json');
  });

  it('does not mask an absent, null, or empty encrypted value', () => {
    const img = JSON.stringify({ token: '', other: null });
    const out = maskEncryptedJson(img, new Set(['token', 'missing']));
    const obj = JSON.parse(out!) as Record<string, unknown>;
    expect(obj.token).toBe(''); // empty stays empty (nothing to leak)
    expect('missing' in obj).toBe(false);
  });
});

describe('auditEntryWithoutImages — undo/redo/revert echoes drop decrypted images (S4)', () => {
  it('strips before_json / after_json (which db.get decrypted) while keeping the metadata', () => {
    const entry = {
      id: 'a1',
      ts: '2026-07-20T00:00:00Z',
      table_name: 'integrations',
      row_id: 'r1',
      operation: 'update',
      before_json: JSON.stringify({ api_token: 'sk-CLEARTEXT' }),
      after_json: JSON.stringify({ api_token: 'sk-CLEARTEXT-2' }),
      undone: 0,
    };
    const out = auditEntryWithoutImages(entry);
    expect(out.before_json).toBeNull();
    expect(out.after_json).toBeNull();
    expect(JSON.stringify(out)).not.toContain('sk-CLEARTEXT');
    // Metadata the client needs to refresh the UI is preserved.
    expect(out.table_name).toBe('integrations');
    expect(out.row_id).toBe('r1');
    expect(out.operation).toBe('update');
  });
});
