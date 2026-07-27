import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig } from '../../src/gui/lifecycle.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import { ensurePlan, invalidatePlanCache } from '../../src/gui/planner/run.js';
import {
  PLAN_STATE_TABLE,
  loadDismissed,
  recordDismissal,
} from '../../src/gui/planner/plan-state.js';

/**
 * Planner dismissals are durable. A proposal the user waved off used to live in
 * a process-local Set, so it came straight back on the next launch — the same
 * "fix" offered forever. The state now lives in a native bookkeeping table in
 * the workspace database, so it travels with the database (correct for cloud +
 * multi-machine) and survives a restart.
 */

const dirs: string[] = [];
const actives: ActiveDb[] = [];

afterEach(() => {
  for (const a of actives.splice(0)) a.db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A workspace whose `things.qty` is declared text but holds only whole numbers,
 *  so the planner always emits at least one PROPOSE-tier op to dismiss. */
async function bootWorkspace(): Promise<{ configPath: string; outputDir: string }> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-plan-state-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  things:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      qty: { type: text }',
      '      created_at: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: things.md',
      '',
    ].join('\n'),
    'utf8',
  );
  return { configPath, outputDir: join(root, 'context') };
}

/** Rows that make `qty` read as a mistyped integer column. */
async function seed(active: ActiveDb): Promise<void> {
  await active.db.insert('things', {
    id: 't1',
    name: 'Acme',
    qty: '3',
    created_at: '2026-01-01T00:00:00Z',
  });
  await active.db.insert('things', {
    id: 't2',
    name: 'Globex',
    qty: '7',
    created_at: '2026-01-02T00:00:00Z',
  });
}

async function open(paths: { configPath: string; outputDir: string }): Promise<ActiveDb> {
  const active = await openConfig(paths.configPath, paths.outputDir, false);
  actives.push(active);
  // The workspace registers its own framework tables in the background; a test
  // that calls the plan-state primitives directly must not race that DDL.
  await active.converged;
  return active;
}

function close(active: ActiveDb): void {
  const i = actives.indexOf(active);
  if (i >= 0) actives.splice(i, 1);
  active.db.close();
}

describe('data-model planner — durable plan state', () => {
  it('a dismissed proposal stays dismissed across a restart', async () => {
    const paths = await bootWorkspace();
    const first = await open(paths);
    await seed(first);

    const plan = await ensurePlan(first, { sessionId: 's1', force: true, applyAuto: false });
    const target = plan.proposals[0];
    expect(target, 'fixture should produce at least one proposal').toBeTruthy();
    if (!target) return;

    await recordDismissal(first.db, target.id, target.kind);
    close(first);
    invalidatePlanCache(paths.configPath); // the in-process watermark cache is not the state

    // Simulated restart: a brand-new workspace open, no in-memory dismissal set.
    const second = await open(paths);
    const after = await ensurePlan(second, { sessionId: 's2', force: true, applyAuto: false });
    expect(after.proposals.map((p) => p.id)).not.toContain(target.id);
  });

  it('ensurePlan reconciles a caller-held dismissal set with the durable table', async () => {
    const paths = await bootWorkspace();
    const first = await open(paths);
    await seed(first);

    const plan = await ensurePlan(first, { sessionId: 's1', force: true, applyAuto: false });
    const target = plan.proposals[0];
    expect(target).toBeTruthy();
    if (!target) return;

    // The route-held Set is the only place the dismissal lands — the reconcile
    // inside the next pass is what makes it durable.
    const held = new Set<string>([target.id]);
    await ensurePlan(first, { sessionId: 's1', dismissed: held, force: true, applyAuto: false });
    expect(await loadDismissed(first.db)).toContain(target.id);

    // …and the reconcile runs the other way too: a fresh Set is hydrated.
    const fresh = new Set<string>();
    await ensurePlan(first, { sessionId: 's1', dismissed: fresh, force: true, applyAuto: false });
    expect(fresh.has(target.id)).toBe(true);
  });

  it('the plan-state table is internal bookkeeping, not a user-facing object', async () => {
    const paths = await bootWorkspace();
    const active = await open(paths);
    await ensurePlan(active, { sessionId: 's1', force: true, applyAuto: false });
    expect(PLAN_STATE_TABLE.startsWith('__lattice_')).toBe(true);
    expect(active.validTables.has(PLAN_STATE_TABLE)).toBe(false);
    expect(active.db.getRegisteredTableNames()).toContain(PLAN_STATE_TABLE);
  });

  it('recordDismissal is idempotent (dismissing twice is not an error)', async () => {
    const paths = await bootWorkspace();
    const active = await open(paths);
    await recordDismissal(active.db, 'dedup_rows:things::', 'dedup_rows');
    await recordDismissal(active.db, 'dedup_rows:things::', 'dedup_rows');
    expect(await loadDismissed(active.db)).toEqual(['dedup_rows:things::']);
  });
});
