import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import type { DispatchCtx } from '../../src/gui/ai/dispatch.js';
import {
  runChat,
  type LlmClient,
  type TurnResult,
  type LlmMessage,
} from '../../src/gui/ai/chat.js';
import type { ChatStreamEvent } from '../../src/gui/ai/sse.js';

/** A scripted LlmClient that returns a queued result per call, streaming text. */
function scriptedClient(turns: { text: string; toolUses?: TurnResult['toolUses'] }[]): LlmClient {
  let i = 0;
  return {
    runTurn(params) {
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      for (const ch of (turn?.text ?? '').split(' ')) params.onText(ch + ' ');
      const toolUses = turn?.toolUses ?? [];
      return Promise.resolve({
        stopReason: toolUses.length ? 'tool_use' : 'end_turn',
        text: turn?.text ?? '',
        toolUses,
      });
    },
  };
}

async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('chat tool loop', () => {
  let tmpDir: string;
  let db: Lattice;
  let feed: FeedBus;
  let dispatch: DispatchCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-chat-'));
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
    feed = new FeedBus();
    dispatch = {
      db,
      feed,
      validTables: new Set(['people']),
      junctionTables: new Set(),
      softDeletable: new Set(['people']),
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('streams a text-only answer and ends with done', async () => {
    const client = scriptedClient([{ text: 'Hello there' }]);
    const events = await collect(runChat({ client, dispatch, userMessage: 'hi' }));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('assistant_message_start');
    expect(types).toContain('text_delta');
    expect(types).toContain('assistant_message_end');
    expect(types[types.length - 1]).toBe('done');
    expect(types).not.toContain('tool_use');
  });

  it('executes a tool call, feeds the result back, and applies the DB change', async () => {
    const client = scriptedClient([
      {
        text: 'Adding that now.',
        toolUses: [
          {
            id: 'tu1',
            name: 'create_row',
            input: { table: 'people', values: { id: 'p1', name: 'Ada' } },
          },
        ],
      },
      { text: 'Done — added Ada.' },
    ]);
    const feedEvents: FeedEvent[] = [];
    feed.subscribe((e) => feedEvents.push(e));

    const events = await collect(runChat({ client, dispatch, userMessage: 'add Ada' }));
    const types = events.map((e) => e.type);

    // Tool call surfaced, result not an error, stream completed.
    const toolUse = events.find((e) => e.type === 'tool_use');
    expect(toolUse).toEqual({ type: 'tool_use', id: 'tu1', name: 'create_row' });
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toMatchObject({ type: 'tool_result', toolUseId: 'tu1', isError: false });
    expect(types[types.length - 1]).toBe('done');
    // Two assistant turns (before + after the tool call).
    expect(types.filter((t) => t === 'assistant_message_start').length).toBe(2);

    // The row was actually written, and the feed saw an AI-sourced insert.
    const row = (await db.get('people', 'p1')) as { name: string } | null;
    expect(row?.name).toBe('Ada');
    expect(feedEvents.some((e) => e.op === 'insert' && e.source === 'ai')).toBe(true);
  });

  it('marks a tool round hadTools:true and the final answer hadTools:false', async () => {
    // Live streaming emits a round's text before tool use is known, so
    // assistant_message_end carries `hadTools` to tell the client/route which round
    // called a tool (its narration is kept as its own bubble) vs the final answer.
    const client = scriptedClient([
      {
        text: 'Let me add that',
        toolUses: [
          {
            id: 'tu1',
            name: 'create_row',
            input: { table: 'people', values: { id: 'p1', name: 'Ada' } },
          },
        ],
      },
      { text: 'Done — added Ada.' },
    ]);
    const events = await collect(runChat({ client, dispatch, userMessage: 'add Ada' }));
    const ends = events.filter((e) => e.type === 'assistant_message_end') as {
      type: 'assistant_message_end';
      hadTools?: boolean;
    }[];
    expect(ends.length).toBe(2);
    expect(ends[0]?.hadTools).toBe(true); // preamble round (called a tool)
    expect(ends[1]?.hadTools).toBe(false); // final answer round (no tools)
  });

  it('streams deltas that arrive across an await (live channel, not buffered per turn)', async () => {
    // The turn produces text, yields to the event loop, then produces more text
    // before resolving. The generator must yield BOTH deltas (the drain loop keeps
    // pulling from the channel across the await), not only what was buffered
    // synchronously before the first await.
    const client: LlmClient = {
      async runTurn(params) {
        params.onText('alpha ');
        await Promise.resolve(); // split the deltas across a microtask boundary
        params.onText('beta');
        return { stopReason: 'end_turn', text: 'alpha beta', toolUses: [] };
      },
    };
    const events = await collect(runChat({ client, dispatch, userMessage: 'hi' }));
    const deltas = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e as { type: 'text_delta'; delta: string }).delta);
    expect(deltas.join('')).toBe('alpha beta');
    expect(events[events.length - 1]?.type).toBe('done');
  });

  it('stops after consecutive tool failures (circuit-breaker) and surfaces the real error', async () => {
    // The model keeps calling a tool that always fails (get_row on a missing id).
    // The scripted client repeats this turn; the breaker must stop it well before
    // the 16-step cap and report the actual error, not loop into a hung indicator.
    const client = scriptedClient([
      {
        text: 'Looking that up…',
        toolUses: [{ id: 'tu', name: 'get_row', input: { table: 'people', id: 'nope' } }],
      },
    ]);
    const events = await collect(runChat({ client, dispatch, userMessage: 'tell me about nope' }));
    const types = events.map((e) => e.type);
    // Exactly 3 failed rounds (MAX_CONSECUTIVE_TOOL_FAILURES), not 16.
    expect(types.filter((t) => t === 'tool_result').length).toBe(3);
    const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
    expect(err).toBeTruthy();
    expect(err?.message).toMatch(/every tool call failed|Row not found/i);
    expect(types[types.length - 1]).toBe('done');
  });

  it('replays prior tool_use + tool_result history into the model messages', async () => {
    // A follow-up turn: history already carries the structured tool blocks the
    // chat route rehydrates (assistant tool_use → user tool_result). The row id
    // read earlier (s1) must reach the model THIS turn — that is what lets
    // "update it" target the right row instead of guessing/fabricating an id.
    let captured: LlmMessage[] = [];
    const client: LlmClient = {
      runTurn(params) {
        captured = params.messages;
        return Promise.resolve({ stopReason: 'end_turn', text: 'ok', toolUses: [] });
      },
    };
    const history: LlmMessage[] = [
      { role: 'user', content: 'list staff' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'list_rows', input: { table: 'people' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: '[{"id":"s1","name":"Alpha"}]',
            is_error: false,
          },
        ],
      },
      { role: 'assistant', content: 'Found Alpha.' },
    ];
    await collect(runChat({ client, dispatch, history, userMessage: 'what is the id of Alpha?' }));
    const flat = JSON.stringify(captured);
    expect(flat).toContain('tu1'); // tool_use id round-tripped into the model context
    expect(flat).toContain('s1'); // the row id from the earlier read survives the turn
    expect(flat).toContain('tool_result'); // delivered as a real block, not flattened text
  });

  it('injects the live schema (table names) + file guidance into the system prompt', async () => {
    let capturedSystem = '';
    const client: LlmClient = {
      runTurn(params) {
        capturedSystem = params.system;
        for (const ch of 'ok'.split(' ')) params.onText(ch);
        return Promise.resolve({ stopReason: 'end_turn', text: 'ok', toolUses: [] });
      },
    };
    await collect(runChat({ client, dispatch, userMessage: 'what tables exist?' }));

    // The model is told the REAL table name so it never has to guess (guessing
    // produced the "Unknown table" → "Could not fetch/list row" errors).
    expect(capturedSystem).toContain('# Current database');
    expect(capturedSystem).toContain('people');
    // And where an attached file's content lives, so it reads CSV/doc text.
    expect(capturedSystem).toContain('extracted_text');
    // And not to claim success after a failed tool call.
    expect(capturedSystem.toLowerCase()).toContain('error');
  });

  it('no longer pushes back on bulk work — points at bulk_update instead of looping/refusing (3.3.5)', async () => {
    let capturedSystem = '';
    const client: LlmClient = {
      runTurn(params) {
        capturedSystem = params.system;
        return Promise.resolve({ stopReason: 'end_turn', text: 'ok', toolUses: [] });
      },
    };
    await collect(runChat({ client, dispatch, userMessage: 'make every row private' }));

    // The old defensive pushback / per-page write framing is gone.
    expect(capturedSystem).not.toContain('small batches');
    expect(capturedSystem).not.toContain('NEVER try to load');
    expect(capturedSystem).not.toContain('a page at a time');
    // The new directives: just do it, design the bulk op once with bulk_update,
    // and never refuse for size or offer a script instead.
    expect(capturedSystem).toContain('bulk_update');
    expect(capturedSystem).toContain('Never refuse');
    expect(capturedSystem).toMatch(/never offer to "write a script"/i);
  });

  it('tells the assistant to MERGE entities via delete_entity move_to without asking (reversible)', async () => {
    let capturedSystem = '';
    const client: LlmClient = {
      runTurn(params) {
        capturedSystem = params.system;
        return Promise.resolve({ stopReason: 'end_turn', text: 'ok', toolUses: [] });
      },
    };
    await collect(runChat({ client, dispatch, userMessage: 'merge these two lists into one' }));

    // Consolidating one object into another must use the reversible move_to merge
    // path (delete_entity), be done WITHOUT asking, and the model must stop ending
    // the turn by telling the user they can now delete the old object themselves.
    expect(capturedSystem).toMatch(/CONSOLIDATE or MERGE/i);
    expect(capturedSystem).toContain('delete_entity');
    expect(capturedSystem).toContain('move_to');
    expect(capturedSystem).toMatch(/do NOT ask the user to confirm first/i);
    expect(capturedSystem).toMatch(/restored from history/i);
    expect(capturedSystem).toMatch(/do NOT end by telling them they can now delete/i);
    // If the merge tool refuses (e.g. too large), relay it — never retry the same call.
    expect(capturedSystem).toMatch(/too large to merge automatically/i);
    expect(capturedSystem).toMatch(/do NOT retry the same call/i);
  });

  it('teaches the derived-vs-new decision for "make me a table of X" (computed views)', async () => {
    let capturedSystem = '';
    const client: LlmClient = {
      runTurn(params) {
        capturedSystem = params.system;
        return Promise.resolve({ stopReason: 'end_turn', text: 'ok', toolUses: [] });
      },
    };
    await collect(runChat({ client, dispatch, userMessage: 'make me a table of urgent tickets' }));

    // A "table of X" over data that already exists must go preview-first through
    // the computed-table tools — not create_entity — and be described to the
    // user as "a computed view" in plain language.
    expect(capturedSystem).toContain('preview_computed_table');
    expect(capturedSystem).toContain('create_computed_table');
    expect(capturedSystem).toContain('a computed view');
    expect(capturedSystem).toMatch(/check every field's status/i);
    expect(capturedSystem).toMatch(/ask ONE short question/);
    // The no-jargon rule extends to the computed vocabulary.
    expect(capturedSystem).toMatch(/never say SQL or JOIN/);
  });

  it('tags computed views in the schema context so the model treats them as read-only', async () => {
    await db.defineLate('people_summary', {
      columns: { id: 'TEXT PRIMARY KEY', who: 'TEXT' },
      render: () => '',
      outputFile: 'people_summary.md',
    });
    const d: DispatchCtx = {
      ...dispatch,
      validTables: new Set(['people', 'people_summary']),
      computedTables: new Set(['people_summary']),
    };
    let capturedSystem = '';
    const client: LlmClient = {
      runTurn(params) {
        capturedSystem = params.system;
        return Promise.resolve({ stopReason: 'end_turn', text: 'ok', toolUses: [] });
      },
    };
    await collect(runChat({ client, dispatch: d, userMessage: 'what do I have?' }));

    expect(capturedSystem).toContain('people_summary [computed view — read-only]');
    // Ordinary tables carry no computed tag.
    expect(capturedSystem).not.toContain('people [computed view');
  });

  it("injects the cloud owner's workspace system prompt when provided", async () => {
    let capturedSystem = '';
    const client: LlmClient = {
      runTurn(params) {
        capturedSystem = params.system;
        return Promise.resolve({ stopReason: 'end_turn', text: 'ok', toolUses: [] });
      },
    };
    await collect(
      runChat({
        client,
        dispatch,
        userMessage: 'hi',
        cloudSystemPrompt: 'Always answer in a formal tone. Our fiscal year starts in July.',
      }),
    );
    expect(capturedSystem).toContain('# Workspace instructions');
    expect(capturedSystem).toContain(
      'Always answer in a formal tone. Our fiscal year starts in July.',
    );
  });

  it('adds no workspace section when there is no cloud system prompt (local / unset)', async () => {
    let capturedSystem = '';
    const client: LlmClient = {
      runTurn(params) {
        capturedSystem = params.system;
        return Promise.resolve({ stopReason: 'end_turn', text: 'ok', toolUses: [] });
      },
    };
    await collect(runChat({ client, dispatch, userMessage: 'hi' }));
    expect(capturedSystem).not.toContain('# Workspace instructions');
    // A blank/whitespace prompt is also treated as "none".
    await collect(runChat({ client, dispatch, userMessage: 'hi', cloudSystemPrompt: '   ' }));
    expect(capturedSystem).not.toContain('# Workspace instructions');
  });

  it('puts the operator name in the system prompt so the assistant never asks for it (2.2.2)', async () => {
    let capturedSystem = '';
    const client: LlmClient = {
      runTurn(params) {
        capturedSystem = params.system;
        return Promise.resolve({ stopReason: 'end_turn', text: 'ok', toolUses: [] });
      },
    };
    await collect(
      runChat({ client, dispatch, userMessage: 'link this to me', operatorName: 'Ada Lovelace' }),
    );
    expect(capturedSystem).toContain('You are assisting Ada Lovelace');
    expect(capturedSystem).toContain('never ask the user for their own name');
  });

  it('omits the operator section when no name is available', async () => {
    let capturedSystem = '';
    const client: LlmClient = {
      runTurn(params) {
        capturedSystem = params.system;
        return Promise.resolve({ stopReason: 'end_turn', text: 'ok', toolUses: [] });
      },
    };
    await collect(runChat({ client, dispatch, userMessage: 'hi' })); // no operatorName
    expect(capturedSystem).not.toContain('You are assisting');
    expect(capturedSystem).toContain('# Current database'); // base prompt intact
  });

  it('never exposes the secrets table in the schema context', async () => {
    let capturedSystem = '';
    const client: LlmClient = {
      runTurn(params) {
        capturedSystem = params.system;
        return Promise.resolve({ stopReason: 'end_turn', text: 'ok', toolUses: [] });
      },
    };
    // Even if `secrets` is present in validTables, the model must never be told
    // it exists (it holds decrypted credentials).
    const withSecrets: DispatchCtx = { ...dispatch, validTables: new Set(['people', 'secrets']) };
    await collect(runChat({ client, dispatch: withSecrets, userMessage: 'list everything' }));
    expect(capturedSystem).toContain('people');
    expect(capturedSystem).not.toContain('secrets');
  });

  it('warns (instead of stopping silently) when the tool-step limit is reached', async () => {
    // A model that never stops asking for a tool drives the loop to its cap.
    const client: LlmClient = {
      runTurn() {
        return Promise.resolve({
          stopReason: 'tool_use',
          text: 'still working',
          toolUses: [{ id: 'u', name: 'get_history', input: {} }],
        });
      },
    };
    const events = await collect(runChat({ client, dispatch, userMessage: 'do a huge bulk job' }));
    const types = events.map((e) => e.type);
    expect(types).toContain('warn'); // no silent truncation
    const warn = events.find((e) => e.type === 'warn');
    expect((warn as { message: string }).message).toMatch(/limit|incomplete/i);
    expect(types[types.length - 1]).toBe('done'); // still ends cleanly
  });

  it('surfaces a tool error as a tool_result(isError) without aborting the stream', async () => {
    const client = scriptedClient([
      {
        text: 'Trying.',
        toolUses: [{ id: 'tu1', name: 'create_row', input: { table: 'ghosts', values: {} } }],
      },
      { text: 'That table does not exist.' },
    ]);
    const events = await collect(runChat({ client, dispatch, userMessage: 'add to ghosts' }));
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toMatchObject({ type: 'tool_result', isError: true });
    expect(events[events.length - 1]?.type).toBe('done');
  });
});
