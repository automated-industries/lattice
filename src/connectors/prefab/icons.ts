/**
 * Icon resolution for catalog entries. A provided remote https logo URL wins (rendered client-side
 * as an `<img>`, never server-fetched/inlined — keeps egress out of the catalog path); otherwise a
 * deterministic `data:` monogram so a card ALWAYS renders even when a registry entry ships no icon.
 */

import { letterIcon } from '../mcp/icon.js';

const PALETTE = [
  '#6b7280',
  '#0052cc',
  '#ea4335',
  '#4285f4',
  '#0f9d58',
  '#4a154b',
  '#00a1e0',
  '#7c3aed',
  '#d97706',
  '#059669',
];

/** A stable monogram for a label — same label always gets the same letter + colour. */
export function monogramIcon(label: string): string {
  const trimmed = label.trim();
  const letter = (trimmed[0] ?? '?').toUpperCase();
  let h = 0;
  for (let i = 0; i < trimmed.length; i++) h = (h * 31 + trimmed.charCodeAt(i)) >>> 0;
  return letterIcon(letter, PALETTE[h % PALETTE.length] ?? '#6b7280');
}

/** Resolve an entry's icon: a remote https logo if present, else a deterministic monogram. */
export function resolveIcon(opts: { iconUrl?: string | undefined; label: string }): string {
  if (opts.iconUrl && /^https:\/\//i.test(opts.iconUrl)) return opts.iconUrl;
  return monogramIcon(opts.label);
}
