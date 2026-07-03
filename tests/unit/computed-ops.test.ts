import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig } from '../../src/gui/lifecycle.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import {
  createComputedTable,
  updateComputedTable,
  deleteComputedTable,
  previewComputedTable,
  refreshComputedTable,
  listComputedTables,
  reachableFields,
  assertNotComputedSource,
} from '../../src/gui/computed-ops.js';
import { applySchemaConfig } from '../../src/gui/lifecycle.js';
import { softDeleteUserEntity, aiDeleteEntity } from '../../src/gui/schema-ops.js';
import { createRow, parseAudit, type MutationCtx } from '../../src/gui/mutations.js';
import { loadConfigDoc } from '../../src/gui/config-io.js';
import { allAsyncOrSync } from '../../src/db/adapter.js';
import { readComputedState, AI_MAP_TABLE } from '../../src/schema/computed-fill.js';
import type { FillLlm } from '../../src/schema/computed-fill.js';
import type { ComputedTableDef } from '../../src/config/types.js';
import type { FeedEvent } from '../../src/gui/feed.js';

/**
 * The computed-table ops layer (SQLite, end-to-end against a real ActiveDb via
 * the test-only openConfig export): the audited create/update/delete flow with
 * YAML round-trip + lineage + feed + background fill, the no-side-effect
 * preview, refresh progress streaming, the computed-source guard on entity
 * deletes, and undo/redo round-trips through applySchemaConfig.
 */

const dirs: string[] = [];
const actives: ActiveDb[] = [];

afterEach(() => {
  for (const a of actives.splice(0)) a.db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Deterministic classifier/transform stand-in for the injected FillLlm. */
class FakeLlm implements FillLlm {
  calls: { system: string; user: string; model: string }[] = [];
  constructor(private readonly labelFor: Record<string, string | null> = {}) {}
  async complete(opts: { system: string; user: string; model: string }): Promise<string> {
    this.calls.push(opts);
    const valuesLine = opts.user.split('\n').find((l) => l.startsWith('Input values: '));
    if (valuesLine) {
      // Classifier batch: map every input value to its configured label (null = declined).
      const values = JSON.parse(valuesLine.slice('Input values: '.length)) as string[];
      return JSON.stringify(Object.fromEntries(values.map((v) => [v, this.labelFor[v] ?? null])));
    }
    return 'brief text';
  }
}

async function boot(): Promise<ActiveDb> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-computed-ops-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  tickets:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      status: { type: text }',
      '      priority: { type: integer }',
      '      assignee_id: { type: uuid }',
      '      deleted_at: { type: text }',
      '    relations:',
      '      assignee: { type: belongsTo, table: users, foreignKey: assignee_id }',
      '    outputFile: tickets.md',
      '  users:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '    outputFile: users.md',
      '  tags:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      label: { type: text }',
      '    outputFile: tags.md',
      '  ticket_tags:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      ticket_id: { type: uuid }',
      '      tag_id: { type: uuid }',
      '    relations:',
      '      ticket: { type: belongsTo, table: tickets, foreignKey: ticket_id }',
      '      tag: { type: belongsTo, table: tags, foreignKey: tag_id }',
      '    outputFile: ticket_tags.md',
      '',
    ].join('\n'),
    'utf8',
  );
  const active = await openConfig(configPath, join(root, 'context'), false);
  actives.push(active);
  // Deterministic model for every AI fill in these tests.
  active.computedFillLlm = () => new FakeLlm({ open: 'open', closed: 'closed' });
  return active;
}

async function seed(active: ActiveDb): Promise<{ t1: string; t2: string }> {
  const who = await active.db.insert('users', { name: 'Grace' });
  const t1 = await active.db.insert('tickets', {
    title: 'Fix crash',
    status: 'open',
    priority: 5,
    assignee_id: who,
  });
  const t2 = await active.db.insert('tickets', {
    title: 'Docs pass',
    status: 'closed',
    priority: 1,
  });
  const tag = await active.db.insert('tags', { label: 'bug' });
  await active.db.insert('ticket_tags', { ticket_id: t1, tag_id: tag });
  return { t1, t2 };
}

