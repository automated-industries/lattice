import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig } from '../../src/gui/lifecycle.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import { REGISTRY } from '../../src/gui/ai/registry.js';
import { DISPATCHABLE } from '../../src/gui/ai/dispatch.js';
import { handleRead } from '../../src/gui/ai/handlers/read.js';
import type { DispatchCtx, HandlerDeps } from '../../src/gui/ai/handlers/types.js';
import type { MutationCtx } from '../../src/gui/mutations.js';
import { destructiveScopeAmbiguity, runIntent } from '../../src/gui/ai/intent.js';
import type { LlmClient } from '../../src/gui/ai/chat.js';

/**
 * "Simplify the model" has to reach the planner. Lattice already detects
 * merges, dedups, dimension extraction, renames, retypes and missing links and
 * surfaces them as reviewable proposals — but the assistant had no tool that
 * ran it, so the only shapes it could reach for were row/table deletion. These
 * pin the read-only proposal tool, and the rule that a broad request whose
 * plausible executions include destruction must ask before acting.
 */

const dirs: string[] = [];
const actives: ActiveDb[] = [];

afterEach(() => {
  for (const a of actives.splice(0)) a.db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<ActiveDb> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-simplify-'));
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
  const active = await openConfig(configPath, join(root, 'context'), false);
  actives.push(active);
  await active.converged;
  return active;
}

function depsFor(active: ActiveDb, overrides: Partial<DispatchCtx> = {}): HandlerDeps {
  const ctx: DispatchCtx = {
    db: active.db,
    feed: active.feed,
    validTables: active.validTables,
    junctionTables: active.junctionTables,
    computedTables: active.computedTables,
    softDeletable: active.softDeletable,
    configPath: active.configPath,
    outputDir: active.outputDir,
    sessionId: 'sess',
    ...overrides,
  };
  const mctx: MutationCtx = {
    db: active.db,
    feed: active.feed,
    softDeletable: active.softDeletable,
    source: 'ai',
    sessionId: 'sess',
  };
  return { ctx, mctx, name: 'propose_model_simplification', args: {} };
}

describe('propose_model_simplification — routing "simplify the model" to the planner', () => {
  it('is registered as a read-only tool that names the simplify vocabulary', () => {
    const def = REGISTRY.find((f) => f.name === 'propose_model_simplification');
    expect(def, 'the assistant must have a tool that runs the data-model planner').toBeTruthy();
    if (!def) return;
    expect(def.mutates).toBe(false);
    expect(def.category).toBe('read');
    // Routing lever: the model picks this tool from the words users actually use.
    expect(def.description.toLowerCase()).toMatch(/simplif/);
    expect(def.description.toLowerCase()).toMatch(/clean up|tidy/);
    expect(def.description.toLowerCase()).toMatch(/consolidat/);
    // …and it must steer AWAY from the destructive shapes.
    expect(def.description).toMatch(/delete_entity/);
    // Declared but unreachable is the bug this whole change exists to fix.
    expect(DISPATCHABLE.has('propose_model_simplification')).toBe(true);
  });

  it('returns reviewable proposals with their tier and affected row counts', async () => {
    const active = await boot();
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

    const out = await handleRead(depsFor(active));
    expect(out).not.toBe(Symbol.for('handler-not-matched'));
    const res = out as { ok: boolean; result?: unknown; error?: string };
    expect(res.ok).toBe(true);
    const payload = res.result as {
      proposals: {
        id: string;
        kind: string;
        tier: string;
        table: string;
        rows: number;
        rationale: string;
      }[];
      note: string;
    };
    const retype = payload.proposals.find((p) => p.kind === 'retype_column');
    expect(retype, 'a text column holding only numbers should surface as a proposal').toBeTruthy();
    expect(retype?.tier).toBe('propose');
    expect(retype?.table).toBe('things');
    expect(retype?.rows).toBe(2);
    expect(retype?.rationale).toBeTruthy();
    // Read-only: the response must tell the model nothing has been changed.
    expect(payload.note.toLowerCase()).toMatch(/nothing/);
  });

  it('fails loudly when the workspace paths are unavailable (never a fake empty plan)', async () => {
    const active = await boot();
    const deps = depsFor(active);
    delete deps.ctx.configPath;
    const res = (await handleRead(deps)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe('destructive-scope ambiguity forces a clarification', () => {
  it('flags a broad "simplify the model" request and names the competing readings', () => {
    const q = destructiveScopeAmbiguity('simplify the model please');
    expect(q, 'a request that could mean delete must not be guessed at').toBeTruthy();
    expect((q ?? '').toLowerCase()).toMatch(/merge/);
    expect((q ?? '').toLowerCase()).toMatch(/remove|delete/);
  });

  it('flags the other broad phrasings too', () => {
    for (const m of [
      'can you clean up my data model?',
      'consolidate the tables',
      'tidy up the schema',
      'declutter my workspace',
      'make the database simpler',
    ]) {
      expect(destructiveScopeAmbiguity(m), m).toBeTruthy();
    }
  });

  it('does not flag a request that already picks one reading, or an ordinary request', () => {
    for (const m of [
      'merge the contacts and people tables',
      'delete the orders table',
      'clean up the model without deleting anything',
      'add a column called status to contacts',
      'how many rows are in things?',
      'what is private mode?',
    ]) {
      expect(destructiveScopeAmbiguity(m), m).toBeNull();
    }
  });

  it('runIntent asks instead of acting, regardless of what the classifier would score', async () => {
    let called = 0;
    const client: LlmClient = {
      runTurn: () => {
        called++;
        // Even a confident "just do it" classification must not win here.
        return Promise.resolve({
          text: '```json\n{"intent_summary":"simplify","ack_message":"On it, simplifying…","needs_work":true,"needs_more_info":false}\n```',
          toolCalls: [],
        }) as ReturnType<LlmClient['runTurn']>;
      },
    } as unknown as LlmClient;

    const r = await runIntent(client, 'simplify the model please');
    expect(r.needs_more_info).toBe(true);
    expect(r.ack_message.toLowerCase()).toMatch(/merge/);
    expect(called, 'the deterministic gate short-circuits the classifier call').toBe(0);
  });
});
