import { basename } from 'node:path';
import type { Lattice } from '../lattice.js';
import { detectAsOfCandidates, type AsOfCandidate } from '../import/asof.js';
import { excelPreambleText } from '../import/excel.js';
import { asOfFromLlm } from './ai/asof-llm.js';

/**
 * Detect an import's snapshot date from every signal — ranked, best first:
 * in-content "as of"/date keys, the file name, an Excel title/preamble, then a
 * Claude fallback when nothing deterministic is confident. Shared by the import
 * panel's analyze route and the assistant's auto-import, so both doors detect the
 * period identically.
 */
export async function detectImportAsOf(
  db: Lattice | null,
  data: Record<string, unknown>,
  opts: { abs?: string | null; fileName?: string } = {},
): Promise<AsOfCandidate[]> {
  const fileName =
    opts.fileName ?? (opts.abs ? basename(opts.abs).replace(/^[0-9a-f]{8}-/, '') : '');
  const texts: { label: string; text: string }[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (!Array.isArray(v)) texts.push({ label: 'data', text: `${k}: ${JSON.stringify(v)}` });
  }
  if (opts.abs && /\.xlsx?$/i.test(opts.abs)) {
    const pre = excelPreambleText(opts.abs);
    if (pre) texts.push({ label: 'title', text: pre });
  }
  let candidates = detectAsOfCandidates({ fileName, texts });
  // Fall back to Claude only when nothing in-content is confident.
  if (!candidates[0] || candidates[0].confidence < 0.7) {
    const llm = await asOfFromLlm(db, texts.map((t) => t.text).join('\n'));
    if (llm) candidates = [...candidates, llm].sort((a, b) => b.confidence - a.confidence);
  }
  return candidates;
}