const summaryDef: ComputedTableDef = {
  base: 'tickets',
  fields: {
    title: { kind: 'alias', source: 'title' },
    who: { kind: 'alias', source: 'assignee.name' },
    urgent: { kind: 'calc', expr: 'priority >= 3', type: 'boolean' },
    tag_count: { kind: 'aggregate', via: 'ticket_tags.tag', fn: 'count' },
    mood: {
      kind: 'ai_classify',
      input: 'status',
      prompt: 'Classify the status.',
      labels: ['open', 'closed'],
    },
  },
};

/** Wait until a field's background fill settles to idle. */
async function awaitFillIdle(active: ActiveDb, table: string, field: string): Promise<void> {
  await vi.waitFor(async () => {
    const state = await readComputedState(active.db.adapter, table);
    const row = state.find((s) => s.field === field);
    expect(row?.status).toBe('idle');
  });
}

function guiCtx(active: ActiveDb): MutationCtx {
  return { db: active.db, feed: active.feed, softDeletable: active.softDeletable, source: 'gui' };
}

describe('computed-table ops — create', () => {
  it('creates end-to-end: queryable view, YAML round-trip, lineage, audit + feed, background fill', async () => {
    const active = await boot();
    const { t1, t2 } = await seed(active);
    const feedEvents: FeedEvent[] = [];
    active.feed.subscribe((e) => feedEvents.push(e));

    await createComputedTable(active, 'ticket_summary', summaryDef, 'sess');

    // Live-registered, tracked, and read-only.
    expect(active.db.isComputedTable('ticket_summary')).toBe(true);
    expect(active.computedTables.has('ticket_summary')).toBe(true);
    expect(active.validTables.has('ticket_summary')).toBe(true);

    // The view is queryable through the normal read path.
    const row = (await active.db.get('ticket_summary', t1)) as Record<string, unknown>;
    expect(row.title).toBe('Fix crash');
    expect(row.who).toBe('Grace');
    expect(Number(row.urgent)).toBe(1);
    expect(Number(row.tag_count)).toBe(1);
    expect(Number((await active.db.get('ticket_summary', t2))?.urgent)).toBe(0);

    // YAML round-trip: the definition persisted under computed: verbatim.
    const cfg = loadConfigDoc(active.configPath).toJS() as {
      computed?: Record<string, unknown>;
    };
    expect(cfg.computed?.ticket_summary).toEqual(summaryDef);
    expect((await listComputedTables(active)).map((t) => t.name)).toEqual(['ticket_summary']);

    // Lineage: one sql_source edge per source table + one calculation edge per AI field.
    const edges = (await allAsyncOrSync(
      active.db.adapter,
      `SELECT * FROM "__lattice_lineage" WHERE "object_table" = 'ticket_summary'`,
    )) as Record<string, unknown>[];
    const bySource = edges.filter((e) => e.source_kind === 'sql_source');
    expect(bySource.map((e) => e.source_table).sort()).toEqual([
      'tags',
      'ticket_tags',
      'tickets',
      'users',
    ]);
    for (const e of edges) {
      expect(e.tier).toBe('computed');
      expect(e.relation).toBe('computed_from');
      expect(e.object_id).toBe('*');
    }
    const calc = edges.find((e) => e.source_kind === 'calculation');
    expect(JSON.parse(String(calc?.detail_json))).toEqual({
      field: 'mood',
      kind: 'ai_classify',
      model: 'default',
    });

    // Audit op recorded (revertible payload) + feed event published.
    const audits = (await active.db.query('_lattice_gui_audit', {
      filters: [{ col: 'operation', op: 'eq', val: 'schema.create_computed' }],
    })) as Record<string, unknown>[];
    expect(audits).toHaveLength(1);
    expect(JSON.parse(String(audits[0]!.after_json))).toEqual({
      name: 'ticket_summary',
      def: summaryDef,
    });
    expect(feedEvents.some((e) => e.summary === 'Created computed table ticket_summary')).toBe(
      true,
    );

    // The background fill ran with the injected FillLlm and materialized labels.
    await awaitFillIdle(active, 'ticket_summary', 'mood');
    expect((await active.db.get('ticket_summary', t1))?.mood).toBe('open');
    expect((await active.db.get('ticket_summary', t2))?.mood).toBe('closed');
  });

  it('refuses collisions and invalid names loudly', async () => {
    const active = await boot();
    const def: ComputedTableDef = {
      base: 'tickets',
      fields: { t: { kind: 'alias', source: 'title' } },
    };
    await expect(createComputedTable(active, 'tickets', def, 's')).rejects.toThrow(
      /already exists/,
    );
    await expect(createComputedTable(active, 'files', def, 's')).rejects.toThrow(/built-in/);
    await expect(createComputedTable(active, 'bad name!', def, 's')).rejects.toThrow(
      /valid identifier/,
    );
    // A compile failure (unknown column) never half-creates anything.
    await expect(
      createComputedTable(
        active,
        'broken',
        { base: 'tickets', fields: { x: { kind: 'alias', source: 'nope' } } },
        's',
      ),
    ).rejects.toThrow(/no column "nope"/);
    expect(active.db.getRegisteredTableNames()).not.toContain('broken');
    const cfg = loadConfigDoc(active.configPath).toJS() as { computed?: Record<string, unknown> };
    expect(cfg.computed?.broken).toBeUndefined();
    // No orphaned error-state row for a table that was never created.
    expect(await readComputedState(active.db.adapter, 'broken')).toEqual([]);
  });

  it('row writes get the friendly refusal at the mutation chokepoint', async () => {
    const active = await boot();
    await seed(active);
    await createComputedTable(active, 'ticket_summary', summaryDef, 'sess');
    await awaitFillIdle(active, 'ticket_summary', 'mood');
    await expect(createRow(guiCtx(active), 'ticket_summary', { title: 'x' })).rejects.toThrow(
      /"ticket_summary" is a computed view and can't be edited directly/,
    );
  });
});

