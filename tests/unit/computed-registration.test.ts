import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { allAsyncOrSync } from '../../src/db/adapter.js';
import { registerComputedTables } from '../../src/schema/computed-table.js';
import {
  AI_CELL_TABLE,
  AI_MAP_TABLE,
  COMPUTED_STATE_TABLE,
  countPending,
  recordComputedTableError,
  runComputedFill,
  type FillLlm,
} from '../../src/schema/computed-fill.js';
import type { ComputedTableDef } from '../../src/config/types.js';

const CONFIG_YAML = `
db: ./data.db
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text }
      priority: { type: integer }
      assignee_id: { type: uuid }
      deleted_at: { type: datetime }
    relations:
      assignee: { type: belongsTo, table: user, foreignKey: assignee_id }
    outputFile: tickets.md
  user:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text }
    outputFile: users.md
  ticket_tags:
    fields:
      id: { type: uuid, primaryKey: true }
      ticket_id: { type: uuid }
      tag_id: { type: uuid }
    relations:
      ticket: { type: belongsTo, table: ticket, foreignKey: ticket_id }
      tag: { type: belongsTo, table: tag, foreignKey: tag_id }
    outputFile: ticket_tags.md
  tag:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text }
    outputFile: tags.md
computed:
  # Declared BEFORE its base — registration must topo-sort computed→computed.
  urgent_board:
    base: ticket_summary
    fields:
      headline: { kind: alias, source: title }
      is_hot: { kind: calc, expr: "urgent = 1 AND tag_count > 0", type: boolean }
  ticket_summary:
    base: ticket
    description: Live ticket projection.
    fields:
      title: { kind: alias, source: title }
      who: { kind: alias, source: assignee.name }
      urgent: { kind: calc, expr: "priority >= 3", type: boolean }
      category: { kind: ai_classify, input: title, prompt: Categorize., labels: [bug, feature] }
      tag_count: { kind: aggregate, via: ticket_tags.tag, fn: count }
`;

