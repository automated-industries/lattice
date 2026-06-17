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
  /**
   * Render with headless Chromium up front rather than only as a low-text
   * fallback — for SPA-heavy pages whose static HTML is an empty shell. When
   * Playwright is absent this degrades to the static extraction with a single
   * loud warning (it is an optional dependency, not a hard requirement).
   * Ignored when `noJs` is set. Default false.
   */
  forceJs?: boolean;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
// A current Chrome UA: bot-protected help centers (Zendesk/Cloudflare) reject a
// non-browser User-Agent with 401/403, so present as a real browser.
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function crawlUrl(rawUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const u = await assertSafeUrl(rawUrl, opts.allowPrivate ?? false);
  const fetchImpl = opts.fetcher ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Per-host special-case extractors (e.g. tweets via oEmbed, which serve no
  // readable static HTML) take precedence; a null return falls through to the
  // generic crawl below.
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const special = DOMAIN_EXTRACTORS.find((e) =>
    e.hosts.some((h) => host === h || host.endsWith('.' + h)),
  );
  if (special) {
    const extracted = await special.extract(u, opts, fetchImpl);
    if (extracted) return extracted;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let mime: string;
  let body: Buffer;
  let finalUrl: string;
  try {
    const res = await safeFetch(u.toString(), fetchImpl, {
      allowPrivate: opts.allowPrivate ?? false,
      init: {
        signal: controller.signal,
        headers: {
          'user-agent': opts.userAgent ?? DEFAULT_UA,
          accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          'upgrade-insecure-requests': '1',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'none',
          'sec-fetch-user': '?1',
        },
      },
    });
    if (!res.ok) {
      // Bot-protected pages reject automated fetches with 401/403/429. Before
      // giving up, try a real headless browser (it presents as a full browser and
      // often gets through); if that still fails, surface a clear, actionable
      // error instead of a cryptic HTTP code.
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        if (!opts.noJs) {
          const target = res.url || u.toString();
          const rendered = await renderViaPlaywright(target, timeoutMs, true);
          if (rendered) {
            const rdom = new JSDOM(rendered, { url: target });
            const rdoc = rdom.window.document as unknown as Document;
            let rtitle = (rdoc.title || '').trim();
            let rtext = '';
            let rexcerpt = '';
            try {
              const a = new Readability(rdoc).parse();
              if (a) {
                rtext = a.textContent.trim();
                if (a.title.trim().length > 0) rtitle = a.title.trim();
                rexcerpt = a.excerpt.trim();
              }
            } catch {
              // fall back to stripped text below
            }
            if (rtext.length === 0) rtext = strippedBodyText(rdom);
            if (rtext.length > 0) {
              return {
                url: target,
                title: rtitle.length > 0 ? rtitle : titleFromUrl(target),
                text: rtext,
                excerpt: rexcerpt,
                mime: 'text/html',
                byteLength: Buffer.byteLength(rendered),
              };
            }
          }
        }
        throw new Error(
          `Lattice: ${rawUrl} blocked automated access (HTTP ${String(res.status)}). ` +
            `The site may require a real browser — open it and paste the text to ingest manually.`,
        );
      }
      throw new Error(`Lattice: crawl failed for ${rawUrl}: HTTP ${String(res.status)}`);
    }
    mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    finalUrl = res.url || u.toString();
    // Stream the body and stop at maxBytes — never buffer an unbounded response
    // into memory (a malicious or runaway server could stream gigabytes).
    body = await readBodyCapped(res, maxBytes, controller);
  } finally {
    clearTimeout(timer);
  }

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
      byteLength: body.length,
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

  // JS-render via headless Chromium. Triggered up front when `forceJs` is set
  // (SPA shells whose static HTML carries no text), and otherwise as a fallback
  // when the static extraction yielded little text. Degrades to the static
  // result when Playwright (or a browser) is absent — silently for the fallback,
  // with one loud warning when `forceJs` explicitly asked for it.
  const wantJs = opts.forceJs === true && !opts.noJs;
  if (!opts.noJs && (wantJs || text.length < 200)) {
    const rendered = await renderViaPlaywright(finalUrl, timeoutMs, wantJs);
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

  return {
    url: finalUrl,
    title,
    text,
    excerpt,
    mime: mime || 'text/html',
    byteLength: body.length,
  };
}

/**
 * Read a response body, stopping (and aborting the in-flight socket) once
 * `maxBytes` is reached. Streams via the body reader so an oversized or
 * never-ending response can't be buffered whole into memory; falls back to a
 * (still capped) `arrayBuffer()` read for fetch stubs that expose no stream.
 */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<Buffer> {
  const stream = res.body;
  if (!stream) {
    // No readable stream (a null-bodied response or a minimal fetch stub) — fall
    // back to a single, still-capped buffered read.
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value)); // copies — safe to keep past the read loop
      total += value.byteLength;
      if (total >= maxBytes) {
        controller.abort(); // stop a server streaming more than we'll accept
        break;
      }
    }
  } catch {
    // A mid-stream abort (our own cap, or the timeout) surfaces as a read
    // rejection — we keep whatever we accumulated. Pre-body failures are
    // already handled by the caller (safeFetch validated headers + res.ok).
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = Buffer.concat(chunks);
  return out.length > maxBytes ? out.subarray(0, maxBytes) : out;
}