describe('computed-table ops — preview', () => {
  it('dry-runs a definition with NO view DDL, no YAML write, and no audit entry', async () => {
    const active = await boot();
    await seed(active);
    const auditCountBefore = await active.db.count('_lattice_gui_audit');

    const preview = await previewComputedTable(active, {
      base: 'tickets',
      fields: {
        headline: { kind: 'alias', source: 'title' },
        brief: { kind: 'ai_transform', inputs: ['title', 'status'], prompt: 'Summarize.' },
      },
    });

    expect(preview.columns).toEqual(['id', 'headline', 'brief']);
    expect(preview.rows).toHaveLength(2);
    expect(preview.sql).toContain('SELECT');
    expect(preview.fieldTypes.headline).toBe('text');
    // Both rows are unfilled work for the (never-run) transform.
    expect(preview.pendingAi).toEqual({ brief: 2 });

    // No view was created, nothing persisted, nothing audited.
    const views = await allAsyncOrSync(
      active.db.adapter,
      `SELECT name FROM sqlite_master WHERE type = 'view'`,
    );
    expect(views).toHaveLength(0);
    const cfg = loadConfigDoc(active.configPath).toJS() as { computed?: Record<string, unknown> };
    expect(cfg.computed).toBeUndefined();
    expect(await active.db.count('_lattice_gui_audit')).toBe(auditCountBefore);
  });

  it('respects the row cap', async () => {
    const active = await boot();
    await seed(active);
    const preview = await previewComputedTable(
      active,
      { base: 'tickets', fields: { t: { kind: 'alias', source: 'title' } } },
      1,
    );
    expect(preview.rows).toHaveLength(1);
    expect(preview.pendingAi).toEqual({});
  });
});

