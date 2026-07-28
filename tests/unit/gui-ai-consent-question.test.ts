import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import type { DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { getFunction } from '../../src/gui/ai/registry.js';
import { runChat, CONSENT_TTL_MS, type LlmClient, type TurnResult } from '../../src/gui/ai/chat.js';
import type { ChatStreamEvent } from '../../src/gui/ai/sse.js';
import { CONSENT_TABLE, loadConsent } from '../../src/gui/ai/consent-store.js';
import { allAsyncOrSync } from '../../src/db/adapter.js';

/**
 * A DESTRUCTIVE `ask_user` MINTS A RECORD, AND THE SERVER WRITES THE CARD.
 *
 * The forgery this closes: consent used to be reconstructed by re-reading the
 * transcript, and the question half of that evidence was the blob of text the MODEL
 * wrote — its question plus every option, chosen and unchosen alike. So an option
 * the user never clicked could supply the destructive verb and the object name that
 * unlocked the call.
 *
 * The fix is not to sanitize that blob but to remove it: when the model names the
 * calls it intends to run, the server classifies them ITSELF (the same pre-flight
 * classifier the gate runs), writes down exactly what an affirmative answer would
 * authorize, and composes every word of the card from that. The model's question and
 * options are discarded — not shown, not stored. There is no blob left to bleed.
 *
 * A plain (non-confirm) `ask_user` must be untouched by all of this.
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

/**
 * Every channel of MODEL-authored prose an `ask_user` carries, as unique sentinels.
 *
 * Looped over rather than asserted one by one so that a field added later — a new
 * option slot, a subtitle, a "reason" the model supplies — fails this test by
 * DEFAULT instead of passing unexamined. A new channel of model text has to be
 * added here and justified before it can ship.
 */
const MODEL_AUTHORED = [
  'SENTINEL_MODEL_QUESTION_B1',
  'SENTINEL_MODEL_OPTION_YES_B2',
  'SENTINEL_MODEL_OPTION_NO_B3',
  'SENTINEL_MODEL_OPTION_UNCHOSEN_B4',
];

const SCOPE = { threadId: 'thread-1', ownerUserId: 'user-1', askedMsgId: 'msg-1' };

describe('ask_user with confirm — the server mints the record and composes the card', () => {
  let tmpDir: string;
  let db: Lattice;
  let dispatch: DispatchCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-consentq-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    db.define('people', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'people.md',
    });
    db.define('orders', {
      columns: { id: 'TEXT PRIMARY KEY', label: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'orders.md',
    });
    await db.init();
    for (let i = 0; i < 40; i++) await db.insert('people', { id: `p${String(i)}`, name: 'x' });
    for (let i = 0; i < 5; i++) await db.insert('orders', { id: `o${String(i)}`, label: 'y' });
    // A REAL config on disk. `delete_cascade` destroys in OTHER objects too, and the
    // classifier counts that collateral from the workspace's declared relations — with
    // no config there is no relation model to read, which fails CLOSED (an uncountable
    // cascade, gated at any size). The server always supplies one; so does this.
    const configPath = join(tmpDir, 'lattice.config.yml');
    const outputDir = join(tmpDir, 'context');
    writeFileSync(
      configPath,
      [
        'db: ./test.db',
        '',
        'entities:',
        '  people:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '      deleted_at: { type: text }',
        '    outputFile: people.md',
        '  orders:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      label: { type: text }',
        '      deleted_at: { type: text }',
        '    outputFile: orders.md',
        '',
      ].join('\n'),
    );
    dispatch = {
      db,
      feed: new FeedBus(),
      validTables: new Set(['people', 'orders']),
      junctionTables: new Set(),
      softDeletable: new Set(['people', 'orders']),
      configPath,
      outputDir,
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Every consent row currently in the store, raw. */
  async function consentRows(): Promise<Record<string, unknown>[]> {
    try {
      return (await allAsyncOrSync(db.adapter, `SELECT * FROM "${CONSENT_TABLE}"`, [])) as Record<
        string,
        unknown
      >[];
    } catch {
      return []; // the table is only created on first mint
    }
  }

  /** An ask_user turn whose question + options are all sentinels. */
  function askUserTurn(extra: Record<string, unknown>): {
    text: string;
    toolUses: TurnResult['toolUses'];
  } {
    return {
      text: 'One moment.',
      toolUses: [
        {
          id: 'tu1',
          name: 'ask_user',
          input: {
            question: MODEL_AUTHORED[0]!,
            options: [MODEL_AUTHORED[1], MODEL_AUTHORED[2], MODEL_AUTHORED[3]],
            ...extra,
          },
        },
      ],
    };
  }

  it('declares confirm as an optional array on the tool schema', () => {
    const fn = getFunction('ask_user');
    expect(fn?.args.properties.confirm?.type).toBe('array');
    // Optional: a plain question must never have to carry it.
    expect(fn?.args.required).toEqual(['question', 'options']);
  });

  it('emits id + consent, and the card is the SERVER’s — no model text survives', async () => {
    const { client, calls } = scriptedClient([
      askUserTurn({
        confirm: [{ tool: 'delete_entity', args: { name: 'people', resolution: 'delete_data' } }],
      }),
    ]);
    const events = await collect(
      runChat({ client, dispatch, userMessage: 'clear out people', consentScope: SCOPE }),
    );
    const q = events.find((e) => e.type === 'question');
    expect(q).toBeDefined();
    if (q?.type !== 'question') throw new Error('no question event');

    // A durable record was minted, and the event carries its handle.
    expect(typeof q.id).toBe('string');
    expect(q.id).toBeTruthy();
    const record = await loadConsent(db, q.id ?? '');
    expect(record?.status).toBe('pending');
    expect(record?.threadId).toBe(SCOPE.threadId);
    expect(record?.ownerUserId).toBe(SCOPE.ownerUserId);
    expect(record?.askedMsgId).toBe(SCOPE.askedMsgId);

    // The grant is SERVER-derived: the classifier's kind/target/count, not the
    // model's description of its own plan.
    expect(record?.grants).toHaveLength(1);
    const grant = record?.grants[0];
    expect(grant?.tool).toBe('delete_entity');
    expect(grant?.kind).toBe('remove_object');
    expect(grant?.target).toBe('people');
    expect(grant?.verbKey).toBe('resolution:delete_data');
    expect(grant?.maxRows).toBe(40);
    expect(grant?.rowsUnknown).toBe(false);

    // Exactly TWO options, both server-composed, with a server-chosen affirm index
    // and no free-form box — there is no unchosen option blob to bleed from.
    expect(q.options).toHaveLength(2);
    expect(q.allowOther).toBe(false);
    expect(q.consent?.affirmIndex).toBe(record?.affirmIndex);
    expect(record?.optionCount).toBe(2);
    expect(q.consent?.lines).toEqual([grant?.detail]);
    expect(q.consent?.headline).toBe(q.question); // a consent-blind client still sees the server's words
    expect(q.consent?.headline).toContain('40'); // the bounded count is on the card

    // THE SHAPE TEST: no channel of model-authored text reaches the event or the row.
    const eventJson = JSON.stringify(q);
    const rowJson = JSON.stringify(await consentRows());
    for (const sentinel of MODEL_AUTHORED) {
      expect(eventJson).not.toContain(sentinel);
      expect(rowJson).not.toContain(sentinel);
    }

    // The turn STOPPED on the question, as a plain ask_user does.
    expect(calls()).toBe(1);
    expect(events[events.length - 1]?.type).toBe('done');
  });

  it('mints one grant per confirmed call and totals the row count on the headline', async () => {
    const { client } = scriptedClient([
      askUserTurn({
        confirm: [
          { tool: 'delete_entity', args: { name: 'people', resolution: 'delete_cascade' } },
          { tool: 'delete_entity', args: { name: 'orders', resolution: 'delete_data' } },
        ],
      }),
    ]);
    const events = await collect(
      runChat({ client, dispatch, userMessage: 'remove both', consentScope: SCOPE }),
    );
    const q = events.find((e) => e.type === 'question');
    if (q?.type !== 'question') throw new Error('no question event');
    const record = await loadConsent(db, q.id ?? '');
    expect(record?.grants.map((g) => g.target)).toEqual(['people', 'orders']);
    expect(record?.grants.map((g) => g.verbKey)).toEqual([
      'resolution:delete_cascade',
      'resolution:delete_data',
    ]);
    expect(q.consent?.lines).toHaveLength(2);
    expect(q.consent?.headline).toContain('45'); // 40 + 5, totalled server-side
  });

  it('chooses a TTL that covers the whole answer-then-execute window', () => {
    // Long enough for a real person to be interrupted and come back; short enough
    // that a card abandoned in a tab is not still live the next day. The record is
    // also swept by expirePendingForThread on the next send, so this is a backstop.
    expect(CONSENT_TTL_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
    expect(CONSENT_TTL_MS).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
  });

  it('a plain ask_user is byte-identical to before and mints nothing', async () => {
    const { client } = scriptedClient([
      {
        text: 'Checking.',
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
    const events = await collect(
      runChat({ client, dispatch, userMessage: 'organize this', consentScope: SCOPE }),
    );
    // Exactly the pre-existing event shape: no id, no consent, no extra keys.
    expect(events.find((e) => e.type === 'question')).toEqual({
      type: 'question',
      question: 'Is this list meant to track suppliers?',
      options: ['Yes, suppliers', 'No, customers'],
      allowOther: true,
    });
    expect(await consentRows()).toEqual([]);
  });

  it('refuses a confirm naming a table that is not a real object, and mints nothing', async () => {
    const { client, calls } = scriptedClient([
      askUserTurn({
        confirm: [{ tool: 'delete_entity', args: { name: 'ghosts', resolution: 'delete_data' } }],
      }),
      { text: 'Understood.' },
    ]);
    const events = await collect(
      runChat({ client, dispatch, userMessage: 'remove ghosts', consentScope: SCOPE }),
    );
    // Recoverable: an error tool_result, no card, the turn continues.
    expect(events.some((e) => e.type === 'question')).toBe(false);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: true });
    expect(calls()).toBe(2);
    expect(await consentRows()).toEqual([]);
  });

  it('refuses a confirm naming a tool that destroys nothing', async () => {
    const { client } = scriptedClient([
      askUserTurn({ confirm: [{ tool: 'create_row', args: { table: 'people', values: {} } }] }),
      { text: 'Understood.' },
    ]);
    const events = await collect(
      runChat({ client, dispatch, userMessage: 'go', consentScope: SCOPE }),
    );
    expect(events.some((e) => e.type === 'question')).toBe(false);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: true });
    expect(await consentRows()).toEqual([]);
  });

  it('refuses a confirm whose call, as written, destroys nothing', async () => {
    const { client } = scriptedClient([
      // No resolution + rows present ⇒ the classifier says this call only reports
      // what is in the way. Nothing to confirm, so nothing is minted.
      askUserTurn({ confirm: [{ tool: 'delete_entity', args: { name: 'people' } }] }),
      { text: 'Understood.' },
    ]);
    const events = await collect(
      runChat({ client, dispatch, userMessage: 'go', consentScope: SCOPE }),
    );
    expect(events.some((e) => e.type === 'question')).toBe(false);
    expect(await consentRows()).toEqual([]);
  });

  it('refuses a SECOND confirm in the same turn — one open confirmation at a time', async () => {
    const { client } = scriptedClient([
      {
        text: 'Both, then.',
        toolUses: [
          {
            id: 'tu1',
            name: 'ask_user',
            input: {
              question: 'Q1?',
              options: ['a', 'b'],
              confirm: [
                { tool: 'delete_entity', args: { name: 'people', resolution: 'delete_data' } },
              ],
            },
          },
          {
            id: 'tu2',
            name: 'ask_user',
            input: {
              question: 'Q2?',
              options: ['a', 'b'],
              confirm: [
                { tool: 'delete_entity', args: { name: 'orders', resolution: 'delete_data' } },
              ],
            },
          },
        ],
      },
    ]);
    const events = await collect(
      runChat({ client, dispatch, userMessage: 'remove both', consentScope: SCOPE }),
    );
    // Exactly one card, exactly one record.
    expect(events.filter((e) => e.type === 'question')).toHaveLength(1);
    expect(await consentRows()).toHaveLength(1);
    // The second call came back as a recoverable error, not a silent drop.
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.map((r) => (r.type === 'tool_result' ? r.isError : null))).toEqual([
      false,
      true,
    ]);
  });

  it('refuses a confirm when there is no thread to scope the record to', async () => {
    const { client } = scriptedClient([
      askUserTurn({
        confirm: [{ tool: 'delete_entity', args: { name: 'people', resolution: 'delete_data' } }],
      }),
      { text: 'Understood.' },
    ]);
    // No consentScope: an unscoped record is a bearer token anyone could spend.
    const events = await collect(runChat({ client, dispatch, userMessage: 'go' }));
    expect(events.some((e) => e.type === 'question')).toBe(false);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: true });
    expect(await consentRows()).toEqual([]);
  });

  it('refuses a malformed confirm shape without minting', async () => {
    for (const confirm of [[], 'delete everything', [{ tool: 'delete_entity' }], [{ args: {} }]]) {
      const { client } = scriptedClient([askUserTurn({ confirm }), { text: 'ok' }]);
      const events = await collect(
        runChat({ client, dispatch, userMessage: 'go', consentScope: SCOPE }),
      );
      expect(events.some((e) => e.type === 'question')).toBe(false);
      expect(await consentRows()).toEqual([]);
    }
  });
});
