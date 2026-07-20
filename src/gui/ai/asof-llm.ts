import type { Lattice } from '../../lattice.js';
import type { AsOfCandidate } from '../../import/asof.js';
import { DEFAULT_MODEL } from './chat.js';
import { resolveLlmClient } from './provider.js';

/**
 * LLM fallback for as-of detection. When the deterministic scanners
 * ({@link detectAsOfCandidates}) find nothing confident, ask Claude to read the
 * file's text and pull the snapshot date — this catches phrasings the regexes
 * miss ("for the quarter then ended …") and any language. Best-effort: no
 * credentials or any error ⇒ returns null and the caller keeps its deterministic
 * candidates (still user-confirmed). Never throws into the import flow.
 */

const MAX_CHARS = 6000;

const SYSTEM =
  'You extract the single "as of" / report / snapshot / period-end date from the ' +
  'text of a data file (a financial statement, track record, export, etc.). ' +
  'Reply with ONLY that date as ISO YYYY-MM-DD, or the exact word NONE if the ' +
  'text has no such date. Output nothing else — no prose, no quotes.';

/** Pull a plausible ISO date out of the model's reply (pure; testable). */
export function parseLlmDate(reply: string): string | null {
  if (!reply) return null;
  const m = /(20\d{2})-(\d{2})-(\d{2})/.exec(reply);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2010 || y > 2099) return null;
  return `${String(y)}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Ask Claude for the as-of date in `text`. Returns a candidate or null. */
export async function asOfFromLlm(db: Lattice | null, text: string): Promise<AsOfCandidate | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const client = await resolveLlmClient(db);
    if (!client) return null; // no provider configured → deterministic-only, not an error
    const result = await client.runTurn({
      model: DEFAULT_MODEL,
      system: SYSTEM,
      temperature: 0,
      tools: [],
      messages: [{ role: 'user', content: `File text:\n${trimmed.slice(0, MAX_CHARS)}` }],
      onText: () => {
        /* no streaming needed for a one-shot extraction */
      },
    });
    const date = parseLlmDate(result.text);
    return date
      ? { date, source: 'llm', confidence: 0.85, evidence: 'Claude read the file' }
      : null;
  } catch (e) {
    // Best-effort enhancement — surface for debugging, never break the import.
    console.warn('[import] as-of LLM fallback failed:', (e as Error).message);
    return null;
  }
}
