/**
 * Tiny inline icons for the connector settings panel — a lettered badge as an
 * `svg+utf8` data URI (no Buffer, so it works under Node and the desktop Deno
 * runtime alike). Connectors that ship a real provider logo can pass their own
 * `data:` URI instead.
 */

/** A rounded-square badge with a single letter, as a `data:image/svg+xml` URI. */
export function letterIcon(letter: string, bg: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<rect width="24" height="24" rx="5" fill="${bg}"/>` +
    `<text x="12" y="16.5" font-family="sans-serif" font-size="12" font-weight="700" ` +
    `text-anchor="middle" fill="#ffffff">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
