import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/ai/feed.js';
import type { DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { runChat, type LlmClient, type TurnResult } from '../../src/gui/ai/chat.js';
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
    dispatch = { db, feed, validTables: new Set(['people']), softDeletable: new Set(['people']) };
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