describe('computed tables — SQLite registration end-to-end', () => {
  let dir: string;
  let configPath: string;
  let db: Lattice;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-computed-reg-'));
    configPath = join(dir, 'lattice.config.yml');
    writeFileSync(configPath, CONFIG_YAML);
    db = new Lattice({ config: configPath });
    await db.init();
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers the computed tables in topological order', async () => {
    expect(db.getRegisteredTableNames()).toContain('ticket_summary');
    expect(db.isComputedTable('ticket_summary')).toBe(true);
    expect(db.isComputedTable('ticket')).toBe(false);
    const reg = db.getComputedRegistration();
    // urgent_board is declared first but based on ticket_summary — its base
    // must compile and register before it.
    expect(reg?.registered).toEqual(['ticket_summary', 'urgent_board']);
    expect(reg?.errors).toEqual([]);
    expect(db.getComputedTableNames()).toEqual(['ticket_summary', 'urgent_board']);
    expect(await db.query('ticket_summary')).toEqual([]);
  });

  it('serves a computed table built on another computed table', async () => {
    const userId = await db.insert('user', { name: 'Lin' });
    const hotId = await db.insert('ticket', {
      title: 'Prod is down',
      priority: 5,
      assignee_id: userId,
    });
    const tagId = await db.insert('tag', { name: 'outage' });
    await db.insert('ticket_tags', { ticket_id: hotId, tag_id: tagId });
    const coldId = await db.insert('ticket', { title: 'Typo in docs', priority: 1 });

    expect(await db.get('urgent_board', hotId)).toMatchObject({
      headline: 'Prod is down',
      is_hot: 1,
    });
    expect(await db.get('urgent_board', coldId)).toMatchObject({
      headline: 'Typo in docs',
      is_hot: 0,
    });

    await db.delete('ticket_tags', (await db.query('ticket_tags'))[0]?.id as string);
    expect((await db.get('urgent_board', hotId))?.is_hot).toBe(0);
    await db.delete('ticket', hotId);
    await db.delete('ticket', coldId);
  });

  it('reflects base inserts and updates live through the normal query path', async () => {
    const userId = await db.insert('user', { name: 'Ada' });
    const ticketId = await db.insert('ticket', {
      title: 'Broken build',
      priority: 4,
      assignee_id: userId,
    });
    const tagId = await db.insert('tag', { name: 'ci' });
    await db.insert('ticket_tags', { ticket_id: ticketId, tag_id: tagId });

    let row = await db.get('ticket_summary', ticketId);
    expect(row).toMatchObject({
      id: ticketId,
      title: 'Broken build',
      who: 'Ada',
      urgent: 1,
      category: null, // AI field unfilled → NULL, never a model call at read time
      tag_count: 1,
    });

    await db.update('ticket', ticketId, { priority: 1 });
    row = await db.get('ticket_summary', ticketId);
    expect(row?.urgent).toBe(0);

    // Soft-deleting the base row removes it from the projection.
    await db.update('ticket', ticketId, { deleted_at: new Date().toISOString() });
    expect(await db.get('ticket_summary', ticketId)).toBeNull();
    await db.update('ticket', ticketId, { deleted_at: null });
    expect(await db.get('ticket_summary', ticketId)).not.toBeNull();
  });

  it('refuses every direct write with a clear error', async () => {
    const refusal = /read-only projection/;
    await expect(db.insert('ticket_summary', { title: 'x' })).rejects.toThrow(refusal);
    await expect(db.update('ticket_summary', 'any', { title: 'x' })).rejects.toThrow(refusal);
    await expect(db.delete('ticket_summary', 'any')).rejects.toThrow(refusal);
    await expect(db.upsert('ticket_summary', { id: 'x' })).rejects.toThrow(refusal);
    await expect(db.upsertBy('ticket_summary', 'title', 'x', {})).rejects.toThrow(refusal);
    await expect(db.upsertByNaturalKey('ticket_summary', 'title', 'x', {})).rejects.toThrow(
      refusal,
    );
    await expect(db.insertReturning('ticket_summary', { title: 'x' })).rejects.toThrow(refusal);
    // The junction + sync write paths refuse identically — never a raw driver
    // error surfaced from writing into a view.
    await expect(db.link('ticket_summary', { ticket_id: 'x' })).rejects.toThrow(refusal);
    await expect(db.unlink('ticket_summary', { title: 'x' })).rejects.toThrow(refusal);
    await expect(db.enrichByNaturalKey('ticket_summary', 'title', 'x', {})).rejects.toThrow(
      refusal,
    );
    await expect(db.softDeleteMissing('ticket_summary', 'title', 'src.csv', ['k'])).rejects.toThrow(
      refusal,
    );
  });

  it('re-registers on re-open (drop + recreate is idempotent)', async () => {
    const before = await db.query('ticket_summary');
    db.close();
    db = new Lattice({ config: configPath });
    await db.init();
    expect(db.isComputedTable('ticket_summary')).toBe(true);
    const after = await db.query('ticket_summary');
    expect(after).toEqual(before);
  });

  it('records display metadata for the registered view', () => {
    const types = db.getRegisteredFieldTypes('ticket_summary');
    expect(types).toMatchObject({ id: 'uuid', urgent: 'boolean', tag_count: 'integer' });
    expect(db.getPrimaryKey('ticket_summary')).toEqual(['id']);
  });
});

describe('computed tables — a failing definition never bricks the open', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-computed-fail-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips the failed table, records the error, and registers the rest', async () => {
    // First life: "blocked_view" exists as a PHYSICAL table in the database.
    const firstConfig = join(dir, 'first.config.yml');
    writeFileSync(
      firstConfig,
      `
db: ./data.db
entities:
  blocked_view:
    fields:
      id: { type: uuid, primaryKey: true }
    outputFile: blocked.md
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text }
    outputFile: tickets.md
`,
    );
    const first = new Lattice({ config: firstConfig });
    await first.init();
    first.close();

    // Second life: the config now declares "blocked_view" as a COMPUTED table.
    // CREATE VIEW collides with the leftover physical table and must fail —
    // without failing the open or the other computed table.
    const secondConfig = join(dir, 'second.config.yml');
    writeFileSync(
      secondConfig,
      `
db: ./data.db
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text }
    outputFile: tickets.md
computed:
  blocked_view:
    base: ticket
    fields:
      t: { kind: alias, source: title }
  ok_view:
    base: ticket
    fields:
      t: { kind: alias, source: title }
`,
    );
    const db = new Lattice({ config: secondConfig });
    await db.init(); // must not throw

    try {
      const reg = db.getComputedRegistration();
      expect(reg?.registered).toEqual(['ok_view']);
      expect(reg?.errors).toHaveLength(1);
      expect(reg?.errors[0]?.table).toBe('blocked_view');
      expect(db.isComputedTable('blocked_view')).toBe(false);
      expect(db.isComputedTable('ok_view')).toBe(true);

      // The failure is recorded under field '*' in the state table.
      const state = await allAsyncOrSync(
        db.adapter,
        `SELECT * FROM "${COMPUTED_STATE_TABLE}" WHERE "table_name" = 'blocked_view'`,
      );
      expect(state).toHaveLength(1);
      expect(state[0]).toMatchObject({ field: '*', status: 'error' });

      // The rest of the database is fully usable.
      const id = await db.insert('ticket', { title: 'still works' });
      expect((await db.get('ok_view', id))?.t).toBe('still works');
    } finally {
      db.close();
    }
  });
});

