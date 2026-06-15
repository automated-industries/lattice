import { describe, it, expect } from 'vitest';
import { parseActiveContext } from '../../src/gui/chat-routes.js';

/**
 * #D — the chat carries the record the user is viewing as `activeContext` so
 * "delete this file" resolves. The server validates the client hint: the table
 * MUST be a known table (a bogus hint can't inject a fake table name into the
 * system prompt) and the id a short non-empty string. Access is still enforced
 * by the permission-gated tools — this only resolves the deictic reference.
 */
const valid = new Set(['files', 'contacts']);

describe('#D parseActiveContext', () => {
  it('accepts a known table + id', () => {
    expect(parseActiveContext({ table: 'files', id: 'abc' }, valid)).toEqual({
      table: 'files',
      id: 'abc',
    });
  });
  it('trims the id', () => {
    expect(parseActiveContext({ table: 'files', id: '  abc  ' }, valid)?.id).toBe('abc');
  });
  it('rejects an unknown table (no fake-table injection)', () => {
    expect(parseActiveContext({ table: 'evil', id: 'x' }, valid)).toBeUndefined();
  });
  it('rejects missing / non-string / empty / oversized fields', () => {
    expect(parseActiveContext(null, valid)).toBeUndefined();
    expect(parseActiveContext({ table: 'files' }, valid)).toBeUndefined();
    expect(parseActiveContext({ table: 'files', id: 42 }, valid)).toBeUndefined();
    expect(parseActiveContext({ table: 'files', id: '' }, valid)).toBeUndefined();
    expect(parseActiveContext({ table: 'files', id: 'x'.repeat(300) }, valid)).toBeUndefined();
  });
});
