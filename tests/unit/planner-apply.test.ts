import { describe, expect, it, vi } from 'vitest';
import { applyPlanOp, runAutoTier, type ApplyDeps } from '../../src/gui/planner/apply.js';
import type { PlanOp } from '../../src/gui/planner/types.js';

function op(over: Partial<PlanOp> & Pick<PlanOp, 'kind'>): PlanOp {
  return {
    id: `${over.kind}:x`,
    class: 'additive',
    tier: 'auto',
    target: { table: 't' },
    rationale: 'because',
    confidence: 1,
    evidence: {},
    ...over,
  };
}

/** Fresh mocks captured as locals so assertions never reference an unbound method. */
function makeDeps(over: Partial<ApplyDeps> = {}) {
  const mocks = {
    addRelationship: vi.fn(async () => ({ junction: 'a_b' }) as { junction: string } | null),
    documentTable: vi.fn(async () => {}),
    mergeTables: vi.fn(async () => ({ ok: true })),
    dedupRows: vi.fn(async () => ({ ok: true })),
    renameTable: vi.fn(async () => ({ ok: true })),
    extractDimension: vi.fn(async () => ({ ok: true })),
    retypeColumn: vi.fn(async () => ({ ok: true })),
  };
  const deps: ApplyDeps = { ...mocks, ...over };
  return { deps, mocks };
}

describe('data-model planner — apply', () => {
  it('add_relationship routes to addRelationship and reports the junction', async () => {
    const { deps, mocks } = makeDeps();
    const r = await applyPlanOp(op({ kind: 'add_relationship', target: { table: 'orders', toTable: 'customers' } }), deps);
    expect(mocks.addRelationship).toHaveBeenCalledWith('orders', 'customers');
    expect(r).toMatchObject({ ok: true, kind: 'add_relationship', auditId: 'a_b' });
  });

  it('add_relationship reports a clean failure when the primitive declines (null)', async () => {
    const { deps } = makeDeps({ addRelationship: vi.fn(async () => null) });
    const r = await applyPlanOp(op({ kind: 'add_relationship', target: { table: 'orders', toTable: 'files' } }), deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not created/);
  });

  it('document uses the deterministic text from evidence', async () => {
    const { deps, mocks } = makeDeps();
    await applyPlanOp(op({ kind: 'document', target: { table: 'a_b' }, evidence: { text: 'Join table linking a and b.' } }), deps);
    expect(mocks.documentTable).toHaveBeenCalledWith('a_b', 'Join table linking a and b.');
  });

  it('retype_column passes the target type from evidence', async () => {
    const { deps, mocks } = makeDeps();
    await applyPlanOp(op({ kind: 'retype_column', target: { table: 'e', column: 'count' }, evidence: { to: 'integer' } }), deps);
    expect(mocks.retypeColumn).toHaveBeenCalledWith('e', 'count', 'integer');
  });

  it('runAutoTier runs only auto-tier ops and skips proposals', async () => {
    const { deps, mocks } = makeDeps();
    const ops: PlanOp[] = [
      op({ kind: 'add_relationship', tier: 'auto', target: { table: 'o', toTable: 'c' } }),
      op({ kind: 'extract_dimension', tier: 'propose', target: { table: 'o', column: 'region', toTable: 'region' } }),
    ];
    const applied = await runAutoTier(ops, deps);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.kind).toBe('add_relationship');
    expect(mocks.extractDimension).not.toHaveBeenCalled();
  });

  it('runAutoTier catches a throwing primitive (fail-soft) and records the error', async () => {
    const { deps } = makeDeps({
      addRelationship: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const applied = await runAutoTier([op({ kind: 'add_relationship', tier: 'auto', target: { table: 'o', toTable: 'c' } })], deps);
    expect(applied[0]).toMatchObject({ ok: false, error: 'boom' });
  });
});
