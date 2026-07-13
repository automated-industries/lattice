import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { executeFunction, type DispatchCtx, type ComputedOps } from '../../src/gui/ai/dispatch.js';
import type { ComputedTableDef } from '../../src/config/types.js';

/**
 * add_column on a CONNECTED external table (a live, read-only mirror) is redirected
 * DETERMINISTICALLY onto a computed table derived from it, instead of ALTERing the mirror or
 * telling the user to change the source system. The tool creates/reuses the derived view
 * (mirroring the mirror's columns) and hands off to the assistant to author the requested
 * field's formula there via update_computed_table. A normal (authored) table is unaffected.
 */

interface OpsCall {
  op: string;
  args: unknown[];
}
function fakeOps(overrides: Partial<ComputedOps> = {}): { ops: ComputedOps; calls: OpsCall[] } {
  const calls: OpsCall[] = [];
  const rec = (op: string, ...args: unknown[]): void => {
    calls.push({ op, args });
  };
  const ops: ComputedOps = {
    list: () => {
      rec('list');
      return Promise.resolve([]);
    },
    preview: () =>
      Promise.resolve({
        columns: ['id'],
        rows: [],
        sql: '',
        fieldTypes: { id: 'text' },
        pendingAi: {},
      }),
    create: (name, def) => {
      rec('create', name, def);
      return Promise.resolve();
    },
    update: (name, def) => {
      rec('update', name, def);
      return Promise.resolve();
    },
    refresh: () => Promise.resolve([]),
    delete: () => Promise.resolve(),
    ...overrides,
  };
  return { ops, calls };
}

describe('add_column redirects a connected external table to a derived computed view', () => {
  let tmpDir: string;
  let db: Lattice;
  let feed: FeedBus;
  let addColumnCalls: [string, string][];
  let baseCtx: DispatchCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-conn-addcol-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    // A connected external mirror (source descriptor → getConnectedSource is truthy).
    db.define('jira_issues', {
      columns: {
        issue_key: 'TEXT PRIMARY KEY',
        summary: 'TEXT',
        status: 'TEXT',
        deleted_at: 'TEXT',
      },
      primaryKey: 'issue_key',
      source: { connector: 'jira', toolkit: 'jira', model: 'issue', naturalKey: 'issue_key' },
      render: () => '',
      outputFile: 'i.md',
    });
    // A normal authored table (the control).
    db.define('people', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'people.md',
    });
    await db.init();
    feed = new FeedBus();
    addColumnCalls = [];
    baseCtx = {
      db,
      feed,
      validTables: new Set(['jira_issues', 'people']),
      junctionTables: new Set(),
      softDeletable: new Set(['jira_issues', 'people']),
      addColumn: (table: string, column: string) => {
        addColumnCalls.push([table, column]);
        return Promise.resolve({ ok: true as const, column });
      },
    };
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a derived computed view (mirroring columns, not the PK) and never ALTERs the mirror', async () => {
    const { ops, calls } = fakeOps();
    const ctx: DispatchCtx = { ...baseCtx, computedOps: ops, computedTables: new Set() };

    const res = await executeFunction(ctx, 'add_column', {
      table: 'jira_issues',
      column: 'priority',
    });

    expect(res.ok).toBe(true);
    const result = res.ok ? (res.result as Record<string, unknown>) : {};
    expect(result.connected_source).toBe(true);
    expect(result.created_computed_table).toBe(true);
    expect(result.computed_table).toBe('issue_derived'); // deterministic name from the model
    // The mirror was NOT altered.
    expect(addColumnCalls).toEqual([]);
    // A computed table was created on the connected base, mirroring its user columns (not the
    // PK issue_key, not deleted_at, not the _source_* lineage columns).
    const create = calls.find((c) => c.op === 'create');
    expect(create).toBeTruthy();
    const [name, def] = create!.args as [string, ComputedTableDef];
    expect(name).toBe('issue_derived');
    expect(def.base).toBe('jira_issues');
    expect(Object.keys(def.fields).sort()).toEqual(['status', 'summary']);
    expect(def.fields.summary).toEqual({ kind: 'alias', source: 'summary' });
    // The new view is usable by later tool calls this turn.
    expect(ctx.validTables.has('issue_derived')).toBe(true);
    expect(ctx.computedTables?.has('issue_derived')).toBe(true);
    // The hand-off steers to update_computed_table and NEVER to the source system.
    expect(String(result.next)).toMatch(/update_computed_table/);
    expect(String(result.next)).not.toMatch(
      /source system|source database.*add|add.*in the source/i,
    );
  });

  it('reuses an existing computed view already derived from the same connected base', async () => {
    const { ops, calls } = fakeOps({
      list: () =>
        Promise.resolve([
          {
            name: 'issue_derived',
            def: { base: 'jira_issues', fields: { summary: { kind: 'alias', source: 'summary' } } },
          },
        ]),
    });
    const ctx: DispatchCtx = { ...baseCtx, computedOps: ops, computedTables: new Set() };

    const res = await executeFunction(ctx, 'add_column', {
      table: 'jira_issues',
      column: 'priority',
    });
    expect(res.ok).toBe(true);
    const result = res.ok ? (res.result as Record<string, unknown>) : {};
    expect(result.computed_table).toBe('issue_derived');
    expect(result.created_computed_table).toBe(false);
    // Reuse → no second create.
    expect(calls.some((c) => c.op === 'create')).toBe(false);
    expect(addColumnCalls).toEqual([]);
  });

  it('a normal authored table still ALTERs directly (no computed redirect)', async () => {
    const { ops, calls } = fakeOps();
    const ctx: DispatchCtx = { ...baseCtx, computedOps: ops, computedTables: new Set() };

    const res = await executeFunction(ctx, 'add_column', { table: 'people', column: 'nickname' });
    expect(res.ok).toBe(true);
    expect(addColumnCalls).toEqual([['people', 'nickname']]);
    expect(calls.some((c) => c.op === 'create')).toBe(false);
  });
});
