import { describe, it, expect } from 'vitest';
import { isPostgresUrl } from '../../src/cloud/url.js';

describe('isPostgresUrl', () => {
  it('accepts postgres:// and postgresql://', () => {
    expect(isPostgresUrl('postgres://user:pass@host/db')).toBe(true);
    expect(isPostgresUrl('postgresql://user:pass@host/db')).toBe(true);
    expect(isPostgresUrl('POSTGRES://user:pass@host/db')).toBe(true);
  });
  it('rejects http(s) and other schemes', () => {
    expect(isPostgresUrl('http://example.com')).toBe(false);
    expect(isPostgresUrl('https://example.com')).toBe(false);
    expect(isPostgresUrl('file:./local.db')).toBe(false);
    expect(isPostgresUrl('/tmp/local.db')).toBe(false);
  });
});
