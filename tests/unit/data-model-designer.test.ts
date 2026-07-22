import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { designDataModel, type ExecFn } from '../../src/gui/ai/data-model-designer.js';
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

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
