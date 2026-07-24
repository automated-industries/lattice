import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FeedBus } from '../../src/gui/feed.js';
import type { Lattice } from '../../src/lattice.js';
import type { LlmClient, TurnParams, TurnResult } from '../../src/gui/ai/chat.js';

/**
 * The chat assistant ingests REFERENCE MATERIAL from a message by CONTENT TYPE — facts,
 * notes, a pasted document, a link — routing it through the SAME engine a dropped file
 * uses, deterministically (the classifier always runs; the finding-and-linking is the
 * engine's, not the chat model's tool choice). A message may be mixed: only the
 * reference portion is ingested, the directive/question is left for the assistant. Not
 * size-gated.
 */

const scripted = vi.hoisted(() => ({ triageJson: '```json\n{"reference":""}\n```' }));
const ingestTextSpy = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ id: 'f-text', suggestedLinks: [] })),
);
const ingestUrlSpy = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ id: 'f-url', suggestedLinks: [] })),
);

vi.mock('../../src/gui/ingest-routes.js', async (orig) => {
  const actual = await orig<typeof import('../../src/gui/ingest-routes.js')>();
  return { ...actual, ingestTextAsFile: ingestTextSpy };
});
vi.mock('../../src/gui/ingest-url.js', async (orig) => {
  const actual = await orig<typeof import('../../src/gui/ingest-url.js')>();
  return { ...actual, ingestUrlAsFile: ingestUrlSpy };
});

import {
  extractUserUrls,
  ingestReferenceMaterial,
  userAuthoredCorpus,
} from '../../src/gui/chat-routes.js';
import { triageReferenceMaterial } from '../../src/gui/ai/summarize.js';

/** A client whose triage turn returns whatever `scripted.triageJson` holds. */
const fakeClient = (): LlmClient =>
  ({
    runTurn(_p: TurnParams): Promise<TurnResult> {
      return Promise.resolve({ stopReason: 'end_turn', text: scripted.triageJson, toolUses: [] });
    },
  }) as unknown as LlmClient;

const deps = () => ({
  db: {} as unknown as Lattice,
  feed: new FeedBus(),
  softDeletable: new Set<string>(),
});

const ref = (s: string) => '```json\n' + JSON.stringify({ reference: s }) + '\n```';

describe('chat auto-ingest of reference material (by type, not size)', () => {
  beforeEach(() => {
    scripted.triageJson = ref('');
    ingestTextSpy.mockClear();
    ingestUrlSpy.mockClear();
    delete process.env.LATTICE_CHAT_AUTOINGEST;
  });

  it('routes a pasted reference block through the text engine and returns a note', async () => {
    const msg = 'Weekly sync with Ada Lovelace on Tuesday. What should I prep?';
    scripted.triageJson = ref('Weekly sync with Ada Lovelace on Tuesday.');
    const note = await ingestReferenceMaterial(fakeClient(), msg, deps(), 0.5);
    expect(ingestTextSpy).toHaveBeenCalledTimes(1);
    // The engine gets EXACTLY the reference span — not the directive ("What should I prep?").
    expect(ingestTextSpy.mock.calls[0]?.[1]).toBe('Weekly sync with Ada Lovelace on Tuesday.');
    expect(ingestUrlSpy).not.toHaveBeenCalled();
    expect(note.length).toBeGreaterThan(0);
  });

  it('does NOT ingest a pure directive/question (empty reference → no engine call)', async () => {
    scripted.triageJson = ref('');
    const note = await ingestReferenceMaterial(
      fakeClient(),
      'What meetings do I have next week?',
      deps(),
      0.5,
    );
    expect(ingestTextSpy).not.toHaveBeenCalled();
    expect(ingestUrlSpy).not.toHaveBeenCalled();
    expect(note).toBe('');
  });

  it('routes a bare URL to the URL-crawl engine, not the text engine', async () => {
    const url = 'https://example.com/post';
    scripted.triageJson = ref(url);
    const note = await ingestReferenceMaterial(fakeClient(), `save this: ${url}`, deps(), 0.5);
    expect(ingestUrlSpy).toHaveBeenCalledTimes(1);
    expect(ingestUrlSpy.mock.calls[0]?.[1]).toBe(url);
    expect(ingestTextSpy).not.toHaveBeenCalled();
    expect(note.length).toBeGreaterThan(0);
  });

  it('never blocks the chat: an ingest-engine failure is swallowed to an empty note', async () => {
    scripted.triageJson = ref('Acme signed the renewal Tuesday.');
    ingestTextSpy.mockRejectedValueOnce(new Error('boom'));
    const note = await ingestReferenceMaterial(
      fakeClient(),
      'Acme signed the renewal Tuesday.',
      deps(),
      0.5,
    );
    // Pin the path: the empty note came from the ENGINE-rejection catch (the engine was
    // reached and threw), not an earlier short-circuit (off-switch / empty reference).
    expect(ingestTextSpy).toHaveBeenCalledTimes(1);
    expect(note).toBe('');
  });

  it('respects the LATTICE_CHAT_AUTOINGEST=false off-switch (no triage, no ingest)', async () => {
    process.env.LATTICE_CHAT_AUTOINGEST = 'false';
    scripted.triageJson = ref('Acme signed Tuesday.');
    const note = await ingestReferenceMaterial(fakeClient(), 'Acme signed Tuesday.', deps(), 0.5);
    expect(ingestTextSpy).not.toHaveBeenCalled();
    expect(note).toBe('');
  });
});

