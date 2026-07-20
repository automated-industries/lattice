import { describe, it, expect, vi, afterEach } from 'vitest';
import { rephraseClarifyQuestion } from '../../src/gui/ai/summarize.js';
import type { LlmClient, TurnParams, TurnResult } from '../../src/gui/ai/chat.js';

/**
 * Data Questions are business-forward: the structural clarify prompt ("Is
 * <file> meant to add records to <entity>?") is rewritten by the model into
 * plain language ("Do you want to group all your driver's licenses together?").
 * rephraseClarifyQuestion is best-effort — on any bad/failed response it returns
 * null so the caller keeps the structural fallback and the question is never
 * dropped. These pin the parse + the fallback contract.
 */

function client(reply: string | (() => never)): LlmClient {
  return {
    runTurn(_p: TurnParams): Promise<TurnResult> {
      if (typeof reply === 'function') reply(); // throw path
      return Promise.resolve({ stopReason: 'end_turn', text: reply as string, toolUses: [] });
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('rephraseClarifyQuestion', () => {
  it('parses a fenced JSON rewrite into {question, yes, no}', async () => {
    const reply =
      'Sure:\n```json\n' +
      JSON.stringify({
        question: 'Do you want to group all your driver licenses together?',
        yes: 'Yes, group them',
        no: 'No, keep it separate',
      }) +
      '\n```';
    const out = await rephraseClarifyQuestion(client(reply), 'Driver License.pdf', 'documents');
    expect(out).toEqual({
      question: 'Do you want to group all your driver licenses together?',
      yes: 'Yes, group them',
      no: 'No, keep it separate',
    });
  });

  it('accepts a bare (unfenced) JSON object too', async () => {
    const out = await rephraseClarifyQuestion(
      client('{"question":"Group these invoices?","yes":"Yes","no":"No"}'),
      'inv-42.pdf',
      'invoices',
    );
    expect(out?.question).toBe('Group these invoices?');
  });

  it('defaults yes/no when the model omits them', async () => {
    const out = await rephraseClarifyQuestion(
      client('```json\n{"question":"Group these?"}\n```'),
      'x.pdf',
      'things',
    );
    expect(out).toEqual({ question: 'Group these?', yes: 'Yes', no: 'No' });
  });

  it('returns null on unparseable output (caller keeps the structural fallback)', async () => {
    expect(await rephraseClarifyQuestion(client('no json here at all'), 'x.pdf', 'e')).toBeNull();
    expect(await rephraseClarifyQuestion(client(''), 'x.pdf', 'e')).toBeNull();
    // A parseable object with no usable question is rejected.
    expect(await rephraseClarifyQuestion(client('{"yes":"Y","no":"N"}'), 'x.pdf', 'e')).toBeNull();
  });

  it('returns null (and logs, not silent) when the model call throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = await rephraseClarifyQuestion(
      client(() => {
        throw new Error('network down');
      }),
      'x.pdf',
      'e',
    );
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/rephrase failed/i);
  });
});