describe('computed tables — config edits invalidate stale AI values (prompt_hash)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-computed-stale-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const config = (labels: string, transformPrompt: string) => `
db: ./data.db
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text }
      status: { type: text }
    outputFile: tickets.md
computed:
  summary:
    base: ticket
    fields:
      title: { kind: alias, source: title }
      category: { kind: ai_classify, input: status, prompt: Categorize., labels: [${labels}] }
      brief: { kind: ai_transform, inputs: [title], prompt: ${transformPrompt} }
`;

  /** Deterministic model: classifiers get a null (declined) per value, transforms a constant. */
  class FakeLlm implements FillLlm {
    async complete(opts: { system: string; user: string; model: string }): Promise<string> {
      const line = opts.user.split('\n').find((l) => l.startsWith('Input values: '));
      if (line) {
        const values = JSON.parse(line.slice('Input values: '.length)) as string[];
        return JSON.stringify(Object.fromEntries(values.map((v) => [v, null])));
      }
      return 'a brief';
    }
  }

  const mapRows = (db: Lattice) =>
    allAsyncOrSync(
      db.adapter,
      `SELECT * FROM "${AI_MAP_TABLE}" WHERE "field_key" = 'summary.category'`,
    );
  const cellRows = (db: Lattice) =>
    allAsyncOrSync(
      db.adapter,
      `SELECT * FROM "${AI_CELL_TABLE}" WHERE "field_key" = 'summary.brief'`,
    );

  it("purges exactly the changed field's cache on the next open — no matter which path edited the definition", async () => {
    const cfg = join(dir, 'lattice.config.yml');
    writeFileSync(cfg, config('open, closed', 'Summarize.'));
    let db = new Lattice({ config: cfg });
    await db.init();
    await db.insert('ticket', { title: 'A', status: 'open' });
    await db.insert('ticket', { title: 'B', status: 'closed' });
    const compiled = db.getComputedRegistration()?.compiled.get('summary');
    expect(compiled).toBeDefined();
    await runComputedFill(db.adapter, new FakeLlm(), compiled!);
    expect(await mapRows(db)).toHaveLength(2);
    expect(await cellRows(db)).toHaveLength(2);
    db.close();

    // 1) The classifier's LABELS change via a hand-edited config (no ops-layer
    //    involvement). The stored prompt_hash no longer matches → the map is
    //    purged and the values re-pend; the untouched transform keeps its cache.
    writeFileSync(cfg, config('open, closed, blocked', 'Summarize.'));
    db = new Lattice({ config: cfg });
    await db.init();
    expect(db.getComputedRegistration()?.errors).toEqual([]);
    expect(await mapRows(db)).toHaveLength(0);
    expect(await cellRows(db)).toHaveLength(2);
    const category = db
      .getComputedRegistration()!
      .compiled.get('summary')!
      .aiFields.find((f) => f.field === 'category')!;
    expect(await countPending(db.adapter, category)).toBe(2); // re-pending, not stale-serving
    db.close();

    // 2) The transform's PROMPT changes → its per-row cells are purged too.
    writeFileSync(cfg, config('open, closed, blocked', 'Summarize BRIEFLY.'));
    db = new Lattice({ config: cfg });
    await db.init();
    expect(db.getComputedRegistration()?.errors).toEqual([]);
    expect(await cellRows(db)).toHaveLength(0);
    const brief = db
      .getComputedRegistration()!
      .compiled.get('summary')!
      .aiFields.find((f) => f.field === 'brief')!;
    expect(await countPending(db.adapter, brief)).toBe(2);
    db.close();

    // 3) A converged re-open (nothing changed) purges nothing.
    db = new Lattice({ config: cfg });
    await db.init();
    const compiled3 = db.getComputedRegistration()?.compiled.get('summary');
    await runComputedFill(db.adapter, new FakeLlm(), compiled3!);
    expect(await cellRows(db)).toHaveLength(2);
    db.close();
    db = new Lattice({ config: cfg });
    await db.init();
    expect(await cellRows(db)).toHaveLength(2); // survived the re-open
    db.close();
  });
});

describe('computed tables — registration IO is batched (pooled-connection cost)', () => {
  it('issues no state DELETE when no error was recorded, and one batched DELETE when one was', async () => {
    const db = new Lattice(':memory:');
    db.define('note', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    await db.init();
    try {
      // Statement-logging wrapper over the live adapter — every read/write the
      // registration issues is observable, sync and async surfaces alike.
      const statements: string[] = [];
      const real = db.adapter;
      const logged = new Set(['run', 'get', 'all', 'runAsync', 'getAsync', 'allAsync']);
      const adapter = new Proxy(real, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof prop === 'string' && logged.has(prop) && typeof value === 'function') {
            return (sql: string, params?: unknown[]) => {
              statements.push(sql);
              return (value as (s: string, p?: unknown[]) => unknown).call(target, sql, params);
            };
          }
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
      const host = {
        adapter,
        migrate: async () => {
          /* sqlite path never migrates */
        },
        introspectColumns: (t: string) => db.introspectColumns(t),
        register: () => {
          /* live registration is the Lattice host's job — not under test */
        },
      };
      const defs: Record<string, ComputedTableDef> = {
        board: { base: 'note', fields: { headline: { kind: 'alias', source: 'title' } } },
      };

      const first = await registerComputedTables(host, defs, {
        schema: db.computedSchemaLookup(),
        dialect: 'sqlite',
      });
      expect(first.errors).toEqual([]);
      // Nothing was ever recorded → success cleanup must not issue any DELETE.
      expect(statements.filter((s) => s.includes(`DELETE FROM "${COMPUTED_STATE_TABLE}"`))).toEqual(
        [],
      );

      // A prior open recorded a registration error → cleared by ONE batched,
      // keyed DELETE (never an unconditional per-table statement).
      await recordComputedTableError(real, 'board', 'boom');
      statements.length = 0;
      const second = await registerComputedTables(host, defs, {
        schema: db.computedSchemaLookup(),
        dialect: 'sqlite',
      });
      expect(second.errors).toEqual([]);
      const deletes = statements.filter((s) => s.includes(`DELETE FROM "${COMPUTED_STATE_TABLE}"`));
      expect(deletes).toHaveLength(1);
      expect(deletes[0]).toContain('IN (');
      expect(
        await allAsyncOrSync(
          real,
          `SELECT * FROM "${COMPUTED_STATE_TABLE}" WHERE "table_name" = 'board'`,
        ),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('introspects all computed views in ONE batched round-trip, not one per table', async () => {
    const db = new Lattice(':memory:');
    db.define('note', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', body: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    await db.init();
    try {
      let batchCalls = 0;
      const batchTables: string[][] = [];
      let perTableCalls = 0;
      const host = {
        adapter: db.adapter,
        migrate: async () => {
          /* sqlite path never migrates */
        },
        introspectColumns: (t: string) => {
          perTableCalls++;
          return db.introspectColumns(t);
        },
        introspectAllColumns: async (tables: string[]) => {
          batchCalls++;
          batchTables.push([...tables]);
          const map = new Map<string, Set<string>>();
          for (const t of tables) {
            const cols = await db.introspectColumns(t);
            if (cols.length > 0) map.set(t, new Set(cols));
          }
          return map;
        },
        register: () => {
          /* not under test */
        },
      };
      const defs: Record<string, ComputedTableDef> = {
        a: { base: 'note', fields: { x: { kind: 'alias', source: 'title' } } },
        b: { base: 'note', fields: { y: { kind: 'alias', source: 'body' } } },
        c: { base: 'note', fields: { z: { kind: 'alias', source: 'title' } } },
      };

      const res = await registerComputedTables(host, defs, {
        schema: db.computedSchemaLookup(),
        dialect: 'sqlite',
      });
      expect(res.errors).toEqual([]);
      expect([...res.registered].sort()).toEqual(['a', 'b', 'c']);
      // The batch primitive was called exactly ONCE, covering all three views —
      // NOT one serial introspect per table (the pooled-cloud round-trip cost).
      expect(batchCalls).toBe(1);
      expect(batchTables[0]?.slice().sort()).toEqual(['a', 'b', 'c']);
      expect(perTableCalls).toBe(0);
    } finally {
      db.close();
    }
  });
});
