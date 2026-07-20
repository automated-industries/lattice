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
 * step-narration, not the answer — it must NOT survive as a chat message (it reads
 * as broken and was being persisted + replayed).
 *
 * Text now streams LIVE (before tool use is known), so a tool round's preamble DOES
 * arrive as text_delta — but that round's assistant_message_end carries hadTools:true,
 * so the client reaps its bubble and the route drops its text from the persisted
 * message. `keptText` below mirrors that "keep only non-tool-round text" rule; the
 * preamble must not appear in it.
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

/** The text a client/route KEEPS: accumulate each round's text_delta, then drop it if
 *  that round ended with hadTools (pre-tool preamble). Mirrors the route's persistence. */
function keptText(events: ChatStreamEvent[]): string {
  let kept = '';
  let cur = '';
  for (const e of events) {
    if (e.type === 'assistant_message_start') cur = '';
    else if (e.type === 'text_delta') cur += e.delta;
    else if (e.type === 'assistant_message_end') {
      if (!e.hadTools) kept += cur;
      cur = '';
    }
  }
  return kept;
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

  it("a tool round's preamble is flagged hadTools and dropped from the kept text; the answer survives", async () => {
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

    // The preamble round is flagged for discard; the final answer round is not.
    const ends = events.filter((e) => e.type === 'assistant_message_end') as {
      type: 'assistant_message_end';
      hadTools?: boolean;
    }[];
    expect(ends.map((e) => e.hadTools)).toEqual([true, false]);

    // What the client/route KEEP: the final answer reached the user…
    const kept = keptText(events);
    expect(kept).toContain('Here is your answer.');
    // …but the pre-tool preamble did NOT (it would read as a stray, buggy message).
    expect(kept).not.toContain('Let me look that up.');
  });
});
