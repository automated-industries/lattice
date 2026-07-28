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
    // strictly increasing — a ladder that revisits a budget would loop
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]!).toBeGreaterThan(ladder[i - 1]!);
    for (const b of ladder.slice(1)) expect(OUTPUT_BUDGET_TIERS).toContain(b);
  });

  it('skips a rung that buys almost nothing', () => {
    // 16000 → 16384 is 2.4% more room for the price of re-generating the entire
    // document. Any document that overran the first budget by a real amount
    // truncates again at the second, so the rung is a guaranteed wasted call.
    expect(authorBudgetLadder(16000)).not.toContain(16384);
    expect(authorBudgetLadder(16000)).toContain(65536);
    // ...but a rung that DOES buy meaningful room is still taken.
    expect(authorBudgetLadder(4096)).toContain(16384);
  });

  it('never climbs past the model ceiling — that is a rejected request, not a truncation', () => {
    // Haiku 4.5 caps at 64000 and is the default authoring model on the Lattice
    // Cloud path, so the 65536 rung returned an HTTP 400 and replaced the curated
    // refusal with a raw provider error: the ladder's last step made things worse
    // than not climbing at all.
    const ladder = authorBudgetLadder(16000, 64000);
    expect(ladder).not.toContain(65536);
    for (const b of ladder) expect(b).toBeLessThanOrEqual(64000);
    // A model with more room still gets the full climb.
    expect(authorBudgetLadder(16000, 128000)).toContain(65536);
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