describe('computed-table ops — update', () => {
  it('recompiles, recreates dependents, and purges ONLY the AI fields whose definition changed', async () => {
    const active = await boot();
    const { t2 } = await seed(active);
    await createComputedTable(active, 'ticket_summary', summaryDef, 'sess');
    await awaitFillIdle(active, 'ticket_summary', 'mood');
    // A dependent computed table built ON the first one.
    await createComputedTable(
      active,
      'ticket_brief',
      { base: 'ticket_summary', fields: { headline: { kind: 'alias', source: 'title' } } },
      'sess',
    );

    // 1) Change only the calc expression — the untouched AI field keeps its cache.
    const withWiderUrgent: ComputedTableDef = {
      ...summaryDef,
      fields: {
        ...summaryDef.fields,
        urgent: { kind: 'calc', expr: 'priority >= 1', type: 'boolean' },
      },
    };
    await updateComputedTable(active, 'ticket_summary', withWiderUrgent, 'sess');
    expect(Number((await active.db.get('ticket_summary', t2))?.urgent)).toBe(1); // recompiled
    expect((await active.db.get('ticket_summary', t2))?.mood).toBe('closed'); // cache intact
    // The dependent was dropped + recreated and still reads through.
    expect((await active.db.query('ticket_brief')).length).toBe(2);
    expect(active.db.isComputedTable('ticket_brief')).toBe(true);

    // 2) Change the AI field's prompt — its cache is purged for re-derivation.
    const withNewPrompt: ComputedTableDef = {
      ...withWiderUrgent,
      fields: {
        ...withWiderUrgent.fields,
        mood: {
          kind: 'ai_classify',
          input: 'status',
          prompt: 'Classify the CURRENT status.',
          labels: ['open', 'closed'],
        },
      },
    };
    await updateComputedTable(active, 'ticket_summary', withNewPrompt, 'sess');
    await awaitFillIdle(active, 'ticket_summary', 'mood'); // refill was kicked
    const audits = (await active.db.query('_lattice_gui_audit', {
      filters: [{ col: 'operation', op: 'eq', val: 'schema.update_computed' }],
    })) as Record<string, unknown>[];
    expect(audits).toHaveLength(2);
    const last = JSON.parse(String(audits[1]!.before_json)) as { def: ComputedTableDef };
    expect(last.def).toEqual(withWiderUrgent); // before/after defs captured

    // 3) A bad update is rejected BEFORE anything is dropped.
    await expect(
      updateComputedTable(
        active,
        'ticket_summary',
        { base: 'tickets', fields: { x: { kind: 'alias', source: 'nope' } } },
        'sess',
      ),
    ).rejects.toThrow(/no column "nope"/);
    expect((await active.db.query('ticket_summary')).length).toBe(2); // untouched
  });
});

describe('computed-table ops — delete', () => {
  it('refuses while dependents exist, then deletes with YAML removal + full AI purge', async () => {
    const active = await boot();
    await seed(active);
    await createComputedTable(active, 'ticket_summary', summaryDef, 'sess');
    await awaitFillIdle(active, 'ticket_summary', 'mood');
    await createComputedTable(
      active,
      'ticket_brief',
      { base: 'ticket_summary', fields: { headline: { kind: 'alias', source: 'title' } } },
      'sess',
    );

    await expect(deleteComputedTable(active, 'ticket_summary', 'sess')).rejects.toThrow(
      /ticket_brief/,
    );

    await deleteComputedTable(active, 'ticket_brief', 'sess');
    await deleteComputedTable(active, 'ticket_summary', 'sess');

    // Gone from the registry, the YAML, and the physical schema.
    expect(active.db.getRegisteredTableNames()).not.toContain('ticket_summary');
    expect(active.computedTables.size).toBe(0);
    const cfg = loadConfigDoc(active.configPath).toJS() as { computed?: Record<string, unknown> };
    expect(cfg.computed ?? {}).toEqual({});
    const views = await allAsyncOrSync(
      active.db.adapter,
      `SELECT name FROM sqlite_master WHERE type = 'view'`,
    );
    expect(views).toHaveLength(0);

    // AI cache + fill state fully purged.
    const mapRows = await allAsyncOrSync(
      active.db.adapter,
      `SELECT * FROM "${AI_MAP_TABLE}" WHERE "field_key" LIKE 'ticket_summary.%'`,
    );
    expect(mapRows).toHaveLength(0);
    expect(await readComputedState(active.db.adapter, 'ticket_summary')).toEqual([]);

    const audits = (await active.db.query('_lattice_gui_audit', {
      filters: [{ col: 'operation', op: 'eq', val: 'schema.delete_computed' }],
    })) as Record<string, unknown>[];
    expect(audits).toHaveLength(2);
  });
});

