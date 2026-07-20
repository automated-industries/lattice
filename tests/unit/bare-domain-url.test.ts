import { describe, it, expect } from 'vitest';
import { normalizeUserUrl, assertSafeUrl } from '../../src/sources/url-safety.js';
import { userProvidedUrl, normalizeUrl } from '../../src/gui/ai/handlers/row-mutations.js';
import { looksLikeUrl } from '../../src/gui/ingest-routes.js';

/**
 * Bug: the user wrote "Enrich the data using automatedindustries.ai" (a bare domain, no scheme).
 * The model recognized it and called ingest_url, but the URL detectors were scheme-gated, so the
 * tool re-prompted for a full https:// URL. Fix: a single deterministic normalizeUserUrl helper
 * infers https:// for a bare domain, wired into every detector — WITHOUT relaxing any SSRF guard.
 */

describe('normalizeUserUrl', () => {
  it('infers https:// for a bare domain the user typed', () => {
    expect(normalizeUserUrl('automatedindustries.ai')).toBe('https://automatedindustries.ai/');
    expect(normalizeUserUrl('sub.example.co.uk/path?q=1')).toBe(
      'https://sub.example.co.uk/path?q=1',
    );
  });
  it('passes through a URL that already has a scheme', () => {
    expect(normalizeUserUrl('https://example.com/p')).toBe('https://example.com/p');
    expect(normalizeUserUrl('http://example.com')).toBe('http://example.com/');
  });
  it('returns null for a token that is not a web address', () => {
    expect(normalizeUserUrl('e.g')).toBeNull(); // 1-char TLD
    expect(normalizeUserUrl('just some words')).toBeNull();
    expect(normalizeUserUrl('')).toBeNull();
    expect(normalizeUserUrl('localhost')).toBeNull(); // no TLD → not a bare-domain match
  });
});

describe('userProvidedUrl accepts a bare domain the user wrote (regression)', () => {
  it('matches a scheme-less domain in the message against the tool arg', () => {
    expect(
      userProvidedUrl('Enrich the data using automatedindustries.ai', 'automatedindustries.ai'),
    ).toBe(true);
  });
  it('still matches a scheme-prefixed URL', () => {
    expect(
      userProvidedUrl('please read https://example.com/page', 'https://example.com/page'),
    ).toBe(true);
  });
  it('still matches a scheme-prefixed IP-host URL (the widened regex must not drop these)', () => {
    expect(
      userProvidedUrl('read https://93.184.216.34/post please', 'https://93.184.216.34/post'),
    ).toBe(true);
  });
  it('still refuses a URL the user did NOT write (the SSRF/prompt-injection gate holds)', () => {
    expect(userProvidedUrl('do something with my data', 'evil.example.com')).toBe(false);
  });
  it('normalizeUrl compares a bare domain equal to itself', () => {
    expect(normalizeUrl('automatedindustries.ai')).toBe('https://automatedindustries.ai');
  });
});

describe('assertSafeUrl infers the scheme but keeps every SSRF guard', () => {
  it('accepts a bare domain by inferring https:// (allowPrivate skips the DNS lookup here)', async () => {
    const u = await assertSafeUrl('automatedindustries.ai', true);
    expect(u.href).toBe('https://automatedindustries.ai/');
  });
  it('still rejects a non-http(s) scheme', async () => {
    await expect(assertSafeUrl('ftp://example.com')).rejects.toThrow(/non-http/i);
  });
  it('still rejects a loopback / private address', async () => {
    await expect(assertSafeUrl('http://127.0.0.1')).rejects.toThrow(/private/i);
  });
});

describe('looksLikeUrl (auto-ingest triage) accepts a bare domain', () => {
  it('treats a bare domain as a crawlable web address', () => {
    expect(looksLikeUrl('automatedindustries.ai')).toBe(true);
    expect(looksLikeUrl('https://example.com/page')).toBe(true);
  });
  it('is not fooled by prose or a non-address token', () => {
    expect(looksLikeUrl('hello world')).toBe(false);
    expect(looksLikeUrl('e.g')).toBe(false);
    expect(looksLikeUrl('automatedindustries.ai and more text')).toBe(false); // multi-token body
  });
});
