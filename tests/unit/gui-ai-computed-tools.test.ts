import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import {
  executeFunction,
  DISPATCHABLE,
  type DispatchCtx,
  type ComputedOps,
} from '../../src/gui/ai/dispatch.js';
import { getFunction } from '../../src/gui/ai/registry.js';
import type { ComputedTableDef, ComputedFieldDef } from '../../src/config/types.js';
import type { ComputedPreview } from '../../src/gui/computed-ops.js';

/** A recorded call into the fake ops bundle. */
interface OpsCall {
  op: string;
  args: unknown[];
}

const EMPTY_PREVIEW: ComputedPreview = {
  columns: ['id'],
  rows: [],
  sql: 'SELECT 1',
  fieldTypes: { id: 'text' },
  pendingAi: {},
};

/** A call-recording ComputedOps bundle; individual ops overridable per test. */
function fakeOps(overrides: Partial<ComputedOps> = {}): { ops: ComputedOps; calls: OpsCall[] } {
  const calls: OpsCall[] = [];
  const record = (op: string, ...args: unknown[]): void => {
    calls.push({ op, args });
  };
  const ops: ComputedOps = {
    list: () => {
      record('list');
      return Promise.resolve([]);
    },
    preview: (def, limit) => {
      record('preview', def, limit);
      return Promise.resolve(EMPTY_PREVIEW);
    },
    create: (name, def) => {
      record('create', name, def);
      return Promise.resolve();
    },
    update: (name, def) => {
      record('update', name, def);
      return Promise.resolve();
    },
    refresh: (name) => {
      record('refresh', name);
      return Promise.resolve([]);
    },
    delete: (name) => {
      record('delete', name);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { ops, calls };
}

describe('computed-table assistant tools', () => {
  let tmpDir: string;
  let db: Lattice;
  let feed: FeedBus;
  let ctx: DispatchCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-computed-tools-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    db.define('people', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'people.md',
    });
    await db.init();
    feed = new FeedBus();
    ctx = {
      db,
      feed,
      validTables: new Set(['people']),
      junctionTables: new Set(),
      softDeletable: new Set(['people']),
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers the four tools with the right mutates/category, all dispatchable', () => {
    const preview = getFunction('preview_computed_table');
    expect(preview?.mutates).toBe(false);
    expect(preview?.category).toBe('read');
    expect(preview?.args.required).toEqual(expect.arrayContaining(['base', 'fields']));

    const create = getFunction('create_computed_table');
    expect(create?.mutates).toBe(true);
    expect(create?.category).toBe('schema');
    expect(create?.args.required).toEqual(expect.arrayContaining(['name', 'base', 'fields']));

    const update = getFunction('update_computed_table');
    expect(update?.mutates).toBe(true);
    expect(update?.category).toBe('schema');
    expect(update?.args.required).toEqual(['name']);

    const refresh = getFunction('refresh_computed_table');
    expect(refresh?.mutates).toBe(true);
    expect(refresh?.category).toBe('row');
    expect(refresh?.args.required).toEqual(['name']);

    for (const name of [
      'preview_computed_table',
      'create_computed_table',
      'update_computed_table',
      'refresh_computed_table',
    ]) {
      expect(DISPATCHABLE.has(name)).toBe(true);
    }
  });

  it('create_entity description redirects already-existing-data requests to the computed tools', () => {
    const d = getFunction('create_entity')?.description ?? '';
    expect(d).toContain('preview_computed_table');
    expect(d).toContain('create_computed_table');
  });

  it('all four tools report unavailable without a computedOps bundle', async () => {
    for (const name of [
      'preview_computed_table',
      'create_computed_table',
      'update_computed_table',
      'refresh_computed_table',
    ]) {
      const res = await executeFunction(ctx, name, {});
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/not available/i);
    }
  });

  describe('preview_computed_table', () => {
    it('normalizes the fields array into an ordered record and returns rows without SQL', async () => {
      const previews: { def: ComputedTableDef; limit: number | undefined }[] = [];
      const { ops } = fakeOps({
        preview: (def, limit) => {
          previews.push({ def, limit });
          return Promise.resolve({
            columns: ['id', 'who', 'shout'],
            rows: [{ id: 'p1', who: 'Ada', shout: 'ADA' }],
            sql: 'SELECT secret-sql',
            fieldTypes: { id: 'text', who: 'text', shout: 'text' },
            pendingAi: {},
          });
        },
      });
      const c: DispatchCtx = { ...ctx, computedOps: ops };
      const res = await executeFunction(c, 'preview_computed_table', {
        base: 'people',
        fields: [
          { name: 'who', kind: 'alias', source: 'name' },
          { name: 'shout', kind: 'calc', expr: 'upper(name)' },
        ],
      });
      expect(res.ok).toBe(true);
      const def = previews[0]!.def;
      expect(def.base).toBe('people');
      expect(Object.keys(def.fields)).toEqual(['who', 'shout']); // array order preserved
      expect(previews[0]?.limit).toBe(10); // default sample size
      const flat = JSON.stringify(res.result);
      expect(flat).toContain('Ada');
      expect(flat).not.toContain('secret-sql'); // compiled SQL never enters the result
    });

    it('clamps limit to 1–50', async () => {
      const { ops, calls } = fakeOps();
      const c: DispatchCtx = { ...ctx, computedOps: ops };
      const fields = [{ name: 'who', kind: 'alias', source: 'name' }];
      await executeFunction(c, 'preview_computed_table', { base: 'people', fields, limit: 500 });
      await executeFunction(c, 'preview_computed_table', { base: 'people', fields, limit: 0 });
      expect(calls.map((x) => x.args[1])).toEqual([50, 1]);
    });

    it('reports an unknown kind per field as { ok: false } without throwing', async () => {
      const { ops } = fakeOps();
      const c: DispatchCtx = { ...ctx, computedOps: ops };
      const res = await executeFunction(c, 'preview_computed_table', {
        base: 'people',
        fields: [
          { name: 'good', kind: 'alias', source: 'name' },
          { name: 'bad', kind: 'bogus' },
        ],
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('bad');
      expect(res.error).toMatch(/compiled cleanly: good/);
    });

    it('reports a missing required prop (alias without source) as { ok: false }', async () => {
      const { ops } = fakeOps();
      const c: DispatchCtx = { ...ctx, computedOps: ops };
      const res = await executeFunction(c, 'preview_computed_table', {
        base: 'people',
        fields: [{ name: 'who', kind: 'alias' }],
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('who');
    });

    it('rejects a non-array fields value and duplicate field names as { ok: false }', async () => {
      const { ops } = fakeOps();
      const c: DispatchCtx = { ...ctx, computedOps: ops };
      const notArray = await executeFunction(c, 'preview_computed_table', {
        base: 'people',
        fields: 'who',
      });
      expect(notArray.ok).toBe(false);
      expect(notArray.error).toMatch(/array/i);

      const dupes = await executeFunction(c, 'preview_computed_table', {
        base: 'people',
        fields: [
          { name: 'who', kind: 'alias', source: 'name' },
          { name: 'who', kind: 'alias', source: 'id' },
        ],
      });
      expect(dupes.ok).toBe(false);
      expect(dupes.error).toMatch(/duplicate/i);
    });

    it('probes fields individually on a compile failure and names the failing one', async () => {
      const { ops } = fakeOps({
        preview: (def) =>
          'broken' in def.fields
            ? Promise.reject(new Error('unknown column "brokn"'))
            : Promise.resolve(EMPTY_PREVIEW),
      });
      const c: DispatchCtx = { ...ctx, computedOps: ops };
      const res = await executeFunction(c, 'preview_computed_table', {
        base: 'people',
        fields: [
          { name: 'good', kind: 'alias', source: 'name' },
          { name: 'broken', kind: 'alias', source: 'brokn' },
        ],
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('broken: unknown column "brokn"');
      expect(res.error).toMatch(/compiled cleanly: good/);
    });

    it('surfaces a definition-level failure as-is when every field compiles alone', async () => {
      const { ops } = fakeOps({
        // The whole-definition (two-field) run fails; single-field probes pass.
        preview: (def) =>
          Object.keys(def.fields).length > 1
            ? Promise.reject(new Error('Unknown base table "peple"'))
            : Promise.resolve(EMPTY_PREVIEW),
      });
      const c: DispatchCtx = { ...ctx, computedOps: ops };
      const res = await executeFunction(c, 'preview_computed_table', {
        base: 'peple',
        fields: [
          { name: 'a', kind: 'alias', source: 'name' },
          { name: 'b', kind: 'alias', source: 'id' },
        ],
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('Unknown base table "peple"');
    });
  });

  describe('create_computed_table', () => {
    it('creates through the ops bundle and adds the name to the in-turn allowlists', async () => {
      const { ops, calls } = fakeOps();
      const c: DispatchCtx = { ...ctx, computedOps: ops, computedTables: new Set<string>() };
      const res = await executeFunction(c, 'create_computed_table', {
        name: 'summary',
        base: 'people',
        fields: [{ name: 'who', kind: 'alias', source: 'name' }],
      });
      expect(res.ok).toBe(true);
      expect(res.result).toMatchObject({ created: 'summary' });
      const created = calls.find((x) => x.op === 'create');
      expect(created?.args[0]).toBe('summary');
      expect((created?.args[1] as ComputedTableDef).base).toBe('people');
      expect(c.validTables.has('summary')).toBe(true);
      expect(c.computedTables?.has('summary')).toBe(true);
    });

    it('returns { ok: false } for a bad field instead of calling create', async () => {
      const { ops, calls } = fakeOps();
      const c: DispatchCtx = { ...ctx, computedOps: ops };
      const res = await executeFunction(c, 'create_computed_table', {
        name: 'summary',
        base: 'people',
        fields: [{ name: 'who', kind: 'nope' }],
      });
      expect(res.ok).toBe(false);
      expect(calls.some((x) => x.op === 'create')).toBe(false);
    });

    it('maps an ops-layer rejection (e.g. a name collision) to { ok: false }', async () => {
      const { ops } = fakeOps({
        create: () => Promise.reject(new Error('A table named "people" already exists')),
      });
      const c: DispatchCtx = { ...ctx, computedOps: ops, computedTables: new Set<string>() };
      const res = await executeFunction(c, 'create_computed_table', {
        name: 'people',
        base: 'people',
        fields: [{ name: 'who', kind: 'alias', source: 'name' }],
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/already exists/);
      expect(c.computedTables?.has('people')).toBe(false); // nothing added on failure
    });
  });

  describe('update_computed_table', () => {
    const existingDef: ComputedTableDef = {
      base: 'people',
      fields: {
        first: { kind: 'alias', source: 'name' },
        second: { kind: 'calc', expr: '1 + 1' },
        third: { kind: 'alias', source: 'id' },
      },
    };

    function withExisting(): { c: DispatchCtx; calls: OpsCall[] } {
      const { ops, calls } = fakeOps({
        list: () => Promise.resolve([{ name: 'summary', def: existingDef }]),
      });
      return { c: { ...ctx, computedOps: ops }, calls };
    }

    it('merges set_fields (replace-by-name in place, append new) and remove_fields onto the existing def', async () => {
      const { c, calls } = withExisting();
      const res = await executeFunction(c, 'update_computed_table', {
        name: 'summary',
        set_fields: [
          { name: 'second', kind: 'alias', source: 'name' }, // replaces, keeps its slot
          { name: 'fourth', kind: 'alias', source: 'id' }, // new, appended last
        ],
        remove_fields: ['first'],
      });
      expect(res.ok).toBe(true);
      const sent = calls.find((x) => x.op === 'update');
      expect(sent?.args[0]).toBe('summary');
      const def = sent?.args[1] as ComputedTableDef;
      expect(def.base).toBe('people'); // base never changes
      expect(Object.keys(def.fields)).toEqual(['second', 'third', 'fourth']);
      expect(def.fields.second).toEqual({ kind: 'alias', source: 'name' });
      expect(def.fields.third).toEqual(existingDef.fields.third); // untouched fields survive
    });

    it('errors on an unknown table, an unknown remove name, and an empty change set', async () => {
      const { c, calls } = withExisting();
      const unknownTable = await executeFunction(c, 'update_computed_table', {
        name: 'nope',
        remove_fields: ['first'],
      });
      expect(unknownTable.ok).toBe(false);
      expect(unknownTable.error).toMatch(/unknown computed table/i);

      const unknownField = await executeFunction(c, 'update_computed_table', {
        name: 'summary',
        remove_fields: ['ghost'],
      });
      expect(unknownField.ok).toBe(false);
      expect(unknownField.error).toContain('ghost');

      const nothing = await executeFunction(c, 'update_computed_table', { name: 'summary' });
      expect(nothing.ok).toBe(false);
      expect(nothing.error).toMatch(/nothing to change/i);

      expect(calls.some((x) => x.op === 'update')).toBe(false);
    });

    it('refuses to remove every field (points at delete_entity instead)', async () => {
      const { c, calls } = withExisting();
      const res = await executeFunction(c, 'update_computed_table', {
        name: 'summary',
        remove_fields: ['first', 'second', 'third'],
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/at least one field/i);
      expect(res.error).toContain('delete_entity');
      expect(calls.some((x) => x.op === 'update')).toBe(false);
    });

    it('returns { ok: false } for a bad set_fields item without calling update', async () => {
      const { c, calls } = withExisting();
      const res = await executeFunction(c, 'update_computed_table', {
        name: 'summary',
        set_fields: [{ name: 'second', kind: 'ai_classify', input: 'name', prompt: 'x' }], // labels missing
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('second');
      expect(calls.some((x) => x.op === 'update')).toBe(false);
    });
  });

  describe('refresh_computed_table', () => {
    it('routes to the ops bundle and reports per-field fill results', async () => {
      const { ops } = fakeOps({
        refresh: () =>
          Promise.resolve([
            {
              field: 'category',
              key: 'summary.category',
              kind: 'ai_classify',
              status: 'idle',
              filled: 3,
              pending: 0,
            },
          ]),
      });
      const c: DispatchCtx = { ...ctx, computedOps: ops };
      const res = await executeFunction(c, 'refresh_computed_table', { name: 'summary' });
      expect(res.ok).toBe(true);
      expect(res.result).toMatchObject({
        refreshed: 'summary',
        fields: [{ field: 'category', status: 'idle', filled: 3, pending: 0 }],
      });
    });

    it('explains that a view with no AI fields never needs a refresh', async () => {
      const { ops } = fakeOps();
      const c: DispatchCtx = { ...ctx, computedOps: ops };
      const res = await executeFunction(c, 'refresh_computed_table', { name: 'summary' });
      expect(res.ok).toBe(true);
      expect(JSON.stringify(res.result)).toMatch(/no AI fields/);
    });
  });

  describe('delete_entity on a computed table', () => {
    it('routes to computedOps.delete — no row-resolution dance, allowlists updated', async () => {
      const { ops, calls } = fakeOps();
      let entityDeleteCalled = false;
      const c: DispatchCtx = {
        ...ctx,
        computedOps: ops,
        validTables: new Set(['people', 'summary']),
        computedTables: new Set(['summary']),
        deleteEntity: () => {
          entityDeleteCalled = true;
          return Promise.resolve({ ok: true, deleted: 'summary' });
        },
      };
      const res = await executeFunction(c, 'delete_entity', { name: 'summary' });
      expect(res.ok).toBe(true);
      expect(res.result).toMatchObject({ deleted: 'summary', computed: true });
      expect(calls.some((x) => x.op === 'delete' && x.args[0] === 'summary')).toBe(true);
      expect(entityDeleteCalled).toBe(false); // never enters the entity-delete flow
      expect(c.validTables.has('summary')).toBe(false);
      expect(c.computedTables?.has('summary')).toBe(false);
    });

    it('reports unavailable for a computed name when no computedOps bundle is wired', async () => {
      const c: DispatchCtx = { ...ctx, computedTables: new Set(['summary']) };
      const res = await executeFunction(c, 'delete_entity', { name: 'summary' });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/not available/i);
    });

    it('relays a refusal (dependents still built on it) as { ok: false }', async () => {
      const { ops } = fakeOps({
        delete: () =>
          Promise.reject(
            new Error(
              'Cannot delete computed table "summary" — computed table roll is built on it',
            ),
          ),
      });
      const c: DispatchCtx = {
        ...ctx,
        computedOps: ops,
        validTables: new Set(['people', 'summary']),
        computedTables: new Set(['summary']),
      };
      const res = await executeFunction(c, 'delete_entity', { name: 'summary' });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/built on it/);
      expect(c.validTables.has('summary')).toBe(true); // nothing removed on failure
    });
  });

  describe('list_entities tagging', () => {
    it('flags computed views as read-only so the model never writes rows to one', async () => {
      await db.defineLate('summary', {
        columns: { id: 'TEXT PRIMARY KEY', who: 'TEXT' },
        render: () => '',
        outputFile: 'summary.md',
      });
      const c: DispatchCtx = {
        ...ctx,
        validTables: new Set(['people', 'summary']),
        computedTables: new Set(['summary']),
      };
      const res = await executeFunction(c, 'list_entities', {});
      expect(res.ok).toBe(true);
      const rows = res.result as { name: string; computed?: boolean; readOnly?: boolean }[];
      expect(rows.find((t) => t.name === 'summary')).toMatchObject({
        computed: true,
        readOnly: true,
      });
      expect(rows.find((t) => t.name === 'people')?.computed).toBeUndefined();
    });
  });

  it('a computed field definition round-trips untouched through the array normalization', async () => {
    // Every kind in one preview — the ops layer must receive exactly the typed
    // shapes the config narrower produces.
    const { ops, calls } = fakeOps();
    const c: DispatchCtx = { ...ctx, computedOps: ops };
    const res = await executeFunction(c, 'preview_computed_table', {
      base: 'people',
      fields: [
        { name: 'copy', kind: 'alias', source: 'name' },
        { name: 'math', kind: 'calc', expr: 'a + b', type: 'integer' },
        { name: 'label', kind: 'ai_classify', input: 'name', prompt: 'p', labels: ['x', 'y'] },
        { name: 'gist', kind: 'ai_transform', inputs: ['name'], prompt: 'p' },
        { name: 'n', kind: 'aggregate', via: 'people_tags.tag', fn: 'count' },
      ],
    });
    expect(res.ok).toBe(true);
    const def = calls[0]?.args[0] as ComputedTableDef;
    const expected: Record<string, ComputedFieldDef> = {
      copy: { kind: 'alias', source: 'name' },
      math: { kind: 'calc', expr: 'a + b', type: 'integer' },
      label: { kind: 'ai_classify', input: 'name', prompt: 'p', labels: ['x', 'y'] },
      gist: { kind: 'ai_transform', inputs: ['name'], prompt: 'p' },
      n: { kind: 'aggregate', via: 'people_tags.tag', fn: 'count' },
    };
    expect(def.fields).toEqual(expected);
  });
});
