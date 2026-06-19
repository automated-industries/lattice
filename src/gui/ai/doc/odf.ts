import {
  MAX_TEXT,
  decodeUtf8,
  unzip,
  eachElement,
  stripTags,
  decodeXmlEntities,
  nullIfEmpty,
} from './helpers.js';

// ── OpenDocument text/presentation (.odt/.odp → paragraph/heading text) ──

/**
 * Map ODF whitespace elements to literal whitespace before tags are stripped.
 * The `[^>]` attribute runs are length-bounded so an unterminated `<text:s`
 * flood can't drive O(n²) backtracking (a real whitespace element's attributes
 * are a handful of chars; 400 is a safe ceiling).
 */
function odfWhitespace(s: string): string {
  return s
    .replace(/<text:tab\b[^>]{0,400}\/?>/g, '\t')
    .replace(/<text:line-break\b[^>]{0,400}\/?>/g, '\n')
    .replace(/<text:s\b[^>]{0,400}\btext:c="(\d+)"[^>]{0,400}\/?>/g, (_, c: string) =>
      ' '.repeat(Math.min(parseInt(c, 10) || 1, 100)),
    )
    .replace(/<text:s\b[^>]{0,400}\/?>/g, ' ');
}

function odfParagraph(inner: string): string {
  return decodeXmlEntities(stripTags(odfWhitespace(inner))).trim();
}

export async function extractOdfText(path: string): Promise<string | null> {
  const entries = await unzip(path);
  if (!entries) return null;
  const contentBytes = entries['content.xml'];
  if (!contentBytes) return null;
  const xml = decodeUtf8(contentBytes);
  // Paragraphs and headings, in document order.
  const items: [number, string][] = [];
  const collect = (_: string, inner: string, start: number): void => {
    const line = odfParagraph(inner);
    if (line) items.push([start, line]);
  };
  eachElement(xml, 'text:p', collect);
  eachElement(xml, 'text:h', collect);
  items.sort((a, b) => a[0] - b[0]);
  const lines: string[] = [];
  let total = 0;
  for (const [, line] of items) {
    if (total >= MAX_TEXT) break;
    lines.push(line);
    total += line.length + 1;
  }
  return nullIfEmpty(lines.join('\n'));
}

// ── OpenDocument spreadsheet (.ods → table cells, incl. numeric values) ──

export async function extractOds(path: string): Promise<string | null> {
  const entries = await unzip(path);
  if (!entries) return null;
  const contentBytes = entries['content.xml'];
  if (!contentBytes) return null;
  const xml = decodeUtf8(contentBytes);
  const rows: string[] = [];
  let total = 0;
  eachElement(xml, 'table:table-row', (_, rowInner) => {
    if (total >= MAX_TEXT) return;
    const cells: string[] = [];
    eachElement(rowInner, 'table:table-cell', (attrs, body) => {
      const parts: string[] = [];
      eachElement(body, 'text:p', (__, p) => {
        const t = odfParagraph(p);
        if (t) parts.push(t);
      });
      let val = parts.join(' ').trim();
      if (!val) {
        // A numeric/date/boolean cell stores its value only in an attribute when
        // the display <text:p> is empty/absent.
        const ov =
          /\boffice:(?:value|date-value|time-value|string-value|boolean-value)="([^"]*)"/.exec(
            attrs,
          )?.[1];
        if (ov) val = decodeXmlEntities(ov);
      }
      if (val) cells.push(val);
    });
    if (cells.length) {
      const line = cells.join('\t');
      rows.push(line);
      total += line.length + 1;
    }
  });
  return nullIfEmpty(rows.join('\n'));
}
