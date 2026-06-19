import { readFile } from 'node:fs/promises';
import {
  MAX_TEXT,
  decodeUtf8,
  unzip,
  stripHtml,
  eachElement,
  safeCodePoint,
  nullIfEmpty,
} from './helpers.js';

// ── EPUB (zip of XHTML, ordered by the OPF spine when present) ──

function normalizeZipPath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** Resolve an OPF href to a zip entry name: drop #fragment/?query, percent-decode. */
function resolveHref(baseDir: string, href: string): string {
  let h = href.split('#')[0]?.split('?')[0] ?? '';
  try {
    h = decodeURIComponent(h);
  } catch {
    /* malformed escape — keep raw */
  }
  return normalizeZipPath(baseDir + h);
}

export async function extractEpub(path: string): Promise<string | null> {
  const entries = await unzip(path);
  if (!entries) return null;

  let order: string[] = [];
  const container = entries['META-INF/container.xml'];
  const opfPath = container ? /full-path="([^"]+)"/.exec(decodeUtf8(container))?.[1] : undefined;
  if (opfPath && entries[opfPath]) {
    const opf = decodeUtf8(entries[opfPath]);
    const manifest: Record<string, string> = {};
    // Linear scanner (eachElement) — a lazy global `<item\b[^>]*?>` is O(n²) on
    // an `<item`-flood OPF. Handles `<item .../>` and `<item ...></item>`.
    eachElement(opf, 'item', (attrs) => {
      const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
      const href = /\bhref="([^"]+)"/.exec(attrs)?.[1];
      if (id && href) manifest[id] = href;
    });
    const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    eachElement(opf, 'itemref', (attrs) => {
      const idref = /\bidref="([^"]+)"/.exec(attrs)?.[1];
      const href = idref ? manifest[idref] : undefined;
      if (href) order.push(resolveHref(baseDir, href));
    });
  }
  // Fallback: every (x)html entry, in numeric-aware name order (chap2 < chap10).
  if (order.length === 0) {
    order = Object.keys(entries)
      .filter((n) => /\.x?html?$/i.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  const parts: string[] = [];
  let total = 0;
  for (const n of order) {
    if (total >= MAX_TEXT) break;
    const bytes = entries[n];
    if (!bytes) continue;
    const body = stripHtml(decodeUtf8(bytes));
    if (body) {
      parts.push(body);
      total += body.length + 2;
    }
  }
  return nullIfEmpty(parts.join('\n\n'));
}

// ── RTF (native de-RTF; no dependency) ──

/**
 * Control destinations whose group contents are never body text. `\*` (custom
 * destinations: hyperlinks, bookmarks, fields) needs no trailing boundary — the
 * char after `*` is the next control word's backslash. The named keywords need a
 * non-letter lookahead so `fonttbl` matches but `fonttblx` doesn't.
 */
const RTF_IGNORED_DESTINATIONS =
  /^\\(?:\*|(?:fonttbl|colortbl|stylesheet|info|pict|themedata|colorschememapping|latentstyles|datastore|listtable|listoverridetable|rsidtbl|generator|operator|xmlnstbl|wgrffmtfilter|mmathPr)(?![a-zA-Z]))/;

/**
 * Remove brace-matched groups that begin with an ignorable/destination control
 * word (font tables, colour tables, pictures, hyperlink/bookmark fields, …), so
 * only body text survives. Brace-aware so nested groups inside a destination are
 * dropped too. Builds output from kept slices (not per-char concat).
 */
function stripRtfDestinations(s: string): string {
  const kept: string[] = [];
  let keepFrom = 0;
  let i = 0;
  while (i < s.length) {
    // Bound the lookahead slice so the .test() stays O(1) per brace.
    if (s[i] === '{' && RTF_IGNORED_DESTINATIONS.test(s.slice(i + 1, i + 40))) {
      // Separate ONLY when the text right before the group ends in a letter-only
      // control word (e.g. `\ansi{\*\generator …}Body` → the control-word stripper
      // would otherwise fuse `\ansiBody` and eat the word). A `\*` destination
      // mid-word — a `\bkmkstart` bookmark inside `Auto{…}mated` — must NOT get a
      // spurious space. (A trailing digit like `\deff0` already self-terminates.)
      const pre = s.slice(keepFrom, i);
      kept.push(pre);
      if (/\\[a-zA-Z]+$/.test(pre.slice(-40))) kept.push(' ');
      let depth = 1;
      let j = i + 1;
      for (; j < s.length && depth > 0; j++) {
        const ch = s[j];
        if (ch === '\\')
          j++; // skip the escaped char
        else if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      i = j;
      keepFrom = i;
    } else {
      i++;
    }
  }
  kept.push(s.slice(keepFrom));
  return kept.join('');
}

/**
 * CP1252 mapping for bytes 0x80–0x9F (the range where Windows-1252 diverges from
 * Latin-1). Word writes `\'xx` escapes in the ANSI codepage, so 0x92 is a curly
 * apostrophe (’), 0x97 an em dash (—), 0x85 an ellipsis (…) — not the invisible
 * C1 controls Latin-1 would give. Bytes 0xA0–0xFF agree with Latin-1.
 */
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

function cp1252Char(byte: number): string {
  if (byte >= 0x80 && byte <= 0x9f) {
    const cp = CP1252_HIGH[byte];
    return cp ? safeCodePoint(cp) : '';
  }
  return safeCodePoint(byte); // 0x00–0x7F and 0xA0–0xFF agree with Unicode
}

function rtfToText(rtf: string): string {
  let s = stripRtfDestinations(rtf);
  // Hex escapes (\'xx, ANSI/CP1252) and unicode escapes (\uN), before control
  // words are dropped. (\ucN skip-counts > 1 are not tracked — uc1 is the Word
  // default and covers the common case; a higher uc may leak a fallback glyph.)
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, h: string) => cp1252Char(parseInt(h, 16)));
  s = s.replace(/\\u(-?\d+)\s?\??/g, (_, d: string) => {
    let n = parseInt(d, 10);
    if (n < 0) n += 65536;
    return safeCodePoint(n);
  });
  // Paragraph / line / tab breaks → whitespace.
  s = s
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\line\b/g, '\n')
    .replace(/\\sect\b/g, '\n')
    .replace(/\\page\b/g, '\n')
    .replace(/\\tab\b/g, '\t');
  // Remaining control words and control symbols.
  s = s.replace(/\\[a-zA-Z]+-?\d*\s?/g, '').replace(/\\[^a-zA-Z]/g, '');
  s = s.replace(/[{}]/g, '');
  return (
    s
      // Collapse each horizontal-whitespace run to ONE char FIRST — linear, and
      // stops the next two replaces from backtracking O(n²) on a space flood. Keep
      // a tab when the run had one, so `\tab`-delimited columns survive.
      .replace(/[ \t]+/g, (m) => (m.includes('\t') ? '\t' : ' '))
      .replace(/[ \t]\n/g, '\n') // drop the (now single) trailing ws before a newline
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

export async function extractRtf(path: string): Promise<string | null> {
  try {
    // RTF is 7-bit ASCII with escapes for everything else; latin1 keeps bytes intact.
    const raw = await readFile(path, 'latin1');
    if (!raw.startsWith('{\\rtf')) return null;
    return nullIfEmpty(rtfToText(raw));
  } catch {
    return null;
  }
}
