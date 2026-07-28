import { OUTPUT_BUDGET_TIERS } from './chat.js';

/**
 * Run a delegated authoring call, escalating the output budget if the model runs
 * out of room mid-document.
 *
 * Delegated authoring exists because a whole document cannot fit through a tool
 * call's arguments. But the authoring call has its own ceiling, and hitting it
 * produces something worse than a failure: a document cut mid-token. An HTML page
 * severed inside a script block parses as text, passes every check that inspects
 * text, and stores as a page whose behaviour never runs — which is exactly how a
 * dead dashboard reached a user looking perfectly well-formed.
 *
 * Refusing that outright is honest, and the caller still does refuse. But a
 * document that is merely LARGE is not a malformed request, and telling someone to
 * "simplify or split" a reasonable page is a poor answer when the only real
 * problem is a ceiling. So a truncated author retries once at the next budget tier
 * before giving up, mirroring the chat loop's ladder rather than inventing a second
 * policy.
 *
 * The escalation is free in the common case — it only fires on an actual
 * truncation — and it is bounded: once the tiers are exhausted the caller's own
 * refusal stands, so a genuinely unbounded document still errors rather than
 * looping. Billing is on tokens produced, not on the ceiling, so a higher ceiling
 * costs nothing until it is used.
 */
export interface AuthorAttempt<T> {
  /** The value the author produced. Ignored when `truncated` is true. */
  result: T;
  /** True when the model stopped because it ran out of output budget. */
  truncated: boolean;
}

/**
 * A rung is only worth taking if it buys meaningfully more room. Re-generating a
 * whole document costs a full model call, so climbing from 16000 to 16384 — 2.4%
 * more — spends that call to almost certainly truncate again. Anything that
 * overran the first budget by a real amount needs a real increase.
 */
const MIN_ESCALATION_RATIO = 1.25;

/**
 * Budget tiers an authoring call may climb, smallest first.
 *
 * `maxOutputTokens` is the model's hard ceiling. Rungs above it are dropped rather
 * than attempted, because exceeding it is not a truncation the caller can recover
 * from — the provider rejects the request outright, and the careful refusal this
 * module exists to produce is replaced by a raw HTTP 400. Passing no ceiling keeps
 * the historical behaviour for callers that genuinely have none.
 */
export function authorBudgetLadder(startingBudget: number, maxOutputTokens?: number): number[] {
  const ceiling = maxOutputTokens ?? Number.POSITIVE_INFINITY;
  const ladder = [startingBudget];
  for (const t of OUTPUT_BUDGET_TIERS) {
    const last = ladder[ladder.length - 1] ?? startingBudget;
    if (t > ceiling) continue;
    if (t >= last * MIN_ESCALATION_RATIO) ladder.push(t);
  }
  return ladder;
}

/**
 * Call `attempt` at each budget in turn, stopping at the first result that is not
 * truncated. Returns the last attempt when every tier truncates, so the caller
 * decides how to refuse — this helper never invents an error message and never
 * returns a truncated document as though it were whole.
 */
export async function authorWithEscalation<T>(
  startingBudget: number,
  attempt: (budget: number) => Promise<AuthorAttempt<T>>,
  onEscalate?: (from: number, to: number) => void,
  maxOutputTokens?: number,
): Promise<AuthorAttempt<T>> {
  const ladder = authorBudgetLadder(startingBudget, maxOutputTokens);
  let last: AuthorAttempt<T> | null = null;
  for (let i = 0; i < ladder.length; i++) {
    const budget = ladder[i] ?? startingBudget;
    last = await attempt(budget);
    if (!last.truncated) return last;
    const next = ladder[i + 1];
    if (next !== undefined) onEscalate?.(budget, next);
  }
  // Every tier truncated. Hand the truncated attempt back rather than a partial
  // masquerading as complete; the caller refuses on `truncated`.
  return last ?? { result: undefined as unknown as T, truncated: true };
}
