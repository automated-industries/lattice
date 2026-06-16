import { describe, it, expect } from 'vitest';
import {
  summarizeText,
  classifyLinks,
  generateThreadTitle,
  parseMatches,
  type CatalogEntity,
} from '../../src/gui/ai/summarize.js';
import type { LlmClient, TurnResult } from '../../src/gui/ai/chat.js';

function fixedClient(text: string): LlmClient {
  return {
    runTurn(params): Promise<TurnResult> {
      for (const ch of text.split(' ')) params.onText(ch + ' ');
      return Promise.resolve({ stopReason: 'end_turn', text, toolUses: [] });
    },
  };
}

/** A client that records the system prompt + user content it was handed. */
function capturingClient(reply: string): {
  client: LlmClient;
  last: { system: string; content: string };
} {
  const last = { system: '', content: '' };
  const client: LlmClient = {
    runTurn(params): Promise<TurnResult> {
      last.system = params.system;
      const first = params.messages[0];
      last.content = typeof first?.content === 'string' ? first.content : '';
      return Promise.resolve({ stopReason: 'end_turn', text: reply, toolUses: [] });
    },
  };
  return { client, last };
}

const catalog: CatalogEntity[] = [
  {
    table: 'projects',
    description: 'Initiatives',
    records: [
      { id: 'p1', label: 'Alpha' },
      { id: 'p2', label: 'Beta' },
    ],
  },
  { table: 'people', records: [{ id: 'u1', label: 'Ada' }] },
];

describe('summarize + classify helpers', () => {
  it('summarizeText returns the model text trimmed', async () => {
    const out = await summarizeText(
      fixedClient('A short note about widgets.'),
      'note.txt',
      'widgets',
    );
    expect(out).toBe('A short note about widgets.');
  });

  it('generateThreadTitle strips surrounding quotes + trailing punctuation', async () => {
    const out = await generateThreadTitle(
      fixedClient('"Adding New Notes About Cheese."'),
      'add a note about cheese',
      'Done — created the note.',
    );
    expect(out).toBe('Adding New Notes About Cheese');
  });

  it('generateThreadTitle clamps the title to 60 chars', async () => {
    const long =
      'A Very Long Conversation Title That Far Exceeds The Sixty Character Column Budget';
    const out = await generateThreadTitle(fixedClient(long), 'hi', 'hello');
    expect(out.length).toBeLessThanOrEqual(60);
  });

  it('parseMatches reads a json fence and validates against the catalog', () => {
    const raw =
      'Here:\n```json\n[{"table":"projects","id":"p1"},{"table":"projects","id":"ghost"}]\n```';
    const matches = parseMatches(raw, catalog);
    expect(matches).toEqual([{ table: 'projects', id: 'p1' }]); // ghost id dropped
  });

  it('parseMatches tolerates a bare array and rejects unknown tables', () => {
    expect(
      parseMatches('[{"table":"people","id":"u1"},{"table":"nope","id":"x"}]', catalog),
    ).toEqual([{ table: 'people', id: 'u1' }]);
  });

  it('parseMatches returns [] on non-JSON', () => {
    expect(parseMatches('no json here', catalog)).toEqual([]);
  });

  it('classifyLinks returns only validated matches from the model output', async () => {
    const client = fixedClient('```json\n[{"table":"projects","id":"p2"}]\n```');
    const matches = await classifyLinks(client, 'a doc about Beta', 'doc.md', catalog);
    expect(matches).toEqual([{ table: 'projects', id: 'p2' }]);
  });

  it('classifyLinks short-circuits with empty catalog or empty text', async () => {
    const client = fixedClient('[]');
    expect(await classifyLinks(client, 'text', 'f', [])).toEqual([]);
    expect(await classifyLinks(client, '   ', 'f', catalog)).toEqual([]);
  });

  it('untrusted=false does NOT add injection framing (default behavior)', async () => {
    const { client, last } = capturingClient('ok');
    await summarizeText(client, 'plain doc body', 'doc.txt', undefined, false);
    expect(last.content).not.toContain('UNTRUSTED_EXTERNAL_CONTENT');
    expect(last.system).not.toMatch(/untrusted/i);
  });

  it('summarizeText with untrusted=true wraps content + hardens the system prompt', async () => {
    const { client, last } = capturingClient('ok');
    await summarizeText(client, 'malicious page text', 'page', undefined, true);
    expect(last.content).toContain('<UNTRUSTED_EXTERNAL_CONTENT>');
    expect(last.content).toContain('malicious page text');
    expect(last.system).toMatch(/untrusted/i);
    expect(last.system).toMatch(/never instructions/i);
  });

  it('classifyLinks with untrusted=true frames the document text', async () => {
    const { client, last } = capturingClient('```json\n[]\n```');
    await classifyLinks(client, 'web page text', 'page', catalog, undefined, true);
    expect(last.content).toContain('<UNTRUSTED_EXTERNAL_CONTENT>');
    expect(last.system).toMatch(/untrusted/i);
  });
});
