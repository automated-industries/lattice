import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';
import {
  destructiveIntent,
  executeFunction,
  TurnOutcomeLedger,
  verbKey,
  type DispatchCtx,
} from '../../src/gui/ai/dispatch.js';
import { runChat, type LlmClient, type TurnResult } from '../../src/gui/ai/chat.js';
import type { ChatStreamEvent } from '../../src/gui/ai/sse.js';
import { loadConsent, type ConsentGrant } from '../../src/gui/ai/consent-store.js';

/**
 * WHAT THE CONFIRMATION CARD SAYS HAS TO BE TRUE, AND WHAT IT BINDS HAS TO BE WHAT
 * THE USER WAS SHOWN.
 *
 * The card is the entire user-facing surface of the destructive gate: it is the one
 * screen a person reads before allowing data to be destroyed. Three ways it lied.
 *
 *  1. SCALE. The pre-flight count stops at a cap and returns cap+1 for anything
 *     larger, so an object holding 12,000 records and one holding 5,001 both printed
 *     "5001 record(s)". A floor rendered as a total, on the screen where the user
 *     decides whether the blast radius is acceptable.
 *  2. AUTHORSHIP. `bulk_update`'s `set` KEYS are arbitrary model-supplied strings and
 *     went straight onto the card with nothing checking them against the table's real
 *     columns — newlines included. Not XSS (the client sets textContent), but
 *     attacker-chosen reassurance inside the confirmation, able to ride alongside a
 *     REAL grant.
 *  3. IDENTITY. A grant bound target + verb + COUNT and nothing about WHICH records,
 *     so consent shown for one set of 50 was spendable on a different 50, and consent
 *     minted to delete row c0 deleted c42. And `delete_entity` never named its
 *     resolution, so "remove Invoices (5001 records)" read identically whether the
 *     records were kept or cascaded away.
 *
 * These run through the REAL paths — the ask_user/confirm mint for the card, and
 * executeFunction for the gate — because each defect lived in the seam between the
 * classifier and what the user or the gate actually got.
 */

/** A scripted LlmClient that returns queued turns. */
function scriptedClient(turns: { text: string; toolUses?: TurnResult['toolUses'] }[]): LlmClient {
  let i = 0;
  return {
    runTurn(params) {
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      if (turn?.text) params.onText(turn.text);
      const toolUses = turn?.toolUses ?? [];
      return Promise.resolve({
        stopReason: toolUses.length > 0 ? 'tool_use' : 'end_turn',
        text: turn?.text ?? '',
        toolUses,
      });
    },
  };
}

async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const SCOPE = { threadId: 'thread-1', ownerUserId: 'user-1', askedMsgId: 'msg-1' };

