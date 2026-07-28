import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import type { DispatchCtx } from '../../src/gui/ai/dispatch.js';
import {
  runChat,
  truncatedToolCall,
  OUTPUT_BUDGET_TIERS,
  type LlmClient,
  type TurnResult,
  type TurnParams,
} from '../../src/gui/ai/chat.js';
import { buildAnthropicTools } from '../../src/gui/ai/tools.js';
import type { ChatStreamEvent } from '../../src/gui/ai/sse.js';

// Adaptive output-token escalation.
//
// A fixed max-output-tokens cap applies to every chat-loop model call, so any
// tool whose arguments scale with the content it carries hits an INVISIBLE
// wall: the tool_use block is cut mid-JSON, the incomplete trailing property is
// dropped by the streaming parser, and the call arrives missing a required
// argument. The model then blind-retries into the same wall.
//
// The cap is a runaway brake, not a cost control (billing is on tokens actually
// produced), so the fix is to notice that exact shape — a max-tokens stop whose
// LAST tool call is missing a declared-required argument — and retry THAT ONE
// call on the next rung of an output ladder. Nothing changes for any other
// finish, including a plain long answer that ran out of room.

async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** A client that replays scripted turns and records the budget of every call. */
function recordingClient(
  turns: (TurnResult & { say?: string })[],
): LlmClient & { budgets: number[]; calls: number } {
  const state = {
    budgets: [] as number[],
    calls: 0,
    runTurn(params: TurnParams): Promise<TurnResult> {
      state.budgets.push(params.maxTokens ?? -1);
      const t = turns[Math.min(state.calls, turns.length - 1)]!;
      state.calls++;
      if (t.text) params.onText(t.text);
      return Promise.resolve(t);
    },
  };
  return state;
}

