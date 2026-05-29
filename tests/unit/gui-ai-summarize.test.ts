import { describe, it, expect } from 'vitest';
import {
  summarizeText,
  classifyLinks,
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
});
