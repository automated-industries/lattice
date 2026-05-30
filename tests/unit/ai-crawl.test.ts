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
});
