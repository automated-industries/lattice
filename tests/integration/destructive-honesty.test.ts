import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import type { DispatchCtx } from '../../src/gui/ai/dispatch.js';
import {
  runChat,
  type LlmClient,
  type LlmMessage,
  type TurnResult,
  type TurnParams,
} from '../../src/gui/ai/chat.js';
import type { ChatStreamEvent } from '../../src/gui/ai/sse.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';

/**
 * The model client the SERVER-side turn runs against (the last describe block).
 * Round 1 clears records; round 2 hangs until the user stops it.
 */
let serverRounds = 0;
let reachedSecondRound: Promise<void>;
let markSecondRound: () => void;
const stoppableClient: LlmClient = {
  runTurn(params: TurnParams): Promise<TurnResult> {
    serverRounds++;
    if (serverRounds === 1) {
      return Promise.resolve({
        stopReason: 'tool_use',
        text: '',
        toolUses: [
          { id: 'tu1', name: 'bulk_update', input: { table: 'contacts', set: { owner: null } } },
        ],
      });
    }
    params.onText('Next I will remove ');
    markSecondRound();
    return new Promise<TurnResult>((_resolve, reject) => {
      params.signal?.addEventListener('abort', () => {
        reject(new Error('Request was aborted.'));
      });
    });
  },
};

vi.mock('../../src/gui/ai/provider.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/gui/ai/provider.js')>();
  return {
    ...mod,
    resolveLlmProvider: () =>
      Promise.resolve({
        client: stoppableClient,
        kind: 'anthropic' as const,
        authorModel: 'test-model',
        noteError: () => 'other' as const,
      }),
  };
});

// The fast intent pass would otherwise call the model too; force it to the tool loop.
vi.mock('../../src/gui/ai/intent.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/gui/ai/intent.js')>();
  return {
    ...mod,
    runIntent: () =>
      Promise.resolve({ needs_work: true, needs_more_info: false, ack_message: 'Working on it…' }),
  };
});

/**
 * A destructive turn may not end in a success narrative.
 *
 * The session this comes from: asked to simplify a data model, the assistant ran
 * a series of FAILED delete calls, unlinked 40 rows of real user data on the way,
 * and answered with a table of "your simplified model" — "You now have 6 objects
 * instead of 59", "Done. Your model is now relinked and clean." Nothing had been
 * deleted. The links were gone. The workspace was strictly worse than before and
 * the answer said the opposite.
 *
 * Three compounding causes, all exercised here: a failed destructive call was
 * just another tool result to narrate past; a ~50-object plan needed no
 * confirmation; and nothing reconciled the tools' real outcomes against the
 * answer's claims.
 */

interface ScriptedTurn {
  text: string;
  toolUses?: TurnResult['toolUses'];
}