describe('computed-table ops — refresh', () => {
  it('streams per-field progress and records an informational audit entry', async () => {
    const active = await boot();
    await seed(active);
    await createComputedTable(active, 'ticket_summary', summaryDef, 'sess');
    await awaitFillIdle(active, 'ticket_summary', 'mood');
    // New distinct value → one pending classifier item for the refresh.
    await active.db.insert('tickets', { title: 'Spike', status: 'blocked', priority: 2 });

    const events: { phase: string; field: string }[] = [];
    const results = await refreshComputedTable(
      active,
      'ticket_summary',
      { sessionId: 'sess' },
      (p) => events.push({ phase: p.phase, field: p.field }),
    );
    expect(events).toEqual([
      { phase: 'field', field: 'mood' },
      { phase: 'field-done', field: 'mood' },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ field: 'mood', status: 'idle', filled: 1, pending: 0 });

    const audits = (await active.db.query('_lattice_gui_audit', {
      filters: [{ col: 'operation', op: 'eq', val: 'schema.refresh_computed' }],
    })) as Record<string, unknown>[];
    expect(audits).toHaveLength(1);

    await expect(refreshComputedTable(active, 'nope', {})).rejects.toThrow(/Unknown computed/);
    await expect(
      refreshComputedTable(active, 'ticket_summary', { fields: ['not_a_field'] }),
    ).rejects.toThrow(/no AI field/);
  });
});

describe('computed-table ops — source guards + pickers', () => {
  it('entity deletes are refused while a computed table reads from the entity', async () => {
    const active = await boot();
    await seed(active);
    await createComputedTable(active, 'ticket_summary', summaryDef, 'sess');
    await awaitFillIdle(active, 'ticket_summary', 'mood');

    // The direct chokepoint…
    expect(() => {
      assertNotComputedSource(active, 'tickets');
    }).toThrow(/ticket_summary/);
    await expect(softDeleteUserEntity(active, 'tags', 'sess')).rejects.toThrow(/ticket_summary/);
    // …and the assistant's guarded delete (a friendly refusal, not a throw).
    const out = await aiDeleteEntity(active, 'users', undefined, 'sess');
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toContain('ticket_summary');
    expect(active.validTables.has('users')).toBe(true); // untouched

    // Deleting the computed table itself via the ENTITY path is redirected.
    const asEntity = await aiDeleteEntity(active, 'ticket_summary', undefined, 'sess');
    expect(asEntity).toMatchObject({ ok: false });
    expect((asEntity as { error: string }).error).toMatch(/computed view/);
  });

  it('reachableFields lists base columns, belongsTo paths, and junction aggregates', async () => {
    const active = await boot();
    const fields = reachableFields(active, 'tickets');
    const paths = fields.map((f) => f.path);
    expect(paths).toContain('title');
    expect(paths).toContain('assignee.name');
    expect(paths).toContain('ticket_tags.tag');
    expect(paths).not.toContain('deleted_at');
    expect(fields.find((f) => f.path === 'ticket_tags.tag')?.via).toBe('aggregate');
    expect(fields.find((f) => f.path === 'assignee.name')?.via).toBe('relation');
    expect(fields.find((f) => f.path === 'priority')?.type).toBe('integer');

    expect(() => reachableFields(active, 'nope')).toThrow(/Unknown base/);
    expect(() => reachableFields(active, 'ticket_tags')).toThrow(/relationship table/);
  });
});

