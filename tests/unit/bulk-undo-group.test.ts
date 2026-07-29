import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import { executeFunction, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import {
  undoGroup,
  undoLast,
  GROUP_UNDO_MAX_ENTRIES,
  type MutationCtx,
} from '../../src/gui/mutations.js';

/**
 * Bulk undo as ONE action. Every row written by a single tool execution is
 * stamped with one operation-group id in the audit log, and `undoGroup`
 * reverses the whole group atomically:
 *
 *  - a bulk update across N rows undoes as one action;
 *  - a group containing a row someone else edited since FAILS LOUDLY, changing
 *    nothing — never a silent skip of the conflicting row;
 *  - single-record undo (`undoLast`) is untouched: it still steps one entry at
 *    a time, newest first, regardless of grouping.
 */
describe('bulk undo — operation groups in the audit log', () => {
  let root: string;
  let db: Lattice;
  let feed: FeedBus;
  let ctx: DispatchCtx;
  let configPath: string;
  let outputDir: string;

  /** The canonical MutationCtx a GUI request would build for this session. */
  function mctx(overrides: Partial<MutationCtx> = {}): MutationCtx {
    return {
      db,
      feed,
      softDeletable: new Set(['companies']),
      source: 'gui',
      sessionId: 'sess-1',
      ...overrides,
    };
  }

  async function auditRows(): Promise<Record<string, unknown>[]> {
    return (await db.query('_lattice_gui_audit', {})) as Record<string, unknown>[];
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lattice-bulk-undo-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    configPath = join(root, 'lattice.config.yml');
    outputDir = join(root, 'context');
    writeFileSync(
      configPath,
      [
        'db: ./data/test.db',
        '',
        'entities:',
        '  companies:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '      status: { type: text }',
        '      created_at: { type: timestamp }',
        '      deleted_at: { type: timestamp }',
        '    outputFile: companies.md',
        '',
      ].join('\n'),
    );
    db = new Lattice({ config: configPath }, { encryptionKey: 'bulk-undo-test-key' });
    // The GUI audit table exactly as lifecycle.ts defines it (incl. op_group).
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
        session_id: 'TEXT',
        source: 'TEXT',
        op_group: 'TEXT',
      },
      render: () => '',
      outputFile: '.lattice-gui/audit.md',
    });
    await db.init();
    feed = new FeedBus();
    ctx = {
      db,
      feed,
      validTables: new Set(['companies']),
      junctionTables: new Set<string>(),
      softDeletable: new Set(['companies']),
      configPath,
      outputDir,
      sessionId: 'sess-1',
    };
    for (let i = 1; i <= 5; i++) {
      await db.insert('companies', {
        id: `c${String(i)}`,
        name: `Company ${String(i)}`,
        status: 'active',
        created_at: `2026-01-0${String(i)}T00:00:00Z`,
      });
    }
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('stamps every audit row of one bulk_update with ONE operation-group id (fresh per call)', async () => {
    const first = await executeFunction(ctx, 'bulk_update', {
      table: 'companies',
      set: { status: 'flagged' },
    });
    expect(first.ok).toBe(true);
    expect(first.result).toMatchObject({ affected: 5 });

    const afterFirst = await auditRows();
    // 5 inserts came from db.insert directly (no audit); the bulk wrote 5 updates.
    const updates = afterFirst.filter((a) => a.operation === 'update');
    expect(updates).toHaveLength(5);
    const groups = new Set(updates.map((a) => a.op_group));
    expect(groups.size).toBe(1);
    const [groupId] = [...groups];
    expect(typeof groupId).toBe('string');
    expect(groupId).toBeTruthy();

    // A second tool execution gets its OWN group id.
    const second = await executeFunction(ctx, 'bulk_update', {
      table: 'companies',
      set: { status: 'archived' },
    });
    expect(second.ok).toBe(true);
    const all = await auditRows();
    const secondGroups = new Set(
      all.filter((a) => a.operation === 'update' && a.op_group !== groupId).map((a) => a.op_group),
    );
    expect(secondGroups.size).toBe(1);
  });

  it('undoes a bulk update across N rows as ONE action', async () => {
    const res = await executeFunction(ctx, 'bulk_update', {
      table: 'companies',
      set: { status: 'flagged' },
    });
    expect(res.ok).toBe(true);
    const updates = (await auditRows()).filter((a) => a.operation === 'update');
    const groupId = String(updates[0]?.op_group);

    const events: FeedEvent[] = [];
    feed.subscribe((e) => events.push(e));

    const out = await undoGroup(mctx(), groupId);
    expect(out).toMatchObject({ ok: true, undone: 5, tables: ['companies'] });

    // Every row is back to its pre-bulk value.
    for (let i = 1; i <= 5; i++) {
      expect((await db.get('companies', `c${String(i)}`))?.status).toBe('active');
    }
    // Every entry of the group is flipped undone — and it was ONE action: a
    // single feed event for the whole group, not five.
    const after = (await auditRows()).filter((a) => a.op_group === groupId);
    expect(after).toHaveLength(5);
    expect(after.every((a) => Number(a.undone) === 1)).toBe(true);
    const undoEvents = events.filter((e) => e.op === 'undo');
    expect(undoEvents).toHaveLength(1);
    expect(undoEvents[0]?.summary).toContain('5 changes');

    // Undoing the same group again reports it honestly, not as a fresh success.
    const again = await undoGroup(mctx(), groupId);
    expect(again).toMatchObject({ ok: false, reason: 'already_undone' });
  });

  it('FAILS LOUDLY (and changes nothing) when a row in the group was edited since', async () => {
    const res = await executeFunction(ctx, 'bulk_update', {
      table: 'companies',
      set: { status: 'flagged' },
    });
    expect(res.ok).toBe(true);
    const updates = (await auditRows()).filter((a) => a.operation === 'update');
    const groupId = String(updates[0]?.op_group);

    // Someone else edits one of the rows AFTER the bulk change (a direct write,
    // as another client would make it).
    await db.update('companies', 'c3', { status: 'kept-by-hand' });

    const out = await undoGroup(mctx(), groupId);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('conflict');
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]).toMatchObject({ table: 'companies', rowId: 'c3' });
    expect(out.conflicts[0]?.reason).toContain('edited after this change');

    // NOTHING was changed — not the conflicting row, and not the clean ones
    // either (no silent partial undo).
    expect((await db.get('companies', 'c3'))?.status).toBe('kept-by-hand');
    for (const id of ['c1', 'c2', 'c4', 'c5']) {
      expect((await db.get('companies', id))?.status).toBe('flagged');
    }
    const after = (await auditRows()).filter((a) => a.op_group === groupId);
    expect(after.every((a) => Number(a.undone) === 0)).toBe(true);
  });

  it('FAILS LOUDLY when a row in the group was removed since', async () => {
    const res = await executeFunction(ctx, 'bulk_update', {
      table: 'companies',
      set: { status: 'flagged' },
    });
    expect(res.ok).toBe(true);
    const updates = (await auditRows()).filter((a) => a.operation === 'update');
    const groupId = String(updates[0]?.op_group);

    await db.delete('companies', 'c2');

    const out = await undoGroup(mctx(), groupId);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('conflict');
    expect(out.conflicts[0]?.reason).toContain('removed after this change');
    // The surviving rows keep the bulk value — nothing was partially undone.
    expect((await db.get('companies', 'c1'))?.status).toBe('flagged');
  });

  it('reports an unknown group id as not_found', async () => {
    const out = await undoGroup(mctx(), 'no-such-group');
    expect(out).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('refuses a group-undo from a session that did NOT author it — flips nothing; the author still can', async () => {
    // Authorization is app-layer, not RLS: on a shared cloud each member/owner
    // connects as a distinct process with its own session id, so a group's audit
    // entries all carry the AUTHOR's session id. A second session must not be able
    // to reverse it (RLS would otherwise return only the visible slice and a blind
    // replay would flip the author's entries to undone and desync the audit).
    //
    // (This runs on SQLite, so it asserts the ownership gate directly on the
    // session id every audit row carries; the same gate is what protects a real
    // cloud member's scoped Postgres connection, where LATTICE_TEST_PG_URL-gated
    // integration suites exercise the RLS layer. No live member role is reachable
    // in this harness, so this is the strongest app-layer ownership proof.)
    const authorCtx: DispatchCtx = { ...ctx, sessionId: 'sess-author' };
    const res = await executeFunction(authorCtx, 'bulk_update', {
      table: 'companies',
      set: { status: 'flagged' },
    });
    expect(res.ok).toBe(true);
    const updates = (await auditRows()).filter((a) => a.operation === 'update');
    const groupId = String(updates[0]?.op_group);
    expect(updates).toHaveLength(5);
    expect(updates.every((a) => a.session_id === 'sess-author')).toBe(true);

    // A DIFFERENT session (another member) tries to undo the author's group.
    const denied = await undoGroup(mctx({ sessionId: 'sess-intruder' }), groupId);
    expect(denied).toMatchObject({ ok: false, reason: 'forbidden' });

    // NOTHING was flipped, NOTHING was reversed — a loud refusal, not a silent
    // no-op or a half-undo.
    const afterDenied = (await auditRows()).filter((a) => a.op_group === groupId);
    expect(afterDenied.every((a) => Number(a.undone) === 0)).toBe(true);
    for (let i = 1; i <= 5; i++) {
      expect((await db.get('companies', `c${String(i)}`))?.status).toBe('flagged');
    }

    // The AUTHOR can undo their own group.
    const allowed = await undoGroup(mctx({ sessionId: 'sess-author' }), groupId);
    expect(allowed).toMatchObject({ ok: true, undone: 5 });
    for (let i = 1; i <= 5; i++) {
      expect((await db.get('companies', `c${String(i)}`))?.status).toBe('active');
    }
  });

  it('bounds a bulk_update at the group cap — refuses over-cap, applies nothing, never an unbounded load', async () => {
    // Seed just past the cap. bulk_update reads the match set BOUNDED (limit =
    // cap + 1) and must REFUSE the whole op — never load an unbounded set and
    // never silently apply a slice. 5 rows already exist from beforeEach.
    const need = GROUP_UNDO_MAX_ENTRIES + 1 - 5;
    await db.transaction(async () => {
      for (let i = 0; i < need; i++) {
        await db.insert('companies', {
          id: `x${String(i)}`,
          name: `Co ${String(i)}`,
          status: 'active',
          created_at: '2026-02-01T00:00:00Z',
        });
      }
    });

    const auditBefore = (await auditRows()).length;
    const res = await executeFunction(ctx, 'bulk_update', {
      table: 'companies',
      set: { status: 'flagged' },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toMatch(/more than|too many/i);

    // Nothing was applied: no audit entries written, no row flipped.
    expect((await auditRows()).length).toBe(auditBefore);
    expect((await db.get('companies', 'c1'))?.status).toBe('active');
    expect((await db.get('companies', 'x0'))?.status).toBe('active');
  }, 30000);

  it('leaves single-record undo untouched: undoLast still steps one entry at a time', async () => {
    const bulk = await executeFunction(ctx, 'bulk_update', {
      table: 'companies',
      set: { status: 'flagged' },
    });
    expect(bulk.ok).toBe(true);

    // A later standalone single-row edit through the same session. The audit
    // timestamp has millisecond resolution and undoLast orders by it, so give
    // the single edit a strictly later stamp than the bulk entries.
    await new Promise((r) => setTimeout(r, 10));
    const single = await executeFunction(ctx, 'update_row', {
      table: 'companies',
      id: 'c1',
      values: { name: 'Company One Renamed' },
    });
    expect(single.ok).toBe(true);

    // First undo reverses ONLY the newest entry (the rename) …
    const first = await undoLast(mctx());
    expect(first?.operation).toBe('update');
    expect(first?.row_id).toBe('c1');
    expect((await db.get('companies', 'c1'))?.name).toBe('Company 1');
    // … and the bulk change is still fully applied.
    for (let i = 1; i <= 5; i++) {
      expect((await db.get('companies', `c${String(i)}`))?.status).toBe('flagged');
    }

    // A second undoLast steps into the bulk group ONE entry at a time — the
    // pre-existing single-step semantics, unchanged by grouping.
    const second = await undoLast(mctx());
    expect(second?.operation).toBe('update');
    const reverted = String(second?.row_id);
    expect((await db.get('companies', reverted))?.status).toBe('active');
    const stillFlagged = ['c1', 'c2', 'c3', 'c4', 'c5'].filter((id) => id !== reverted);
    for (const id of stillFlagged) {
      expect((await db.get('companies', id))?.status).toBe('flagged');
    }
  });
});
