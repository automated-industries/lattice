import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import {
  designDataModel,
  scheduleDataModelDesign,
  type ExecFn,
  type DesignJob,
} from '../../src/gui/ai/data-model-designer.js';
import type { LlmClient, ToolUse } from '../../src/gui/ai/chat.js';
import type { DispatchCtx } from '../../src/gui/ai/dispatch.js';

/**
 * Bug 11: the shared data-model designer. These pin the loop + the HARD safety
 * contract (it runs unattended): it drives only its allowlisted additive/reversible
 * tools, records what it changed, stops when the model is clean, and REFUSES any
 * tool outside the allowlist even if the model emits one.
 */

/** A scripted LlmClient: each entry is one turn's tool calls; runs out ⇒ no tools. */
function scriptedClient(turns: ToolUse[][]): LlmClient {
  let i = 0;
  return {
    runTurn: () => {
      const toolUses = turns[i++] ?? [];
      return Promise.resolve({
        stopReason: toolUses.length ? 'tool_use' : 'end_turn',
        text: '',
        toolUses,
      });
    },
  };
}

const dirs: string[] = [];
async function makeCtx(): Promise<DispatchCtx> {
  const dir = mkdtempSync(join(tmpdir(), 'dmd-'));
  dirs.push(dir);
  const db = new Lattice(join(dir, 'x.db'));
  db.define('meetings', {
    columns: { id: 'TEXT PRIMARY KEY', company: 'TEXT' },
    render: () => '',
    outputFile: 'meetings.md',
  });
  db.define('companies', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
    render: () => '',
    outputFile: 'companies.md',
  });
  await db.init();
  return {
    db,
    feed: new FeedBus(),
    validTables: new Set(['meetings', 'companies']),
    junctionTables: new Set<string>(),
    softDeletable: new Set<string>(),
  } as unknown as DispatchCtx;
}

describe('Bug 11: designDataModel', () => {
  it('drives its additive tools, records changes, and stops when the model is clean', async () => {
    const ctx = await makeCtx();
    const calls: string[] = [];
    const exec: ExecFn = (_c, name) => {
      calls.push(name);
      return Promise.resolve({ ok: true });
    };
    const client = scriptedClient([
      [
        {
          id: '1',
          name: 'create_relationship',
          input: { table_a: 'meetings', table_b: 'companies' },
        },
      ],
      [], // second turn: nothing left to do → stop
    ]);
    const res = await designDataModel(client, ctx, { exec });
    expect(calls).toEqual(['create_relationship']);
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]?.tool).toBe('create_relationship');
    expect(res.changes[0]?.ok).toBe(true);
    expect(res.loops).toBe(1); // one productive loop, then a clean stop
  });

  it('does NOTHING when the model is already clean (no tool calls)', async () => {
    const ctx = await makeCtx();
    const calls: string[] = [];
    const exec: ExecFn = (_c, name) => {
      calls.push(name);
      return Promise.resolve({ ok: true });
    };
    const res = await designDataModel(scriptedClient([[]]), ctx, { exec });
    expect(calls).toEqual([]);
    expect(res.changes).toHaveLength(0);
    expect(res.loops).toBe(0);
  });

  it('REFUSES a tool outside the safe allowlist — never executes a data-destroying op', async () => {
    const ctx = await makeCtx();
    const calls: string[] = [];
    const exec: ExecFn = (_c, name) => {
      calls.push(name);
      return Promise.resolve({ ok: true });
    };
    // The model only SEES the safe tools, but if it somehow emits a destructive one,
    // the designer must refuse to execute it (defence in depth).
    const client = scriptedClient([
      [{ id: '1', name: 'delete_row', input: { table: 'meetings', id: 'x', hard: true } }],
      [],
    ]);
    const res = await designDataModel(client, ctx, { exec });
    expect(calls).toEqual([]); // delete_row was NEVER dispatched
    expect(res.changes).toHaveLength(0);
  });

  it('only exposes safe (read + additive-structural) tools to the model', async () => {
    // Introspect via a client that records the tools it was handed.
    const ctx = await makeCtx();
    let toolNames: string[] = [];
    const client: LlmClient = {
      runTurn: (params) => {
        toolNames = params.tools.map((t) => t.name);
        return Promise.resolve({ stopReason: 'end_turn', text: '', toolUses: [] });
      },
    };
    await designDataModel(client, ctx, { exec: () => Promise.resolve({ ok: true }) });
    expect(toolNames).toContain('create_relationship');
    expect(toolNames).toContain('create_computed_table');
    // No data-writing or destructive tools are ever offered.
    for (const banned of [
      'create_row',
      'update_row',
      'delete_row',
      'bulk_update',
      'delete_entity',
      'create_entity',
      'merge_rows',
    ]) {
      expect(toolNames).not.toContain(banned);
    }
  });
});

describe('Bug 11: scheduleDataModelDesign (the deterministic auto-hook)', () => {
  // Real timers + a tiny injected debounce keep these deterministic across platforms
  // (fake timers + a fire-and-forget rejected promise raced into an unhandled rejection
  // on Windows). `wait` gives the scheduled pass time to run + settle.
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('DEBOUNCES — a batch of triggers coalesces into one pass', async () => {
    let prepared = 0;
    const prepare = (): Promise<null> => {
      prepared++;
      return Promise.resolve(null); // null → skip the design pass (no client needed)
    };
    // Three rapid triggers for the same workspace (a 3-file batch).
    scheduleDataModelDesign('/ws/a', prepare, 20);
    scheduleDataModelDesign('/ws/a', prepare, 20);
    scheduleDataModelDesign('/ws/a', prepare, 20);
    await wait(80);
    expect(prepared).toBe(1); // only the last schedule fired
  });

  it('is FAIL-SOFT — a failing prepare is swallowed + logged, never thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // A prepare whose promise rejects must be caught by the scheduler — never surface
      // as an unhandled rejection (which would fail the whole run).
      scheduleDataModelDesign(
        '/ws/b',
        async (): Promise<DesignJob> => {
          await Promise.resolve();
          throw new Error('boom');
        },
        5,
      );
      await wait(40);
      expect(warn).toHaveBeenCalled(); // the failure was logged + swallowed, not rethrown
    } finally {
      warn.mockRestore();
    }
  });
});

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
