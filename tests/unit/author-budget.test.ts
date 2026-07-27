import { describe, it, expect } from 'vitest';
import { authorBudgetLadder, authorWithEscalation } from '../../src/gui/ai/author-budget.js';
import { OUTPUT_BUDGET_TIERS } from '../../src/gui/ai/chat.js';

/**
 * Delegated authoring exists because a whole document cannot fit through a tool
 * call's arguments — but the authoring call has its own ceiling, and hitting it
 * returns a document cut mid-token. That is worse than a failure: an HTML page
 * severed inside a script block still parses as text, so every check that
 * inspects text passes it, and it stores as a page whose behaviour never runs.
 *
 * Refusing is honest. Refusing a merely LARGE document is unhelpful. So the
 * author climbs the budget first and only refuses once the tiers are exhausted.
 */
describe('delegated authoring escalates its output budget before refusing', () => {
  it('climbs to the tiers above the starting budget, in order', () => {
    const ladder = authorBudgetLadder(16000);
    expect(ladder[0]).toBe(16000);
    expect(ladder.slice(1)).toEqual(OUTPUT_BUDGET_TIERS.filter((t) => t > 16000));
    // strictly increasing — a ladder that revisits a budget would loop
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]!).toBeGreaterThan(ladder[i - 1]!);
  });

  it('does not retry when the document fits — escalation is free in the common case', async () => {
    const budgets: number[] = [];
    const out = await authorWithEscalation(16000, (budget) => {
      budgets.push(budget);
      return Promise.resolve({ result: 'a complete document', truncated: false });
    });
    expect(out.truncated).toBe(false);
    expect(out.result).toBe('a complete document');
    expect(budgets).toEqual([16000]); // exactly one call
  });

  it('retries at the next tier and succeeds, instead of telling the user to simplify', async () => {
    const budgets: number[] = [];
    const escalations: [number, number][] = [];
    const out = await authorWithEscalation(
      16000,
      (budget) => {
        budgets.push(budget);
        // Fits only once there is more room.
        return Promise.resolve(
          budget > 16000
            ? { result: 'the whole page', truncated: false }
            : { result: '<script>const x = "cut mid', truncated: true },
        );
      },
      (from, to) => escalations.push([from, to]),
    );
    expect(out.truncated).toBe(false);
    expect(out.result).toBe('the whole page');
    expect(budgets.length).toBe(2);
    expect(budgets[1]!).toBeGreaterThan(budgets[0]!);
    expect(escalations[0]![0]).toBe(16000);
  });

  it('gives up after the last tier and reports the attempt as truncated, never as whole', async () => {
    let calls = 0;
    const out = await authorWithEscalation(16000, () => {
      calls += 1;
      return Promise.resolve({ result: '<script>const x = "cut mid', truncated: true });
    });
    // Bounded: it stops at the ladder, it does not loop.
    expect(calls).toBe(authorBudgetLadder(16000).length);
    // And it hands the caller a TRUNCATED verdict so the refusal still happens —
    // returning the fragment as a success is the exact bug this guards.
    expect(out.truncated).toBe(true);
  });
});
