import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { basename } from 'node:path';
import { assertSafeUrl } from '../sources/url-safety.js';

/**
 * Fetch a URL and extract readable text from it. For HTML, uses Mozilla
 * Readability (the article-extraction algorithm) with a stripped-DOM fallback;
 * for non-HTML text types, returns the raw text. SSRF-guarded. Network access
 * is injectable (`opts.fetcher`) so callers/tests can stub it.
 *
 * This is the back-end crawler behind cloud references — record a URL with
 * `referenceUrl`, then `crawlUrl` to fill `extracted_text` for the organizer.
 */
export interface CrawlResult {
  url: string;
  title: string;
  text: string;
  excerpt: string;
  mime: string;
  byteLength: number;
}

export interface CrawlOptions {
  fetcher?: typeof fetch;
  allowPrivate?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_UA = 'LatticeSQL/2.0 (+https://latticesql.com)';

export async function crawlUrl(rawUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const u = await assertSafeUrl(rawUrl, opts.allowPrivate ?? false);
  const fetchImpl = opts.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(u.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': opts.userAgent ?? DEFAULT_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Lattice: crawl failed for ${rawUrl}: HTTP ${String(res.status)}`);
  }

  const mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const raw = Buffer.from(await res.arrayBuffer());
  const body = raw.length > maxBytes ? raw.subarray(0, maxBytes) : raw;
  const finalUrl = res.url || u.toString();

  const isHtml = mime.includes('html') || mime.includes('xml');
  if (mime && !isHtml && !mime.startsWith('text/')) {
    // Non-HTML text-ish payload (json, csv, plain) — return as-is; binary
    // formats (pdf/office) are handled by a richer extractor, not here.
    return {
      url: finalUrl,
      title: titleFromUrl(finalUrl),
      text: body.toString('utf-8'),
      excerpt: '',
      mime,
      byteLength: raw.length,
    };
  }

  const dom = new JSDOM(body.toString('utf-8'), { url: finalUrl });
  const doc = dom.window.document as unknown as Document;
  let title = (doc.title || '').trim();
  let text = '';
  let excerpt = '';
  try {
    const article = new Readability(doc).parse();
    if (article) {
      text = article.textContent.trim();
      const articleTitle = article.title.trim();
      if (articleTitle.length > 0) title = articleTitle;
      excerpt = article.excerpt.trim();
    }
  } catch {
    // Readability can throw on malformed DOM — fall back to stripped body text.
  }
  if (text.length === 0) text = strippedBodyText(dom);
  if (title.length === 0) title = titleFromUrl(finalUrl);

  return { url: finalUrl, title, text, excerpt, mime: mime || 'text/html', byteLength: raw.length };
}

function strippedBodyText(dom: JSDOM): string {
  const doc = dom.window.document;
  for (const el of Array.from(doc.querySelectorAll('script, style, noscript, template'))) {
    el.remove();
  }
  return (doc.body.textContent ?? '')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function titleFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const last = basename(u.pathname);
    return last && last !== '/' ? last : u.hostname;
  } catch {
    return rawUrl;
  }
}