describe('triageReferenceMaterial — verbatim classifier', () => {
  beforeEach(() => {
    scripted.triageJson = ref('');
  });

  it('lifts the reference-material span verbatim, leaving the directive behind', async () => {
    scripted.triageJson = ref('Acme signed the renewal Tuesday.');
    const out = await triageReferenceMaterial(
      fakeClient(),
      'Acme signed the renewal Tuesday. Draft a thank-you email.',
    );
    expect(out.reference).toBe('Acme signed the renewal Tuesday.');
  });

  it('drops a paraphrase the model did not copy verbatim (never saves invented words)', async () => {
    scripted.triageJson = ref('A completely different summary.');
    const out = await triageReferenceMaterial(fakeClient(), 'Met with the team about Q3.');
    expect(out.reference).toBe('');
  });

  it('returns empty for a pure question', async () => {
    scripted.triageJson = ref('');
    const out = await triageReferenceMaterial(fakeClient(), 'What is on my calendar?');
    expect(out.reference).toBe('');
  });

  it('accepts a span differing from the message only by collapsed whitespace', async () => {
    // The classifier copied the reference but normalized internal whitespace; the guard's
    // whitespace-tolerant fallback must ACCEPT it, not drop a legitimately-pasted span.
    scripted.triageJson = ref('Weekly sync with Ada Lovelace on Tuesday.');
    const out = await triageReferenceMaterial(
      fakeClient(),
      'Weekly   sync   with Ada Lovelace\n\non Tuesday.',
    );
    expect(out.reference).toBe('Weekly sync with Ada Lovelace on Tuesday.');
  });
});

describe('deterministic link ingestion — a shared URL is ALWAYS fetched', () => {
  beforeEach(() => {
    scripted.triageJson = ref('');
    ingestTextSpy.mockClear();
    ingestUrlSpy.mockClear();
    delete process.env.LATTICE_CHAT_AUTOINGEST;
  });

  it('fetches a pasted link even when the triage model returns nothing', async () => {
    // The regression: link detection used to ride the LLM triage, which flaked a
    // bare link-share into a clarifying question. Detection is now mechanical.
    const url =
      'https://example.com/building/236_240-west-64-street/2e?from_map=1&utm_campaign=rental_listing&utm_medium=share';
    scripted.triageJson = ref(''); // triage sees nothing — the URL must still fetch
    const note = await ingestReferenceMaterial(fakeClient(), url, deps(), 0.5);
    expect(ingestUrlSpy).toHaveBeenCalledTimes(1);
    expect(ingestUrlSpy.mock.calls[0]?.[1]).toBe(url);
    expect(ingestTextSpy).not.toHaveBeenCalled();
    expect(note).toContain('already been fetched');
    expect(note).toContain('do NOT ask the user for details');
  });

  it('fetches the link out of a mixed message and leaves the directive to the model', async () => {
    const url = 'https://example.com/listing/42';
    const note = await ingestReferenceMaterial(
      fakeClient(),
      `im posting listings i need you to start saving them ${url}`,
      deps(),
      0.5,
    );
    expect(ingestUrlSpy).toHaveBeenCalledTimes(1);
    expect(ingestUrlSpy.mock.calls[0]?.[1]).toBe(url);
    expect(note).toContain('already been fetched');
  });

  it('a failed fetch is surfaced in the note — never silent, never a guess', async () => {
    const url = 'https://example.com/paywalled';
    ingestUrlSpy.mockRejectedValueOnce(new Error('403'));
    const note = await ingestReferenceMaterial(fakeClient(), url, deps(), 0.5);
    expect(note).toContain('could not be fetched');
    expect(note).toContain(url);
  });

  it('dedupes repeated links and trims trailing punctuation', async () => {
    const url = 'https://example.com/a';
    await ingestReferenceMaterial(fakeClient(), `look at ${url}, then ${url}.`, deps(), 0.5);
    expect(ingestUrlSpy).toHaveBeenCalledTimes(1);
    expect(ingestUrlSpy.mock.calls[0]?.[1]).toBe(url);
  });
});

describe('extractUserUrls — mechanical link detection', () => {
  it('extracts scheme-prefixed URLs with query strings, trimming sentence punctuation', () => {
    const urls = extractUserUrls('see https://example.com/x?a=1&b=2, and (https://example.com/y).');
    expect(urls).toEqual(['https://example.com/x?a=1&b=2', 'https://example.com/y']);
  });

  it('returns [] for plain text and skips unparseable candidates', () => {
    expect(extractUserUrls('no links here')).toEqual([]);
  });
});

describe('userAuthoredCorpus — the whole-conversation URL gate input', () => {
  it('includes prior user turns so an earlier link stays fetchable', () => {
    const corpus = userAuthoredCorpus('add this listing too', [
      { role: 'user', content: 'save https://example.com/listing/1' },
      { role: 'assistant', content: 'Saved.' },
    ]);
    expect(corpus).toContain('https://example.com/listing/1');
    expect(corpus).toContain('add this listing too');
    expect(corpus).not.toContain('Saved.');
  });

  it('excludes tool_result blocks — file/row content can never smuggle a URL in', () => {
    const corpus = userAuthoredCorpus('hi', [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'https://attacker.example/evil' },
          { type: 'text', text: 'my own words https://example.com/mine' },
        ] as never,
      },
    ]);
    expect(corpus).toContain('https://example.com/mine');
    expect(corpus).not.toContain('attacker.example');
  });
});
