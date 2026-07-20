import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { executeFunction, DISPATCHABLE, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { getFunction } from '../../src/gui/ai/registry.js';
import {
  runChat,
  parseAskUserInput,
  type LlmClient,
  type TurnResult,
} from '../../src/gui/ai/chat.js';
import type { ChatStreamEvent } from '../../src/gui/ai/sse.js';

/**
 * The in-turn ask_user tool: the model asks ONE short multiple-choice question,
 * the server emits a typed `question` stream event, feeds a canned tool_result
 * back, and ENDS the turn — the user's answer arrives as the next chat message.
 */

/** A scripted LlmClient that counts calls and returns queued turns. */
function scriptedClient(turns: { text: string; toolUses?: TurnResult['toolUses'] }[]): {
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
        for (const ch of (turn?.text ?? '').split(' ')) params.onText(ch + ' ');
        const toolUses = turn?.toolUses ?? [];
        return Promise.resolve({
          stopReason: toolUses.length ? 'tool_use' : 'end_turn',
          text: turn?.text ?? '',
          toolUses,
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

describe('ask_user assistant tool', () => {
  let tmpDir: string;
  let db: Lattice;
  let dispatch: DispatchCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-askuser-'));
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

  it('is declared in the registry (non-mutating) and offered to the model (DISPATCHABLE)', () => {
    const fn = getFunction('ask_user');
    expect(fn).toBeDefined();
    expect(fn?.mutates).toBe(false);
    expect(fn?.args.required).toEqual(['question', 'options']);
    // Information-seeking about the data's meaning, never storage mechanics —
    // and marginal-confidence framing (< ~60% → ask) with set_definition
    // persistence, so the answer outlives the chat.
    expect(fn?.description).toMatch(/60%/);
    expect(fn?.description).toMatch(/never about storage mechanics/i);
    expect(fn?.description).toMatch(/set_definition/);
    expect(DISPATCHABLE.has('ask_user')).toBe(true);
  });

  it('never executes through the dispatcher (chat-stream only)', async () => {
    const r = await executeFunction(dispatch, 'ask_user', {
      question: 'Q?',
      options: ['A', 'B'],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/chat stream/i);
  });

  it('emits a question stream event, records the canned tool_result, and stops the turn', async () => {
    // The scripted client REPEATS its last turn — if the loop did not stop
    // after ask_user, the model would be called again and again until the cap.
    const { client, calls } = scriptedClient([
      {
        text: 'Let me check something first.',
        toolUses: [
          {
            id: 'tu1',
            name: 'ask_user',
            input: {
              question: 'Is this list meant to track suppliers?',
              options: ['Yes, suppliers', 'No, customers'],
            },
          },
        ],
      },
    ]);
    const records: { name: string; content: string; isError: boolean }[] = [];
    const events = await collect(
      runChat({
        client,
        dispatch,
        userMessage: 'organize this',
        onToolRecord: (r) => records.push({ name: r.name, content: r.content, isError: r.isError }),
      }),
    );
    const types = events.map((e) => e.type);
    // The typed question event, with allow_other defaulting true.
    const q = events.find((e) => e.type === 'question');
    expect(q).toEqual({
      type: 'question',
      question: 'Is this list meant to track suppliers?',
      options: ['Yes, suppliers', 'No, customers'],
      allowOther: true,
    });
    // The tool_use stays paired with a non-error tool_result.
    expect(events.find((e) => e.type === 'tool_use')).toEqual({
      type: 'tool_use',
      id: 'tu1',
      name: 'ask_user',
    });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      toolUseId: 'tu1',
      isError: false,
    });
    // The model was fed the canned "answer arrives next message" result.
    expect(records).toEqual([
      {
        name: 'ask_user',
        content: 'Question shown to the user; their answer will arrive as the next message.',
        isError: false,
      },
    ]);
    // Turn STOPPED: exactly one model call, one assistant message, clean done,
    // and no step-cap warning.
    expect(calls()).toBe(1);
    expect(types.filter((t) => t === 'assistant_message_start').length).toBe(1);
    expect(types).not.toContain('warn');
    expect(types[types.length - 1]).toBe('done');
  });

  it('honors allow_other=false on the emitted event', async () => {
    const { client } = scriptedClient([
      {
        text: '',
        toolUses: [
          {
            id: 'tu1',
            name: 'ask_user',
            input: { question: 'Which one?', options: ['A', 'B', 'C'], allow_other: false },
          },
        ],
      },
    ]);
    const events = await collect(runChat({ client, dispatch, userMessage: 'hi' }));
    expect(events.find((e) => e.type === 'question')).toMatchObject({ allowOther: false });
  });

  it('a malformed call is a recoverable tool_result error — the turn does NOT stop', async () => {
    const { client, calls } = scriptedClient([
      {
        text: 'Asking…',
        // Only one option — below the 2-option minimum.
        toolUses: [{ id: 'tu1', name: 'ask_user', input: { question: 'Q?', options: ['A'] } }],
      },
      { text: 'Understood, moving on.' },
    ]);
    const events = await collect(runChat({ client, dispatch, userMessage: 'hi' }));
    const types = events.map((e) => e.type);
    expect(types).not.toContain('question'); // no unanswerable card
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: true });
    expect(calls()).toBe(2); // the model got the error and continued the loop
    expect(types[types.length - 1]).toBe('done');
  });

  it('parseAskUserInput validates question + 2-4 options and defaults allow_other', () => {
    expect(parseAskUserInput({ question: ' Q? ', options: ['A', 'B'] })).toEqual({
      question: 'Q?',
      options: ['A', 'B'],
      allowOther: true,
    });
    expect(parseAskUserInput({ question: '', options: ['A', 'B'] })).toHaveProperty('error');
    expect(parseAskUserInput({ question: 'Q?', options: ['A'] })).toHaveProperty('error');
    expect(
      parseAskUserInput({ question: 'Q?', options: ['A', 'B', 'C', 'D', 'E'] }),
    ).toHaveProperty('error');
    expect(parseAskUserInput({ question: 'Q?', options: 'A,B' })).toHaveProperty('error');
  });

  it('teaches the ask-when-marginal rule in the system prompt', async () => {
    let capturedSystem = '';
    const client: LlmClient = {
      runTurn(params) {
        capturedSystem = params.system;
        return Promise.resolve({ stopReason: 'end_turn', text: 'ok', toolUses: [] });
      },
    };
    await collect(runChat({ client, dispatch, userMessage: 'hi' }));
    expect(capturedSystem).toContain('ask_user');
    expect(capturedSystem).toMatch(/below roughly 60%/);
    expect(capturedSystem).toMatch(/never about storage mechanics/i);
    expect(capturedSystem).toMatch(/persist it with set_definition/);
  });
});
