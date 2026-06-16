import { describe, it, expect } from 'vitest';
import { crawlUrl } from '../../src/ai/crawl.js';

function respondWith(bodyText: string, contentType = 'text/html'): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(bodyText, { status: 200, headers: { 'content-type': contentType } }),
    )) as unknown as typeof fetch;
}

describe('crawlUrl', () => {
  it('extracts readable text + title from HTML and strips scripts', async () => {
    const para = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const html = `<!doctype html><html><head><title>Doc Title</title></head><body>
      <article><h1>Heading</h1><p>${para}</p></article>
      <script>var secret = 1;</script></body></html>`;
    const r = await crawlUrl('https://example.com/post', {
      fetcher: respondWith(html),
      allowPrivate: true,
    });
    expect(r.title.length).toBeGreaterThan(0);
    expect(r.text).toMatch(/quick brown fox/);
    expect(r.text).not.toMatch(/var secret/);
    expect(r.mime).toContain('html');
  });

  it('returns raw text for non-HTML text payloads', async () => {
    const r = await crawlUrl('https://example.com/data.json', {
      fetcher: respondWith('{"a":1}', 'application/json'),
      allowPrivate: true,
    });
    expect(r.text).toBe('{"a":1}');
    expect(r.mime).toBe('application/json');
  });

  it('enforces the SSRF guard before fetching', async () => {
    await expect(crawlUrl('http://127.0.0.1/x', { fetcher: respondWith('x') })).rejects.toThrow(
      /private/i,
    );
    await expect(crawlUrl('ftp://example.com/x', { fetcher: respondWith('x') })).rejects.toThrow(
      /non-http/i,
    );
  });

  it('throws on a non-2xx response', async () => {
    const f = (() =>
      Promise.resolve(new Response('nope', { status: 404 }))) as unknown as typeof fetch;
    await expect(
      crawlUrl('https://example.com/missing', { fetcher: f, allowPrivate: true }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('blocks a 3xx redirect to a private address (SSRF)', async () => {
    // First (public) hop is allowed; the 302 Location targets a private host and
    // must be re-validated + rejected before it is followed.
    const redirect = (() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }),
      )) as unknown as typeof fetch;
    await expect(
      crawlUrl('http://93.184.216.34/', { fetcher: redirect, allowPrivate: false }),
    ).rejects.toThrow(/private/i);
  });

  it('streams the body and stops at maxBytes (never buffers an oversized response whole)', async () => {
    // A 1 MB text body crawled with a 1 KB cap must come back truncated — the
    // streaming reader aborts once the cap is reached rather than buffering it all.
    const big = 'x'.repeat(1_000_000);
    const r = await crawlUrl('https://example.com/huge.txt', {
      fetcher: respondWith(big, 'text/plain'),
      allowPrivate: true,
      maxBytes: 1024,
    });
    expect(r.text.length).toBeLessThanOrEqual(1024);
    expect(r.byteLength).toBeLessThanOrEqual(1024);
  });

  it('extracts a tweet via the publish.twitter.com oEmbed endpoint', async () => {
    // x.com/twitter.com serve a JS shell with no readable static HTML, so the
    // per-host extractor fetches the oEmbed JSON instead. The stub answers the
    // oEmbed call (the only fetch the extractor makes).
    const oembed = JSON.stringify({
      author_name: 'Ada Lovelace',
      html: '<blockquote><p>Analytical engine notes are live.</p>&mdash; Ada</blockquote>',
    });
    const fetcher = ((url: string) => {
      expect(url).toContain('publish.twitter.com/oembed');
      expect(url).toContain(encodeURIComponent('https://x.com/ada/status/123'));
      return Promise.resolve(
        new Response(oembed, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }) as unknown as typeof fetch;
    const r = await crawlUrl('https://x.com/ada/status/123', { fetcher, allowPrivate: true });
    expect(r.text).toMatch(/Analytical engine notes are live/);
    expect(r.title).toBe('Post by Ada Lovelace');
  });

  it('forceJs degrades to the static extraction when Playwright is absent (no throw)', async () => {
    // Playwright is an optionalDependency; with forceJs set but no browser
    // available, the crawl must still succeed using the static HTML.
    const para = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const html = `<!doctype html><html><head><title>SPA</title></head><body><article><p>${para}</p></article></body></html>`;
    const r = await crawlUrl('https://example.com/app', {
      fetcher: respondWith(html),
      allowPrivate: true,
      forceJs: true,
    });
    expect(r.text).toMatch(/quick brown fox/);
  });
});