/**
 * Per-host extractors for sites that serve no usable static HTML (e.g. tweets).
 * Each returns a {@link CrawlResult} or `null` to fall through to the generic
 * crawl. Matched by exact host or any subdomain.
 */
type DomainExtractor = (
  u: URL,
  opts: CrawlOptions,
  fetchImpl: typeof fetch,
) => Promise<CrawlResult | null>;

const DOMAIN_EXTRACTORS: { hosts: string[]; extract: DomainExtractor }[] = [
  { hosts: ['x.com', 'twitter.com', 'mobile.twitter.com'], extract: twitterOEmbed },
];

interface OEmbedResponse {
  html?: string;
  author_name?: string;
  title?: string;
}

/**
 * Extract a tweet/post via Twitter's public oEmbed endpoint (the page itself is
 * a JS shell with no readable static text). Goes through `safeFetch` so the
 * oEmbed host is SSRF-validated like any other fetch. Returns `null` on any
 * failure so the caller falls back to the generic crawl.
 */
async function twitterOEmbed(
  u: URL,
  opts: CrawlOptions,
  fetchImpl: typeof fetch,
): Promise<CrawlResult | null> {
  const endpoint =
    'https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=' +
    encodeURIComponent(u.toString());
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await safeFetch(endpoint, fetchImpl, {
      allowPrivate: opts.allowPrivate ?? false,
      init: {
        signal: controller.signal,
        headers: { 'user-agent': opts.userAgent ?? DEFAULT_UA, accept: 'application/json' },
      },
    });
  } catch {
    return null; // oEmbed unreachable — fall back to the normal crawl
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return null;
  let json: OEmbedResponse;
  try {
    json = (await res.json()) as OEmbedResponse;
  } catch {
    return null;
  }
  if (!json.html) return null;
  const text = strippedBodyText(new JSDOM(json.html));
  if (text.length === 0) return null;
  const author = (json.author_name ?? '').trim();
  const title = author.length > 0 ? `Post by ${author}` : 'Social post';
  return {
    url: u.toString(),
    title,
    text,
    excerpt: text.slice(0, 280),
    mime: 'text/html',
    byteLength: Buffer.byteLength(json.html, 'utf-8'),
  };
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
  type FileTypeMod = {
    fileTypeFromBuffer: (b: Uint8Array) => Promise<{ mime: string } | undefined>;
  };
  let ft: FileTypeMod;
  try {
    ft = (await import('file-type')) as unknown as FileTypeMod;
  } catch (err) {
    // `file-type` is a regular dependency, so a load failure here means a broken/
    // partial install — surface it loudly rather than silently sniffing nothing
    // (the same silent-degradation class the document parsers now guard against).
    console.error(
      `[latticesql] mime sniffer "file-type" failed to load — crawl mime detection ` +
        `is degraded (likely a broken/partial install). Reinstall dependencies ` +
        `(\`npm install\`). Cause:`,
      err,
    );
    return '';
  }
  try {
    const result = await ft.fileTypeFromBuffer(body);
    return result?.mime ?? '';
  } catch {
    return ''; // bytes simply aren't a recognizable binary type — not an error
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

let warnedPlaywrightMissing = false;

/**
 * Render a page with headless Chromium (Playwright) and return its HTML, or
 * `null` if Playwright (or a browser) is unavailable or navigation fails.
 * Playwright is an optionalDependency, so this is a graceful, best-effort hook.
 * When `warnIfMissing` is set (a caller that explicitly asked for JS rendering),
 * a single loud warning is logged the first time Playwright is found absent.
 */
async function renderViaPlaywright(
  url: string,
  timeoutMs: number,
  warnIfMissing = false,
): Promise<string | null> {
  let chromium: { launch: (o?: { headless?: boolean }) => Promise<PwBrowser> };
  try {
    const importMetaUrl = (import.meta as { url?: string }).url;
    const req = importMetaUrl ? createRequire(importMetaUrl) : require;
    const pw = req('playwright') as {
      chromium: { launch: (o?: { headless?: boolean }) => Promise<PwBrowser> };
    };
    chromium = pw.chromium;
  } catch {
    if (warnIfMissing && !warnedPlaywrightMissing) {
      warnedPlaywrightMissing = true;
      console.warn(
        '[latticesql] JS rendering was requested but the optional "playwright" ' +
          'dependency is not installed — serving the static HTML extraction instead. ' +
          'Install it to render JS-heavy pages: `npm install playwright && ' +
          'npx playwright install chromium`.',
      );
    }
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
