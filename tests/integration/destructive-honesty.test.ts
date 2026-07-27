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
  type LlmMessage,
  type TurnResult,
  type TurnParams,
} from '../../src/gui/ai/chat.js';
import type { ChatStreamEvent } from '../../src/gui/ai/sse.js';

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
    for (const t of ['contacts', 'deals']) {
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

    toolRecords = [];
    dispatch = {
      db,
      feed: new FeedBus(),
      validTables: new Set(['contacts', 'deals']),
      junctionTables: new Set(),
      softDeletable: new Set(['contacts', 'deals']),
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

  it('refuses a multi-target destructive plan until the user is asked, naming targets and counts', async () => {
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
    expect(text).toContain('ask_user');
    expect(text).toContain('nothing was changed by this call');
    expect(await db.countActive('deals')).toBe(2);
  });

  it('proceeds once the user has answered a question naming every target', async () => {
    // The prior turn's question, as it replays into this turn's history.
    const history: LlmMessage[] = [
      { role: 'user', content: 'simplify my data model' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'q1',
            name: 'ask_user',
            input: {
              question: 'Remove Contacts (3 records) and Deals (2 records)?',
              options: ['Yes, remove both', 'No, keep them'],
            },
          },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'shown' }] },
    ];
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
      { text: 'Neither could be removed.' },
    ]);

    await collect(
      runChat({
        client,
        dispatch,
        history,
        userMessage: 'Yes, remove both',
        onToolRecord: record,
      }),
    );

    // Both reach the real primitive (which fails on its own terms) — no gate.
    const deletes = toolRecords.filter((r) => r.name === 'delete_entity');
    expect(deletes).toHaveLength(2);
    for (const d of deletes) {
      expect(d.content).not.toContain('REFUSED');
      expect(d.content).toContain('still referenced by other records');
    }
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
