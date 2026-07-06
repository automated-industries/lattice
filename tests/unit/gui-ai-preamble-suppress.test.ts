import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import type { DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { runChat, type LlmClient, type TurnResult } from '../../src/gui/ai/chat.js';
import type { ChatStreamEvent } from '../../src/gui/ai/sse.js';

/**
 * The assistant runs a multi-round tool loop. On a tool-calling round the model
 * often emits a short "thinking out loud" preamble ("Let me search again", "Let me
 * fix that by adding a slug") in the SAME message as the tool_use. That is private
 * step-narration, not the answer — it must NOT reach the user as a chat message
 * (it reads as broken and was being persisted + replayed). runChat now streams a
 * round's text as text_delta ONLY when the round called no tools (the final answer).
 */

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

describe('inter-tool preamble is suppressed from the chat stream', () => {
  let tmpDir: string;
  let db: Lattice;
  let dispatch: DispatchCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-preamble-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    db.define('people', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'people.md',
    });
    await db.init();
    dispatch = {
      db,
      feed: new FeedBus(),
      validTables: new Set(['people']),
      junctionTables: new Set(),
      softDeletable: new Set(['people']),
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a tool-calling round's preamble never streams; only the tool-less final answer does", async () => {
    const client = scriptedClient([
      // Round 1: a "thinking out loud" preamble ALONGSIDE a tool call.
      {
        text: 'Let me look that up.',
        toolUses: [{ id: 't1', name: 'list_rows', input: { table: 'people' } }],
      },
      // Round 2: the final answer, no tools.
      { text: 'Here is your answer.', toolUses: [] },
    ]);
    const events = await collect(runChat({ client, dispatch, userMessage: 'who is here' }));
    const streamed = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e as { type: 'text_delta'; delta: string }).delta)
      .join('');
    // The final answer reached the user…
    expect(streamed).toContain('Here is your answer.');
    // …but the pre-tool preamble did NOT (it would read as a stray, buggy message).
    expect(streamed).not.toContain('Let me look that up.');
  });
});
