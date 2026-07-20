import { describe, it, expect } from 'vitest';
import { crawlHopAllowed } from '../../src/ai/crawl.js';

/**
 * Regression (S6): the headless-browser (Playwright) crawl fallback follows redirects itself, so
 * a bot-protected page could 403 the plain fetch and then 302 the Chromium retry to an internal
 * host / cloud metadata — content returned as text. Each navigation + subresource is now
 * re-validated per hop by `crawlHopAllowed` (a `page.route` guard that aborts unsafe requests).
 * These tests pin the per-hop decision. IP literals skip DNS, so no network is touched.
 */
describe('crawlHopAllowed — per-hop SSRF re-validation for the browser crawl (S6)', () => {
  it('BLOCKS a redirect hop to cloud metadata / loopback / private, incl. IPv6-mapped forms', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://[::ffff:a9fe:a9fe]/latest/meta-data/', // hex IPv4-mapped IMDS (the S3 bypass)
      'http://127.0.0.1:8080/',
      'http://[::1]/',
      'http://10.0.0.5/internal',
      'http://192.168.1.1/',
    ]) {
      expect(await crawlHopAllowed(url, false)).toBe(false);
    }
  });

  it('ALLOWS a genuinely public host', async () => {
    expect(await crawlHopAllowed('http://8.8.8.8/', false)).toBe(true); // public IP literal, no DNS
    expect(await crawlHopAllowed('http://1.1.1.1/', false)).toBe(true);
  });

  it('honors allowPrivate (an explicitly-permitted internal crawl)', async () => {
    expect(await crawlHopAllowed('http://127.0.0.1/', false)).toBe(false);
    expect(await crawlHopAllowed('http://127.0.0.1/', true)).toBe(true);
  });

  it('BLOCKS a non-http scheme (file:, gopher:) a redirect could target', async () => {
    expect(await crawlHopAllowed('file:///etc/passwd', false)).toBe(false);
    expect(await crawlHopAllowed('gopher://127.0.0.1/', false)).toBe(false);
  });
});