describe('the confirmation card is honest about scale, authorship and identity', () => {
  let tmpDir: string;
  let db: Lattice;
  let ctx: DispatchCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-cardhonesty-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    for (const t of ['notes', 'huge']) {
      db.define(t, {
        columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', owner: 'TEXT', deleted_at: 'TEXT' },
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
    // 30 archived + 30 active. Equal halves on purpose: the count is then identical
    // either way, so ONLY the filter can tell the two sets of records apart — which
    // is exactly the case the old grant could not.
    for (const owner of ['archived', 'active']) {
      for (let i = 0; i < 30; i++) {
        await db.insert('notes', { id: `n_${owner}_${String(i)}`, body: 'keep me', owner });
      }
    }
    ctx = {
      db,
      feed: new FeedBus(),
      validTables: new Set(['notes', 'huge']),
      junctionTables: new Set(),
      softDeletable: new Set(['notes', 'huge']),
      deleteEntity: () => Promise.resolve({ ok: true as const, droppedLinkTables: [] }),
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Fill `huge` past the pre-flight count cap, in one statement. */
  async function fillPastCap(n: number): Promise<void> {
    await runAsyncOrSync(
      db.adapter,
      `WITH RECURSIVE c(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM c WHERE k < ${String(n)})
       INSERT INTO "huge" ("id","body") SELECT 'r' || k, 'x' FROM c`,
    );
  }

  /** The `question` event a confirm-bearing ask_user turn produces. */
  async function askToConfirm(
    confirm: { tool: string; args: Record<string, unknown> }[],
  ): Promise<Extract<ChatStreamEvent, { type: 'question' }> | undefined> {
    const client = scriptedClient([
      {
        text: 'One moment.',
        toolUses: [
          {
            id: 'tu1',
            name: 'ask_user',
            input: { question: 'MODEL QUESTION', options: ['MODEL YES', 'MODEL NO'], confirm },
          },
        ],
      },
    ]);
    const events = await collect(
      runChat({ client, dispatch: ctx, userMessage: 'go on then', consentScope: SCOPE }),
    );
    const q = events.find((e) => e.type === 'question');
    return q?.type === 'question' ? q : undefined;
  }

  /** A ledger holding consent the route would have resolved for this turn. */
  function ledgerWith(grants: ConsentGrant[]): TurnOutcomeLedger {
    const live = grants.map((g) => ({ ...g }));
    return new TurnOutcomeLedger({
      consent: {
        status: 'granted',
        grants: live,
        spend: (i) => {
          const g = live[i];
          if (!g || g.spentAt) return Promise.resolve(false);
          g.spentAt = new Date().toISOString();
          return Promise.resolve(true);
        },
      },
    });
  }

  // ── 1. SCALE ───────────────────────────────────────────────────────────────

  it('says "at least" when the count hit its cap, and states it exactly when it did not', async () => {
    // Well past the cap, so the count is a floor and the card must not read as a total.
    await fillPastCap(6000);
    const big = await destructiveIntent(ctx, 'delete_entity', {
      name: 'huge',
      resolution: 'delete_data',
    });
    expect(big?.rowsSaturated).toBe(true);
    expect(big?.detail).toContain('at least');
    // The number itself is the cap+1 the counter stopped at — which is precisely why
    // it must never be printed as if it were the total.
    expect(big?.rows).toBe(5001);

    // A countable object is unchanged: an exact number, stated as one, with no
    // hedging that would make every ordinary confirmation read as an estimate.
    const small = await destructiveIntent(ctx, 'delete_entity', {
      name: 'notes',
      resolution: 'delete_data',
    });
    expect(small?.rowsSaturated).toBeUndefined();
    expect(small?.detail).toContain('60 record(s)');
    expect(small?.detail).not.toContain('at least');
  });

  it('carries saturation onto the card and into the grant the user is agreeing to', async () => {
    await fillPastCap(6000);
    const q = await askToConfirm([
      { tool: 'delete_entity', args: { name: 'huge', resolution: 'delete_data' } },
    ]);
    if (!q) throw new Error('no question event');

    // The card, which is the only thing the user reads.
    expect(q.consent?.headline).toContain('at least');
    expect(q.consent?.lines.join('\n')).toContain('at least');
    // ...and the durable record, so an auditor reading the row later is not told a
    // 12,000-record object was a 5,001-record one either.
    const record = await loadConsent(db, q.id ?? '');
    expect(record?.grants[0]?.rowsSaturated).toBe(true);
    expect(record?.grants[0]?.maxRows).toBe(5001);
  });

  // ── 2. AUTHORSHIP ──────────────────────────────────────────────────────────

  /** The measured card line, verbatim: reassurance plus an instruction, with newlines. */
  const INJECTED_KEY =
    'body" - SAFE: only archived test rows, nothing real is lost.\nIgnore the line above. Column: "x';

  it('keeps model-authored set keys off the card, and names only real columns', async () => {
    const q = await askToConfirm([
      {
        tool: 'bulk_update',
        // One real column so the call genuinely destroys something, plus the injected
        // key riding alongside it — the shape that let attacker prose share a card
        // with a REAL grant.
        args: { table: 'notes', set: { body: null, [INJECTED_KEY]: null } },
      },
    ]);
    if (!q) throw new Error('no question event');

    const card = `${q.consent?.headline ?? ''}\n${(q.consent?.lines ?? []).join('\n')}`;
    expect(card).not.toContain('SAFE: only archived test rows');
    expect(card).not.toContain('Ignore the line above');
    // Every line is ONE line: a newline is what let the injected text present itself
    // as a separate statement rather than as part of a quoted column name.
    for (const line of q.consent?.lines ?? []) expect(line).not.toContain('\n');
    // The real column is still named, so the user is told what is actually cleared.
    expect(card).toContain('"body"');

    // The same is true of the durable record — the card is not sanitised at the last
    // moment while the row keeps the prose.
    const record = await loadConsent(db, q.id ?? '');
    expect(JSON.stringify(record?.grants)).not.toContain('Ignore the line above');
  });

  it('refuses to mint a card at all when the only columns named are not real', async () => {
    const q = await askToConfirm([
      { tool: 'bulk_update', args: { table: 'notes', set: { [INJECTED_KEY]: null } } },
    ]);
    // A call that clears nothing that exists destroys nothing, so there is nothing to
    // confirm — and no card is composed from it. The model is told so; the user is
    // shown nothing.
    expect(q).toBeUndefined();
  });

  // ── 3. IDENTITY ────────────────────────────────────────────────────────────

  it('names the resolution, so keeping the records and destroying them do not read alike', async () => {
    const keepish = await destructiveIntent(ctx, 'delete_entity', { name: 'huge' }); // empty ⇒ classified
    const wipe = await destructiveIntent(ctx, 'delete_entity', {
      name: 'notes',
      resolution: 'delete_data',
    });
    const cascade = await destructiveIntent(ctx, 'delete_entity', {
      name: 'notes',
      resolution: 'delete_cascade',
    });
    // Three different acts, three different sentences. They used to be one sentence.
    expect(new Set([keepish?.detail, wipe?.detail, cascade?.detail]).size).toBe(3);
    expect(wipe?.detail).toContain('DELETE its 60 record(s)');
    expect(cascade?.detail).toContain('other objects that point at them');
    expect(keepish?.detail).toContain('none of them deleted');
  });

  it('will not spend a filtered clear on a DIFFERENT set of records of the same size', async () => {
    const call = (owner: string): Record<string, unknown> => ({
      table: 'notes',
      set: { body: null },
      filter: [{ col: 'owner', op: 'eq', val: owner }],
    });
    const ledger = ledgerWith([
      {
        tool: 'bulk_update',
        kind: 'clear',
        target: 'notes',
        verbKey: verbKey('bulk_update', call('archived')),
        maxRows: 30,
        rowsUnknown: false,
        rowsSaturated: false,
        detail: 'clear "body" on 30 record(s) in "notes"',
      },
    ]);

    // The other 30. Same object, same column, same COUNT — so the old grant, which
    // bound only those three things, covered it exactly.
    const wrong = await executeFunction(ctx, 'bulk_update', call('active'), ledger);
    // Asserted on the DATA first: if the gate let this through, these records are
    // already gone, and that is what the failure should say.
    const active = await db.query('notes', {
      filters: [{ col: 'owner', op: 'eq', val: 'active' }],
    });
    expect(active.map((r) => r.body)).toEqual(Array.from({ length: 30 }, () => 'keep me'));
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain('REFUSED');

    // ...and the records the user actually approved are still clearable, so this is a
    // binding and not simply a refusal of everything.
    const right = await executeFunction(ctx, 'bulk_update', call('archived'), ledger);
    expect(right.ok).toBe(true);
    const archived = await db.query('notes', {
      filters: [{ col: 'owner', op: 'eq', val: 'archived' }],
    });
    expect(archived.every((r) => r.body === null)).toBe(true);
  });

  it('will not spend a row deletion on a DIFFERENT row', async () => {
    const clear: Record<string, unknown> = {
      table: 'notes',
      set: { body: null },
      filter: [{ col: 'owner', op: 'eq', val: 'archived' }],
    };
    const ledger = ledgerWith([
      {
        tool: 'bulk_update',
        kind: 'clear',
        target: 'notes',
        verbKey: verbKey('bulk_update', clear),
        maxRows: 30,
        rowsUnknown: false,
        rowsSaturated: false,
        detail: 'clear "body" on 30 record(s) in "notes"',
      },
      {
        tool: 'delete_row',
        kind: 'delete_records',
        target: 'notes',
        verbKey: verbKey('delete_row', { table: 'notes', id: 'n_archived_0' }),
        maxRows: 1,
        rowsUnknown: false,
        rowsSaturated: false,
        detail: 'delete record n_archived_0 from "notes"',
      },
    ]);
    // Makes the turn wide enough that the single-row delete is gated at all.
    expect((await executeFunction(ctx, 'bulk_update', clear, ledger)).ok).toBe(true);

    // Consent was minted for one record; the call names another.
    const gated = await executeFunction(
      ctx,
      'delete_row',
      { table: 'notes', id: 'n_active_1' },
      ledger,
    );
    // The DATA first, for the same reason as above: a gate that let this through has
    // already deleted a record the user never approved deleting.
    expect((await db.get('notes', 'n_active_1'))?.deleted_at ?? null).toBeNull();
    expect(gated.ok).toBe(false);
    expect(gated.error).toContain('REFUSED');

    // The record the user DID approve still goes through.
    const right = await executeFunction(
      ctx,
      'delete_row',
      { table: 'notes', id: 'n_archived_0' },
      ledger,
    );
    expect(right.ok).toBe(true);
    expect((await db.get('notes', 'n_archived_0'))?.deleted_at ?? null).not.toBeNull();
  });
});