describe('computed-table ops — undo/redo', () => {
  const plainDef: ComputedTableDef = {
    base: 'tickets',
    fields: {
      headline: { kind: 'alias', source: 'title' },
      urgent: { kind: 'calc', expr: 'priority >= 3', type: 'boolean' },
    },
  };

  async function latestEntry(active: ActiveDb, operation: string) {
    const rows = (await active.db.query('_lattice_gui_audit', {
      filters: [{ col: 'operation', op: 'eq', val: operation }],
      orderBy: 'ts',
      orderDir: 'desc',
      limit: 1,
    })) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    return parseAudit(rows[0]!);
  }

  it('create ⁻¹ = delete, and forward re-creates — same ActiveDb, no reopen', async () => {
    const active = await boot();
    await seed(active);
    await createComputedTable(active, 'board', plainDef, 'sess');
    const entry = await latestEntry(active, 'schema.create_computed');

    const afterUndo = await applySchemaConfig(active, entry, 'inverse', false);
    expect(afterUndo).toBe(active); // live appliers — never a reopen
    expect(active.db.getRegisteredTableNames()).not.toContain('board');
    expect(
      (loadConfigDoc(active.configPath).toJS() as { computed?: Record<string, unknown> })
        .computed ?? {},
    ).toEqual({});

    await applySchemaConfig(active, entry, 'forward', false);
    expect(active.db.isComputedTable('board')).toBe(true);
    expect((await active.db.query('board')).length).toBe(2);
  });

  it('update ⁻¹ restores the prior definition; forward re-applies the new one', async () => {
    const active = await boot();
    const { t2 } = await seed(active);
    await createComputedTable(active, 'board', plainDef, 'sess');
    await updateComputedTable(
      active,
      'board',
      {
        ...plainDef,
        fields: {
          ...plainDef.fields,
          urgent: { kind: 'calc', expr: 'priority >= 1', type: 'boolean' },
        },
      },
      'sess',
    );
    expect(Number((await active.db.get('board', t2))?.urgent)).toBe(1);
    const entry = await latestEntry(active, 'schema.update_computed');

    await applySchemaConfig(active, entry, 'inverse', false);
    expect(Number((await active.db.get('board', t2))?.urgent)).toBe(0); // back on >= 3

    await applySchemaConfig(active, entry, 'forward', false);
    expect(Number((await active.db.get('board', t2))?.urgent)).toBe(1);
  });

  it('delete ⁻¹ re-creates from the captured definition; forward deletes again', async () => {
    const active = await boot();
    await seed(active);
    await createComputedTable(active, 'board', plainDef, 'sess');
    await deleteComputedTable(active, 'board', 'sess');
    const entry = await latestEntry(active, 'schema.delete_computed');

    await applySchemaConfig(active, entry, 'inverse', false);
    expect(active.db.isComputedTable('board')).toBe(true);
    expect((await active.db.query('board')).length).toBe(2);

    await applySchemaConfig(active, entry, 'forward', false);
    expect(active.db.getRegisteredTableNames()).not.toContain('board');
  });

  it('a refresh entry is informational — reverting it throws', async () => {
    const active = await boot();
    await seed(active);
    await createComputedTable(active, 'board', plainDef, 'sess');
    await refreshComputedTable(active, 'board', { sessionId: 'sess' });
    const entry = await latestEntry(active, 'schema.refresh_computed');
    await expect(applySchemaConfig(active, entry, 'inverse', false)).rejects.toThrow(
      /nothing to revert/,
    );
  });
});
