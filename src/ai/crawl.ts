import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { basename } from 'node:path';
import { createRequire } from 'node:module';
import { assertSafeUrl, safeFetch } from '../sources/url-safety.js';

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
  /**
   * Disable the Playwright JS-render fallback (used when the static HTML yields
   * little text and Playwright is installed). Default false. The fallback
   * degrades silently when Playwright or a browser is absent.
   */
  noJs?: boolean;
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
    res = await safeFetch(u.toString(), fetchImpl, {
      allowPrivate: opts.allowPrivate ?? false,
      init: {
        signal: controller.signal,
        headers: {
          'user-agent': opts.userAgent ?? DEFAULT_UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Lattice: crawl failed for ${rawUrl}: HTTP ${String(res.status)}`);
  }

  let mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const raw = Buffer.from(await res.arrayBuffer());
  const body = raw.length > maxBytes ? raw.subarray(0, maxBytes) : raw;
  const finalUrl = res.url || u.toString();

  // Sniff the mime from the bytes when the server gave us nothing useful.
  if (mime === '' || mime === 'application/octet-stream') {
    mime = (await sniffMime(body)) || mime;
  }

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

  // JS-rendered page fallback: if the static HTML yielded little text and
  // Playwright is available, render the page and re-extract. Silently degrades
  // when Playwright (or a browser) is absent — the static result stands.
  if (!opts.noJs && text.length < 200) {
    const rendered = await renderViaPlaywright(finalUrl, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (rendered) {
      const rdom = new JSDOM(rendered, { url: finalUrl });
      const rdoc = rdom.window.document as unknown as Document;
      try {
        const a = new Readability(rdoc).parse();
        if (a && a.textContent.trim().length > text.length) {
          text = a.textContent.trim();
          if (a.title.trim().length > 0) title = a.title.trim();
          if (a.excerpt.trim().length > 0) excerpt = a.excerpt.trim();
        }
      } catch {
        // keep the static extraction
      }
      if (text.length === 0) text = strippedBodyText(rdom);
    }
  }

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

/** Sniff a mime type from bytes via `file-type`. Returns '' if undetectable. */
async function sniffMime(body: Buffer): Promise<string> {
  try {
    const ft = (await import('file-type')) as unknown as {
      fileTypeFromBuffer: (b: Uint8Array) => Promise<{ mime: string } | undefined>;
    };
    const result = await ft.fileTypeFromBuffer(body);
    return result?.mime ?? '';
  } catch {
    return '';
  }
}

interface PwPage {
  goto(url: string, o: { waitUntil: string; timeout: number }): Promise<unknown>;
  content(): Promise<string>;
}
interface PwBrowser {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}

/**
 * Render a page with headless Chromium (Playwright) and return its HTML, or
 * `null` if Playwright (or a browser) is unavailable or navigation fails.
 * Playwright is an optionalDependency, so this is a graceful, best-effort hook.
 */
async function renderViaPlaywright(url: string, timeoutMs: number): Promise<string | null> {
  let chromium: { launch: (o?: { headless?: boolean }) => Promise<PwBrowser> };
  try {
    const importMetaUrl = (import.meta as { url?: string }).url;
    const req = importMetaUrl ? createRequire(importMetaUrl) : require;
    const pw = req('playwright') as {
      chromium: { launch: (o?: { headless?: boolean }) => Promise<PwBrowser> };
    };
    chromium = pw.chromium;
  } catch {
    return null; // Playwright not installed.
  }
  let browser: PwBrowser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    return await page.content();
  } catch {
    return null; // Browser missing / navigation failed.
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
