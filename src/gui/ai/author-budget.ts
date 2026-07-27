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

/** Budget tiers an authoring call may climb, smallest first. */
export function authorBudgetLadder(startingBudget: number): number[] {
  const higher = OUTPUT_BUDGET_TIERS.filter((t) => t > startingBudget);
  return [startingBudget, ...higher];
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
): Promise<AuthorAttempt<T>> {
  const ladder = authorBudgetLadder(startingBudget);
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
