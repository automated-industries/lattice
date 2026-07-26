import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import type { DispatchCtx } from '../../src/gui/ai/dispatch.js';
import {
  runChat,
  type LlmClient,
  type TurnResult,
  type TokenUsage,
} from '../../src/gui/ai/chat.js';
import type { ChatStreamEvent } from '../../src/gui/ai/sse.js';
import {
  humanizeAssistantRefusal,
  humanizeContextWindowExceeded,
} from '../../src/gui/ai/error-humanize.js';

/**
 * Assistant hardening: distinct stop_reason handling (refusal, context-window
 * exhaustion) and per-turn token-usage passthrough on the chat stream.
 */

/** A scripted LlmClient that returns queued turns verbatim. */
function scriptedClient(turns: (Partial<TurnResult> & { text: string })[]): {
  client: LlmClient;
  calls: () => number;
} {
  let i = 0;
  return {
    calls: () => i,
    client: {
      runTurn(params) {
        const turn = turns[Math.min(i, turns.length - 1)];
        i++;
        for (const ch of turn.text.split(' ')) params.onText(ch + ' ');
        return Promise.resolve({
          stopReason: turn.stopReason ?? (turn.toolUses?.length ? 'tool_use' : 'end_turn'),
          text: turn.text,
          toolUses: turn.toolUses ?? [],
          ...(turn.usage ? { usage: turn.usage } : {}),
        });
      },
    },
  };
}

async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('assistant stop_reason handling and usage passthrough', () => {
  let tmpDir: string;
  let db: Lattice;
  let dispatch: DispatchCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-usage-'));
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

  it('surfaces a distinct humanized message when the model refuses', async () => {
    const { client } = scriptedClient([{ text: '', stopReason: 'refusal' }]);
    const events = await collect(runChat({ client, dispatch, userMessage: 'hi' }));
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toBe(humanizeAssistantRefusal());
    // The turn ends without a normal assistant_message_end.
    expect(events.some((e) => e.type === 'assistant_message_end')).toBe(false);
  });

  it('surfaces a distinct humanized message on context-window exhaustion', async () => {
    const { client } = scriptedClient([
      { text: 'partial…', stopReason: 'model_context_window_exceeded' },
    ]);
    const events = await collect(runChat({ client, dispatch, userMessage: 'hi' }));
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toBe(humanizeContextWindowExceeded());
  });

  it('refusal and context-window messages are distinct from each other', () => {
    expect(humanizeAssistantRefusal()).not.toBe(humanizeContextWindowExceeded());
    expect(humanizeAssistantRefusal().length).toBeGreaterThan(0);
    expect(humanizeContextWindowExceeded().length).toBeGreaterThan(0);
  });

  it('passes per-turn token usage through on assistant_message_end', async () => {
    const usage: TokenUsage = {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 0,
    };
    const { client } = scriptedClient([{ text: 'hello there', usage }]);
    const events = await collect(runChat({ client, dispatch, userMessage: 'hi' }));
    const ends = events.filter((e) => e.type === 'assistant_message_end');
    expect(ends).toHaveLength(1);
    expect((ends[0] as { usage?: TokenUsage }).usage).toEqual(usage);
  });

  it('omits the usage field when the provider reports none', async () => {
    const { client } = scriptedClient([{ text: 'hello there' }]);
    const events = await collect(runChat({ client, dispatch, userMessage: 'hi' }));
    const ends = events.filter((e) => e.type === 'assistant_message_end');
    expect(ends).toHaveLength(1);
    expect('usage' in (ends[0] as Record<string, unknown>)).toBe(false);
  });
});
