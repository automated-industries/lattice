import { describe, it, expect } from 'vitest';
import { parseIntent, runIntent } from '../../src/gui/ai/intent.js';
import type { LlmClient, TurnParams, TurnResult } from '../../src/gui/ai/chat.js';

/**
 * The fast intent pass classifies a chat message into one of three handlings — run the
 * tool loop (needs_work), answer inline (trivial/general), or ask a clarifying question
 * (needs_more_info) — and always degrades to the SAFE path (run the loop) on any bad
 * output, so a malformed classification never drops or mis-answers the user's message.
 */
describe('parseIntent', () => {
  it('parses a needs_work classification (contextual ack, run the loop)', () => {
    const r = parseIntent(
      '```json\n{"intent_summary":"pull invoices","ack_message":"Got it — pulling your invoices…","needs_work":true,"needs_more_info":false}\n```',
      'show me my Q3 invoices',
    );
    expect(r.needs_work).toBe(true);
    expect(r.needs_more_info).toBe(false);
    expect(r.ack_message).toBe('Got it — pulling your invoices…');
  });

  it('parses a trivial/general inline answer (needs_work false)', () => {
    const r = parseIntent(
      '```json\n{"intent_summary":"greeting","ack_message":"Hi! I can help you explore and organize your data.","needs_work":false,"needs_more_info":false}\n```',
      'hey there',
    );
    expect(r.needs_work).toBe(false);
    expect(r.needs_more_info).toBe(false);
    expect(r.ack_message).toContain('Hi!');
  });

  it('parses a clarifying question (needs_more_info) and forces needs_work true', () => {
    const r = parseIntent(
      '```json\n{"intent_summary":"ambiguous","ack_message":"Which project did you mean?","needs_work":false,"needs_more_info":true}\n```',
      'update it',
    );
    expect(r.needs_more_info).toBe(true);
    // needs_more_info wins regardless of the model's needs_work value.
    expect(r.needs_work).toBe(true);
    expect(r.ack_message).toBe('Which project did you mean?');
  });

  it('accepts bare (unfenced) JSON', () => {
    const r = parseIntent(
      '{"ack_message":"On it…","needs_work":true,"needs_more_info":false}',
      'do the thing',
    );
    expect(r.needs_work).toBe(true);
    expect(r.ack_message).toBe('On it…');
  });

  it('defaults needs_work to TRUE when the field is omitted (safe path)', () => {
    const r = parseIntent('```json\n{"ack_message":"On it…"}\n```', 'do the thing');
    expect(r.needs_work).toBe(true);
  });

  it('falls back to the loop on malformed JSON', () => {
    const r = parseIntent('not json at all', 'do the thing');
    expect(r.needs_work).toBe(true);
    expect(r.needs_more_info).toBe(false);
    expect(r.ack_message).toBe('Working on it…');
  });

  it('falls back to the loop when the ack is empty', () => {
    const r = parseIntent('```json\n{"ack_message":"","needs_work":false}\n```', 'do the thing');
    expect(r.needs_work).toBe(true);
    expect(r.ack_message).toBe('Working on it…');
  });
});

describe('runIntent', () => {
  function fakeClient(text: string): { client: LlmClient; calls: TurnParams[] } {
    const calls: TurnParams[] = [];
    const client: LlmClient = {
      runTurn(params: TurnParams): Promise<TurnResult> {
        calls.push(params);
        return Promise.resolve({ stopReason: 'end_turn', text, toolUses: [] });
      },
    };
    return { client, calls };
  }

  it('runs one cheap, bounded, tool-less call and returns the parsed intent', async () => {
    const { client, calls } = fakeClient(
      '```json\n{"ack_message":"Checking your open projects…","needs_work":true,"needs_more_info":false}\n```',
    );
    const r = await runIntent(client, 'which projects are open?', {
      operatorName: 'Ada',
      tableNames: ['projects', 'tickets'],
    });
    expect(r.needs_work).toBe(true);
    expect(r.ack_message).toBe('Checking your open projects…');
    // One structured call, no tools, a small output budget, and the grounding is present.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tools).toEqual([]);
    expect(calls[0]!.maxTokens).toBeGreaterThan(0);
    const sent = JSON.stringify(calls[0]!.messages);
    expect(sent).toContain('Ada');
    expect(sent).toContain('projects');
  });

  it('grounds the classifier in what the user is viewing so a complaint is actionable, not ambiguous', async () => {
    const { client, calls } = fakeClient(
      '```json\n{"ack_message":"Checking what went wrong…","needs_work":true,"needs_more_info":false}\n```',
    );
    const r = await runIntent(client, 'why is this broken?', {
      activeView: 'the dashboard "Books Sold by Month"',
    });
    const sent = JSON.stringify(calls[0]!.messages);
    // The view grounding reaches the prompt so "this" is understood + a complaint is
    // steered to needs_work (investigate) rather than needs_more_info (ask what's wrong).
    expect(sent).toContain('the dashboard \\"Books Sold by Month\\"');
    expect(sent.toLowerCase()).toContain('not ambiguous');
    expect(r.needs_work).toBe(true);
  });

  it('passes recent conversation so a bare "yes" is resolved in context, not judged in a vacuum', async () => {
    // Regression: a context-dependent reply ("yes" answering the assistant's offer to
    // create a record) was classified with NO history, so the intent pass saw a standalone
    // "yes", flagged it needs_more_info, and short-circuited the turn with a fresh greeting
    // ("Hi! …what would you like me to do?") instead of continuing.
    const { client, calls } = fakeClient(
      '```json\n{"ack_message":"On it — creating that record…","needs_work":true,"needs_more_info":false}\n```',
    );
    const recentContext =
      'User: why are there only 2 people listed\n' +
      'Assistant: Jordan Lee is missing. Would you like me to create a person record for Jordan Lee?';
    const r = await runIntent(client, 'yes', {
      operatorName: 'Ada',
      tableNames: ['people'],
      recentContext,
    });
    const sent = JSON.stringify(calls[0]!.messages);
    // The prior turn reaches the prompt, and the classifier is told a short continuation
    // reply is NOT ambiguous and should route to the real work.
    expect(sent).toContain('create a person record for Jordan Lee');
    expect(sent.toLowerCase()).toContain('continuation');
    expect(r.needs_work).toBe(true);
  });

  it('omits the recent-conversation block entirely when there is no history (first turn)', async () => {
    const { client, calls } = fakeClient(
      '```json\n{"ack_message":"Hi! How can I help?","needs_work":false,"needs_more_info":false}\n```',
    );
    await runIntent(client, 'hey there', { operatorName: 'Ada' });
    const sent = JSON.stringify(calls[0]!.messages);
    expect(sent.toLowerCase()).not.toContain('recent conversation');
  });
});
