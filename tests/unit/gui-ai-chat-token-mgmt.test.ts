import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import type { DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { runChat, type LlmClient, type LlmMessage } from '../../src/gui/ai/chat.js';
import type { ChatStreamEvent } from '../../src/gui/ai/sse.js';

// #10 — assistant token management: a "prompt is too long" provider error is
// recovered invisibly (trim oldest tool result + retry), never shown raw to the
// user, and a single tool result can't blow the context window (live cap).

async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
const TOO_LONG = '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 211074 tokens > 200000 maximum"}}';

describe('#10 assistant token management', () => {
  let tmpDir: string;
  let db: Lattice;
  let dispatch: DispatchCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-tok-'));
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
    vi.restoreAllMocks();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-recovers from a "prompt too long" error by trimming + retrying — no error shown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const client: LlmClient = {
      runTurn(params) {
        calls++;
        if (calls === 1) return Promise.reject(new Error(TOO_LONG));
        params.onText('recovered');
        return Promise.resolve({ stopReason: 'end_turn', text: 'recovered', toolUses: [] });
      },
    };
    // History carries a bulky tool_result the recovery can trim (same object
    // refs runChat mutates, since it shallow-copies history into messages).
    const toolResultMsg: LlmMessage = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'h1', content: 'X'.repeat(5000) }],
    };
    const history: LlmMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'h1', name: 'list_rows', input: {} }] },
      toolResultMsg,
    ];

    const events = await collect(runChat({ client, dispatch, userMessage: 'go', history }));
    const types = events.map((e) => e.type);

    expect(calls).toBe(2); // failed once, retried once
    expect(types).not.toContain('error'); // the 400 never surfaced
    expect(types[types.length - 1]).toBe('done');
    expect(events.some((e) => e.type === 'text_delta' && e.delta.includes('recovered'))).toBe(true);
    // The oldest bulky tool result was shrunk to a placeholder (invisible trim).
    const block = (toolResultMsg.content as { type: string; content: string }[])[0];
    expect(block?.content).not.toBe('X'.repeat(5000));
    expect(block?.content.length).toBeLessThan(100);
  });

  it('translates an unrecoverable "prompt too long" into a friendly message (never the raw 400)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client: LlmClient = {
      runTurn() {
        return Promise.reject(new Error(TOO_LONG));
      },
    };
    // No trimmable tool result in history → recovery can't help → friendly error.
    const events = await collect(runChat({ client, dispatch, userMessage: 'go' }));
    const err = events.find((e) => e.type === 'error') as { type: 'error'; message: string } | undefined;

    expect(err).toBeDefined();
    expect(err!.message).toMatch(/too large/i);
    expect(err!.message).not.toContain('prompt is too long');
    expect(err!.message).not.toContain('211074');
    expect(events[events.length - 1]?.type).toBe('done');
  });

  it('caps a huge tool result before it enters the next turn prompt', async () => {
    for (let i = 0; i < 120; i++) {
      await db.insert('people', { id: `p${i}`, name: `Person ${i} ` + 'y'.repeat(300) });
    }
    const captured: { messages?: LlmMessage[] } = {};
    let calls = 0;
    const client: LlmClient = {
      runTurn(params) {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            stopReason: 'tool_use',
            text: '',
            toolUses: [{ id: 't1', name: 'list_rows', input: { table: 'people' } }],
          });
        }
        captured.messages = params.messages;
        return Promise.resolve({ stopReason: 'end_turn', text: 'ok', toolUses: [] });
      },
    };

    await collect(runChat({ client, dispatch, userMessage: 'list people' }));

    const userMsgs = (captured.messages ?? []).filter(
      (m) => m.role === 'user' && Array.isArray(m.content),
    );
    const toolResult = userMsgs
      .flatMap((m) => m.content as { type: string; content?: string }[])
      .find((b) => b.type === 'tool_result');
    expect(toolResult).toBeDefined();
    // Raw serialized result is well over the cap (>40k chars); the live cap keeps
    // what reaches the model bounded and tells it to page.
    expect((toolResult!.content ?? '').length).toBeLessThan(20000);
    expect(toolResult!.content ?? '').toMatch(/too large to include in full|truncated/i);
  });
});