describe('adaptive output-token escalation', () => {
  let tmpDir: string;
  let db: Lattice;
  let dispatch: DispatchCtx;
  let warns: string[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-budget-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    db.define('people', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'people.md',
    });
    db.define('_lattice_gui_audit', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        ts: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        table_name: 'TEXT NOT NULL',
        row_id: 'TEXT',
        operation: 'TEXT NOT NULL',
        before_json: 'TEXT',
        after_json: 'TEXT',
        undone: 'INTEGER NOT NULL DEFAULT 0',
      },
      render: () => '',
      outputFile: '.lattice-gui/audit.md',
    });
    await db.init();
    dispatch = {
      db,
      feed: new FeedBus(),
      validTables: new Set(['people']),
      junctionTables: new Set(),
      softDeletable: new Set(['people']),
    };
    warns = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args.map((a) => String(a)).join(' '));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── The ladder itself ─────────────────────────────────────────────────────

  it('climbs strictly, starting at the ordinary chat cap', () => {
    expect(OUTPUT_BUDGET_TIERS[0]).toBe(4096);
    expect(OUTPUT_BUDGET_TIERS.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < OUTPUT_BUDGET_TIERS.length; i++) {
      expect(OUTPUT_BUDGET_TIERS[i]!).toBeGreaterThan(OUTPUT_BUDGET_TIERS[i - 1]!);
    }
  });

  // ── Detection ─────────────────────────────────────────────────────────────

  describe('truncatedToolCall', () => {
    const tools = buildAnthropicTools();

    it('flags a max-tokens round whose last call lost a required argument', () => {
      const cut = truncatedToolCall(
        {
          stopReason: 'max_tokens',
          // `values` was being written when generation was cut; the streaming
          // parser drops the incomplete trailing property outright.
          toolUses: [{ id: 't1', name: 'create_row', input: { table: 'people' } }],
        },
        tools,
      );
      expect(cut).not.toBeNull();
      expect(cut!.name).toBe('create_row');
      expect(cut!.missing).toEqual(['values']);
    });

    it('does NOT flag a complete call that merely stopped at max_tokens', () => {
      // max_tokens can also clip the TEXT after a finished tool_use block.
      expect(
        truncatedToolCall(
          {
            stopReason: 'max_tokens',
            toolUses: [
              { id: 't1', name: 'create_row', input: { table: 'people', values: { id: 'p1' } } },
            ],
          },
          tools,
        ),
      ).toBeNull();
    });

    it('does NOT flag a round with no tool calls (a plain long answer)', () => {
      expect(truncatedToolCall({ stopReason: 'max_tokens', toolUses: [] }, tools)).toBeNull();
    });

    it('does NOT flag a malformed call on a normal finish (that is a model error)', () => {
      expect(
        truncatedToolCall(
          {
            stopReason: 'tool_use',
            toolUses: [{ id: 't1', name: 'create_row', input: { table: 'people' } }],
          },
          tools,
        ),
      ).toBeNull();
    });

    it('only considers the LAST call — an earlier one cannot have been cut', () => {
      expect(
        truncatedToolCall(
          {
            stopReason: 'max_tokens',
            toolUses: [
              { id: 't1', name: 'create_row', input: { table: 'people' } },
              { id: 't2', name: 'list_rows', input: { table: 'people' } },
            ],
          },
          tools,
        ),
      ).toBeNull();
    });

    it('ignores a tool it has no schema for rather than guessing', () => {
      expect(
        truncatedToolCall(
          { stopReason: 'max_tokens', toolUses: [{ id: 't1', name: 'no_such_tool', input: {} }] },
          tools,
        ),
      ).toBeNull();
    });
  });

  // ── Escalation ────────────────────────────────────────────────────────────

  it('retries the cut call exactly once at the next tier, then succeeds', async () => {
    const client = recordingClient([
      // Round 1, attempt 1: cut mid-`values` at the 4096 cap.
      {
        stopReason: 'max_tokens',
        text: 'Adding that now.',
        toolUses: [{ id: 'tu1', name: 'create_row', input: { table: 'people' } }],
      },
      // Round 1, attempt 2 (escalated): the whole call fits.
      {
        stopReason: 'tool_use',
        text: 'Adding that now.',
        toolUses: [
          {
            id: 'tu1',
            name: 'create_row',
            input: { table: 'people', values: { id: 'p1', name: 'Ada' } },
          },
        ],
      },
      // Round 2: the answer.
      { stopReason: 'end_turn', text: 'Done — added Ada.', toolUses: [] },
    ]);

    const events = await collect(runChat({ client, dispatch, userMessage: 'add Ada' }));

    // Exactly one escalation: two calls for round 1, one for round 2.
    expect(client.calls).toBe(3);
    expect(client.budgets).toEqual([
      OUTPUT_BUDGET_TIERS[0],
      OUTPUT_BUDGET_TIERS[1],
      OUTPUT_BUDGET_TIERS[0],
    ]);

    // The retried call actually ran and wrote the row.
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toMatchObject({ toolUseId: 'tu1', isError: false });
    const row = (await db.get('people', 'p1')) as { name: string } | null;
    expect(row?.name).toBe('Ada');

    // The abandoned attempt's streamed preamble is replaced, not duplicated.
    const finals = events.filter((e) => e.type === 'text_final');
    expect(finals.length).toBeGreaterThanOrEqual(1);
    expect(finals[0]).toMatchObject({ text: 'Adding that now.' });

    // …and each escalation is logged.
    const escalationLogs = warns.filter((w) => w.includes('output token'));
    expect(escalationLogs.length).toBe(1);
    expect(escalationLogs[0]).toContain('create_row');
    expect(escalationLogs[0]).toContain(String(OUTPUT_BUDGET_TIERS[0]));
    expect(escalationLogs[0]).toContain(String(OUTPUT_BUDGET_TIERS[1]));
  });

  it('logs every escalation as it climbs the ladder', async () => {
    const tiers = OUTPUT_BUDGET_TIERS.length;
    const client = recordingClient([
      // Cut at every tier except the last.
      ...Array.from({ length: tiers - 1 }, () => ({
        stopReason: 'max_tokens',
        text: '',
        toolUses: [{ id: 'tu1', name: 'create_row', input: { table: 'people' } }],
      })),
      {
        stopReason: 'tool_use',
        text: '',
        toolUses: [
          { id: 'tu1', name: 'create_row', input: { table: 'people', values: { id: 'p2' } } },
        ],
      },
      { stopReason: 'end_turn', text: 'done', toolUses: [] },
    ]);

    await collect(runChat({ client, dispatch, userMessage: 'add one' }));

    expect(client.budgets.slice(0, tiers)).toEqual([...OUTPUT_BUDGET_TIERS]);
    expect(warns.filter((w) => w.includes('output token')).length).toBe(tiers - 1);
  });

  it('stops at the ceiling and surfaces a clear error instead of looping', async () => {
    // Never recovers: every attempt comes back cut off inside the same call.
    const client = recordingClient([
      {
        stopReason: 'max_tokens',
        text: '',
        toolUses: [{ id: 'tu1', name: 'create_row', input: { table: 'people' } }],
      },
    ]);

    const records: { isError: boolean; content: string }[] = [];
    const events = await collect(
      runChat({
        client,
        dispatch,
        userMessage: 'add a huge thing',
        onToolRecord: (rec) => records.push({ isError: rec.isError, content: rec.content }),
      }),
    );

    const tiers = OUTPUT_BUDGET_TIERS.length;
    // Each round climbs the ladder ONCE and then gives up — it never re-climbs
    // within a round, and the all-failed circuit breaker ends the turn.
    expect(client.budgets.slice(0, tiers)).toEqual([...OUTPUT_BUDGET_TIERS]);
    expect(client.calls).toBe(tiers * 3);

    // The cut call is handed back as an explicit, actionable error — not a
    // silent no-op and not an invisible wall.
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.isError)).toBe(true);
    expect(records[0]!.content).toContain('cut off');
    expect(records[0]!.content).toContain(String(OUTPUT_BUDGET_TIERS[tiers - 1]));
    expect(records[0]!.content).toContain('values');

    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    // The row was never written, and the user is told so.
    expect((await db.query('people', {})).length).toBe(0);
  });

  // ── Non-escalation: everything else is unchanged ──────────────────────────

  it('does NOT escalate a plain long answer that ran out of room', async () => {
    const client = recordingClient([
      { stopReason: 'max_tokens', text: 'A very long answer that got clipped', toolUses: [] },
    ]);

    const events = await collect(runChat({ client, dispatch, userMessage: 'explain' }));

    expect(client.calls).toBe(1);
    expect(client.budgets).toEqual([OUTPUT_BUDGET_TIERS[0]]);
    expect(warns.filter((w) => w.includes('output token')).length).toBe(0);
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
  });

  it('does NOT escalate a COMPLETE tool call that stopped at max_tokens', async () => {
    const client = recordingClient([
      {
        stopReason: 'max_tokens',
        text: '',
        toolUses: [
          {
            id: 'tu1',
            name: 'create_row',
            input: { table: 'people', values: { id: 'p3', name: 'Grace' } },
          },
        ],
      },
      { stopReason: 'end_turn', text: 'added', toolUses: [] },
    ]);

    const events = await collect(runChat({ client, dispatch, userMessage: 'add Grace' }));

    expect(client.calls).toBe(2); // one per round, no retry
    expect(warns.filter((w) => w.includes('output token')).length).toBe(0);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: false });
    expect(((await db.get('people', 'p3')) as { name: string } | null)?.name).toBe('Grace');
  });
});