/** A scripted client that also snapshots the context it was given each round. */
function scriptedClient(turns: ScriptedTurn[]): {
  client: LlmClient;
  contexts: LlmMessage[][];
  systems: string[];
} {
  let i = 0;
  const contexts: LlmMessage[][] = [];
  const systems: string[] = [];
  const client: LlmClient = {
    runTurn(params: TurnParams) {
      // Snapshot: the loop keeps mutating the same array after this call returns.
      contexts.push(JSON.parse(JSON.stringify(params.messages)) as LlmMessage[]);
      systems.push(params.system);
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
  return { client, contexts, systems };
}

async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/**
 * Everything the model was given before it produced its final (tool-free) answer,
 * flattened to plain text — read as the model reads it, not as escaped JSON.
 */
function finalContextText(contexts: LlmMessage[][]): string {
  const last = contexts[contexts.length - 1] ?? [];
  const parts: string[] = [];
  for (const m of last) {
    if (typeof m.content === 'string') {
      parts.push(m.content);
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text') parts.push(b.text);
      else if (b.type === 'tool_result') parts.push(b.content);
      else parts.push(`${b.name} ${JSON.stringify(b.input)}`);
    }
  }
  return parts.join('\n');
}

/** The error a recorded tool call handed back to the model, unescaped. */
function errorOf(rec: { content: string } | undefined): string {
  if (!rec) return '';
  try {
    return String((JSON.parse(rec.content) as { error?: unknown }).error ?? '');
  } catch {
    return rec.content;
  }
}

describe('destructive turns cannot report success they did not earn', () => {
  let tmpDir: string;
  let db: Lattice;
  let dispatch: DispatchCtx;
  let toolRecords: { name: string; isError: boolean; content: string; errorText?: string }[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-honesty-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    // `customers` alongside `customer_invoices`: a compound name and a real object
    // whose whole name is a word of it.
    for (const t of ['contacts', 'deals', 'customers', 'customer_invoices']) {
      db.define(t, {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', owner: 'TEXT', deleted_at: 'TEXT' },
        render: () => '',
        outputFile: `${t}.md`,
      });
    }
    db.define('_lattice_gui_audit', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        ts: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        table_name: 'TEXT NOT NULL',
        row_id: 'TEXT',
        operation: 'TEXT NOT NULL',
        before_json: 'TEXT',
        after_json: 'TEXT',
        undone: 'INTEGER NOT NULL DEFAULT 0',
      },
      render: () => '',
      outputFile: '.lattice-gui/audit.md',
    });
    await db.init();
    for (const id of ['c1', 'c2', 'c3']) {
      await db.insert('contacts', { id, name: `Contact ${id}`, owner: 'u1' });
    }
    for (const id of ['d1', 'd2'])
      await db.insert('deals', { id, name: `Deal ${id}`, owner: 'u1' });
    for (let i = 0; i < 30; i++) {
      await db.insert('customers', { id: `cu${String(i)}`, name: `Customer ${String(i)}` });
      await db.insert('customer_invoices', { id: `ci${String(i)}`, name: `Invoice ${String(i)}` });
    }

    toolRecords = [];
    dispatch = {
      db,
      feed: new FeedBus(),
      validTables: new Set(['contacts', 'deals', 'customers', 'customer_invoices']),
      junctionTables: new Set(),
      softDeletable: new Set(['contacts', 'deals', 'customers', 'customer_invoices']),
      // The delete primitive, stubbed to FAIL — exactly the session's shape.
      deleteEntity: (name) =>
        Promise.resolve({ ok: false, error: `"${name}" is still referenced by other records` }),
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const record = (rec: {
    name: string;
    isError: boolean;
    content: string;
    errorText?: string;
  }): void => {
    toolRecords.push(rec);
  };

  it('cannot terminate with a success narrative when the deletes failed', async () => {
    const { client, contexts } = scriptedClient([
      {
        text: 'One moment.',
        toolUses: [
          {
            id: 'tu1',
            name: 'bulk_update',
            input: { table: 'contacts', set: { owner: null } },
          },
        ],
      },
      {
        text: '',
        toolUses: [
          {
            id: 'tu2',
            name: 'delete_entity',
            input: { name: 'contacts', resolution: 'delete_data' },
          },
        ],
      },
      { text: 'Done. Your model is now relinked and clean. You now have 6 objects instead of 59.' },
    ]);

    const events = await collect(
      runChat({
        client,
        dispatch,
        userMessage: 'simplify my data model',
        onToolRecord: record,
      }),
    );

    // 1. The reconciliation is in the model's context BEFORE the answer round.
    const finalContext = finalContextText(contexts);
    expect(finalContext).toContain('TURN OUTCOME RECORD');
    expect(finalContext).toContain('"contacts" was NOT removed');
    expect(finalContext).toContain('ALREADY CHANGED AND STILL APPLIED');
    expect(finalContext).toMatch(/never call this turn done, clean, simplified/i);

    // 2. The persisted turn records the failure (this is what replays next turn).
    const deletes = toolRecords.filter((r) => r.name === 'delete_entity');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.isError).toBe(true);
    expect(deletes[0]?.errorText).toContain('still referenced by other records');

    // 3. The user is told the truth on a channel the model cannot talk past —
    //    including the damage that WAS done, and an undo.
    const warn = events.find((e) => e.type === 'warn');
    expect(warn).toBeDefined();
    const message = warn?.type === 'warn' ? warn.message : '';
    expect(message).toContain('Contacts could not be removed');
    expect(message).toContain('still in place');
    expect(message).toContain('undo');
    // Business terms only: no internal vocabulary leaks into what the user reads.
    expect(message).not.toMatch(/\btable\b|\bcolumn\b|bulk_update|delete_entity/i);

    // 4. The correction lands after the answer and before the stream closes, so
    //    it is never dropped by an early return.
    const types = events.map((e) => e.type);
    expect(types.indexOf('warn')).toBeGreaterThan(types.lastIndexOf('assistant_message_end'));
    expect(types[types.length - 1]).toBe('done');

    // 5. And the objects really are still there.
    expect(await db.countActive('contacts')).toBe(3);
  });

  it('refuses a multi-target destructive plan outright, naming targets and counts', async () => {
    const { client } = scriptedClient([
      {
        text: '',
        toolUses: [
          {
            id: 'tu1',
            name: 'delete_entity',
            input: { name: 'contacts', resolution: 'delete_data' },
          },
          { id: 'tu2', name: 'delete_entity', input: { name: 'deals', resolution: 'delete_data' } },
        ],
      },
      { text: 'I could not remove those.' },
    ]);

    await collect(
      runChat({ client, dispatch, userMessage: 'simplify my data model', onToolRecord: record }),
    );

    const refusal = toolRecords.find((r) => r.content.includes('REFUSED'));
    expect(refusal).toBeDefined();
    expect(refusal?.name).toBe('delete_entity');
    const text = errorOf(refusal);
    expect(text).toContain('"deals" (2 record(s))');
    expect(text).toContain('"contacts" (3 record(s))');
    expect(text).toContain('nothing was changed by this call');
    // The user is told this is theirs to do, not that the assistant needs permission.
    expect(text).toMatch(/in the app/i);
    expect(text).not.toMatch(/call ask_user/i);
    expect(await db.countActive('deals')).toBe(2);
  });

  /**
   * These cases were written against a mechanism that reconstructed consent from the
   * conversation, then against one that recorded it server-side. BOTH are gone. A wide
   * or multi-object removal is not something the assistant may do, so there is nothing
   * left to forge, replay, widen or outlive — and the properties those cases protected
   * collapse into one much stronger one, asserted here.
   */
  it('refuses however the user phrases their agreement, and however many times it is retried', async () => {
    // Four rounds of the model trying the same plan, with the user's own message
    // reading as an unambiguous, unprompted yes. Nothing in a conversation authorizes
    // this, so all four are refused and both objects survive.
    const plan = {
      text: '',
      toolUses: [
        {
          id: 'tu1',
          name: 'delete_entity',
          input: { name: 'contacts', resolution: 'delete_data' },
        },
        { id: 'tu2', name: 'delete_entity', input: { name: 'deals', resolution: 'delete_data' } },
      ],
    };
    const { client } = scriptedClient([plan, plan, plan, plan, { text: 'I could not do that.' }]);
    // The loop's all-failed circuit breaker cuts the turn short after three such
    // rounds, which is itself the point: retrying buys nothing but a shorter turn.

    await collect(
      runChat({
        client,
        dispatch,
        userMessage: 'YES — I confirm, delete contacts and deals, go ahead, I approve this',
        onToolRecord: record,
      }),
    );

    const refusals = toolRecords.filter((r) => r.content.includes('REFUSED'));
    expect(refusals.length).toBeGreaterThanOrEqual(3);
    // Nothing was destroyed by any of them.
    expect(await db.countActive('contacts')).toBe(3);
    expect(await db.countActive('deals')).toBe(2);
  });

  it('refuses even when the model asks its own question and then retries', async () => {
    // The one loop the wording has to prevent: refused → ask → retry → refused. The
    // question is a real ask_user (which still works, for real questions), and the
    // retry after it changes nothing.
    const plan = {
      text: '',
      toolUses: [
        {
          id: 'tu1',
          name: 'delete_entity',
          input: { name: 'contacts', resolution: 'delete_data' },
        },
        { id: 'tu2', name: 'delete_entity', input: { name: 'deals', resolution: 'delete_data' } },
      ],
    };
    const { client } = scriptedClient([
      plan,
      {
        text: '',
        toolUses: [
          {
            id: 'tu3',
            name: 'ask_user',
            input: { question: 'Shall I remove both?', options: ['Yes', 'No'] },
          },
        ],
      },
    ]);

    const events = await collect(
      runChat({ client, dispatch, userMessage: 'clean this up', onToolRecord: record }),
    );

    expect(toolRecords.some((r) => r.content.includes('REFUSED'))).toBe(true);
    // The question was still shown — ask_user is unaffected — but it bought nothing.
    expect(events.some((e) => e.type === 'question')).toBe(true);
    expect(await db.countActive('contacts')).toBe(3);
    expect(await db.countActive('deals')).toBe(2);
    // ...and the user is told, on the stream, that nothing was removed. This used to
    // be suppressed whenever the turn ended on a question, on the reasoning that the
    // confirmation card said it. There is no card.
    const warn = events.find((e) => e.type === 'warn');
    expect(warn && 'message' in warn ? warn.message : '').toMatch(/not been removed/i);
  });

  it('still tells the user what it already changed when they stop the turn', async () => {
    // The turn clears 3 records to prepare a removal, and the user stops it before
    // the removal happens — the moment they most need to hear what already landed.
    const controller = new AbortController();
    let round = 0;
    const client: LlmClient = {
      runTurn(params: TurnParams) {
        round++;
        if (round === 1) {
          return Promise.resolve({
            stopReason: 'tool_use',
            text: '',
            toolUses: [
              {
                id: 'tu1',
                name: 'bulk_update',
                input: { table: 'contacts', set: { owner: null } },
              },
            ],
          });
        }
        // The user hits stop while this round is generating: the request aborts.
        params.onText('Next I will ');
        controller.abort();
        return Promise.reject(new Error('Request was aborted.'));
      },
    };

    const events = await collect(
      runChat({
        client,
        dispatch,
        userMessage: 'clean this up',
        signal: controller.signal,
        onToolRecord: record,
      }),
    );

    // Stopping is not a failure — but it is not silence either.
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const warn = events.find((e) => e.type === 'warn');
    expect(warn).toBeDefined();
    const message = warn?.type === 'warn' ? warn.message : '';
    expect(message).toContain('3 record(s) in Contacts');
    expect(message).toContain('still in place');
    expect(message).toContain('undo');
    expect(message).not.toMatch(/\btable\b|\bcolumn\b|bulk_update/i);
    expect(events[events.length - 1]?.type).toBe('done');
  });

  it('reports the failures in a MIXED round, which the all-failed circuit breaker never sees', async () => {
    const { client, contexts } = scriptedClient([
      {
        text: '',
        toolUses: [
          {
            id: 'tu1',
            name: 'create_row',
            input: { table: 'deals', values: { id: 'd9', name: 'New deal' } },
          },
          {
            id: 'tu2',
            name: 'delete_entity',
            input: { name: 'contacts', resolution: 'delete_data' },
          },
        ],
      },
      { text: 'All set.' },
    ]);

    const events = await collect(
      runChat({ client, dispatch, userMessage: 'tidy this up', onToolRecord: record }),
    );

    // The round had a success in it, so the breaker resets and the loop rolls on —
    // which is precisely why the reconciliation has to exist independently.
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const finalContext = finalContextText(contexts);
    expect(finalContext).toContain('2 attempted, 1 succeeded, 1 failed');
    expect(finalContext).toContain('"contacts" was NOT removed');
    const warn = events.find((e) => e.type === 'warn');
    expect(warn?.type === 'warn' ? warn.message : '').toContain('Contacts could not be removed');
  });

  it('says nothing extra when the turn genuinely succeeded', async () => {
    const { client, contexts } = scriptedClient([
      {
        text: '',
        toolUses: [
          {
            id: 'tu1',
            name: 'create_row',
            input: { table: 'deals', values: { id: 'd9', name: 'New deal' } },
          },
        ],
      },
      { text: 'Added.' },
    ]);
    const events = await collect(
      runChat({ client, dispatch, userMessage: 'add a deal', onToolRecord: record }),
    );
    expect(events.some((e) => e.type === 'warn')).toBe(false);
    expect(finalContextText(contexts)).not.toContain('TURN OUTCOME RECORD');
  });

  it('suppresses process narration without ever suppressing outcome truth', async () => {
    const { client, contexts, systems } = scriptedClient([
      {
        text: '',
        toolUses: [
          {
            id: 'tu1',
            name: 'delete_entity',
            input: { name: 'contacts', resolution: 'delete_data' },
          },
        ],
      },
      { text: 'Cleaned up.' },
    ]);
    await collect(
      runChat({ client, dispatch, userMessage: 'clean this up', onToolRecord: record }),
    );

    // The standing instruction to stay quiet about mechanics is still there…
    expect(systems[0]).toContain('Never narrate creating objects, linking, importing');
    // …and it is explicitly bounded, so a silent assistant cannot also be a
    // destructive one.
    expect(systems[0]).toContain('OUTCOME TRUTH IS NEVER SUPPRESSED');
    // The injected record repeats the boundary where it matters most.
    const finalContext = finalContextText(contexts);
    expect(finalContext).toContain('keep suppressing routine process narration');
    expect(finalContext).toContain('That suppression NEVER applies to the lines above');
  });
});

/**
 * Stopping is where the truth is easiest to lose. The browser releases the reply
 * the instant the stop is acked, so anything the job says afterwards lands on a
 * bubble nobody is listening to — and the user who stopped BECAUSE something
 * looked wrong is told nothing about what already changed. The saved reply is the
 * one channel that survives the stop, so the notice has to be part of it.
 */
describe('a stopped reply still carries what already changed', () => {
  const dirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};
  const servers: { close: () => Promise<void> }[] = [];

  beforeEach(() => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-honesty-cfg-'));
    dirs.push(cfgDir);
    for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY', 'LATTICE_CHAT_AUTOINGEST']) {
      savedEnv[k] = process.env[k];
    }
    process.env.LATTICE_CONFIG_DIR = cfgDir;
    process.env.LATTICE_ENCRYPTION_KEY = 'honesty-test-key';
    // Reference-material auto-ingest would make its own model call before the turn.
    process.env.LATTICE_CHAT_AUTOINGEST = 'false';
    seedClaudeOAuth();
    serverRounds = 0;
    reachedSecondRound = new Promise<void>((resolve) => {
      markSecondRound = resolve;
    });
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });

  it('saves the outcome notice onto the stopped reply, where the user can still read it', async () => {
    const { startGuiServer } = await import('../../src/gui/server.js');
    const root = mkdtempSync(join(tmpdir(), 'lattice-honesty-srv-'));
    dirs.push(root);
    const configPath = join(root, 'lattice.config.yml');
    writeFileSync(
      configPath,
      [
        'db: ./data/test.db',
        '',
        'entities:',
        '  contacts:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '      owner: { type: text }',
        '    render: default-list',
        '    outputFile: contacts.md',
        '',
      ].join('\n'),
    );
    const server = await startGuiServer({
      configPath,
      outputDir: join(root, 'context'),
      port: 0,
      openBrowser: false,
    });
    servers.push(server);

    for (const name of ['Ada', 'Grace', 'Alan']) {
      await fetch(`${server.url}/api/tables/contacts/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, owner: 'u1' }),
      });
    }

    const ack = (await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'clean this up' }),
    }).then((r) => r.json())) as { threadId: string; messageId: string };

    // Round 2 is generating, so the clearing call has already landed.
    await reachedSecondRound;
    const stop = await fetch(
      `${server.url}/api/chat/messages/${encodeURIComponent(ack.messageId)}/stop`,
      { method: 'POST' },
    );
    expect(stop.status).toBe(202);

    let row: { text: string; status?: string } | null = null;
    for (let i = 0; i < 100 && !row; i++) {
      const msgs = (await fetch(`${server.url}/api/chat/threads/${ack.threadId}/messages`).then(
        (r) => r.json(),
      )) as {
        messages: { id: string; text: string; status?: string }[];
      };
      const m = msgs.messages.find((x) => x.id === ack.messageId);
      if (m?.status === 'stopped') row = m;
      else await new Promise((r) => setTimeout(r, 50));
    }
    expect(row, 'the assistant row to settle as stopped').not.toBeNull();
    // Whatever streamed before the stop is kept…
    expect(row?.text).toContain('Next I will remove');
    // …and so is the truth about what the stopped turn had already done.
    expect(row?.text).toContain('3 record(s) in Contacts');
    expect(row?.text).toContain('undo');
  });
});
