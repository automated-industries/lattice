import { describe, it, expect } from 'vitest';
import {
  compileComputedTable,
  computedTableOrder,
  ComputedTableCycleError,
} from '../../src/schema/computed-table.js';
import type { ComputedSchemaTable } from '../../src/schema/computed-table.js';
import type { ComputedTableDef } from '../../src/config/types.js';

/** Schema fixture: tickets → users → teams, plus a ticket↔tag junction. */
function schema(): Map<string, ComputedSchemaTable> {
  return new Map<string, ComputedSchemaTable>([
    [
      'ticket',
      {
        columns: new Set([
          'id',
          'title',
          'status',
          'priority',
          'estimate',
          'assignee_id',
          'deleted_at',
        ]),
        relations: { assignee: { type: 'belongsTo', table: 'user', foreignKey: 'assignee_id' } },
        primaryKey: ['id'],
        hasDeletedAt: true,
        fieldTypes: { id: 'uuid', title: 'text', priority: 'integer', estimate: 'real' },
      },
    ],
    [
      'user',
      {
        columns: new Set(['id', 'name', 'team_id', 'deleted_at']),
        relations: { team: { type: 'belongsTo', table: 'team', foreignKey: 'team_id' } },
        primaryKey: ['id'],
        hasDeletedAt: true,
      },
    ],
    [
      'team',
      {
        columns: new Set(['id', 'name']),
        relations: {},
        primaryKey: ['id'],
        hasDeletedAt: false,
      },
    ],
    [
      'ticket_tags',
      {
        columns: new Set(['id', 'ticket_id', 'tag_id', 'deleted_at']),
        relations: {
          ticket: { type: 'belongsTo', table: 'ticket', foreignKey: 'ticket_id' },
          tag: { type: 'belongsTo', table: 'tag', foreignKey: 'tag_id' },
        },
        primaryKey: ['id'],
        hasDeletedAt: true,
      },
    ],
    [
      'tag',
      {
        columns: new Set(['id', 'name', 'weight', 'deleted_at']),
        relations: {},
        primaryKey: ['id'],
        hasDeletedAt: true,
        fieldTypes: { name: 'text', weight: 'integer' },
      },
    ],
  ]);
}

const FULL_DEF: ComputedTableDef = {
  base: 'ticket',
  fields: {
    title: { kind: 'alias', source: 'title' },
    team: { kind: 'alias', source: 'assignee.team.name' },
    who: { kind: 'alias', source: 'assignee.name' },
    urgent: { kind: 'calc', expr: 'priority >= 3', type: 'boolean' },
    category: {
      kind: 'ai_classify',
      input: 'title',
      prompt: 'Categorize.',
      labels: ['bug', 'feature'],
    },
    summary: { kind: 'ai_transform', inputs: ['title', 'status'], prompt: 'Summarize.' },
    tag_count: { kind: 'aggregate', via: 'ticket_tags.tag', fn: 'count' },
    tag_names: { kind: 'aggregate', via: 'ticket_tags.tag', fn: 'concat', column: 'name' },
  },
};

describe('compileComputedTable — SQL shape', () => {
  it('projects the base pk as id first, fields in declaration order', () => {
    const c = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'sqlite');
    expect(c.viewName).toBe('ticket_summary');
    expect(c.columns).toEqual([
      'id',
      'title',
      'team',
      'who',
      'urgent',
      'category',
      'summary',
      'tag_count',
      'tag_names',
    ]);
    expect(c.selectSql.startsWith('SELECT "b"."id" AS "id", "b"."title" AS "title"')).toBe(true);
  });

  it('assigns deterministic join aliases in sorted-path order', () => {
    const c = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'sqlite');
    // 'assignee' < 'assignee.team' → j1 = user, j2 = team.
    expect(c.selectSql).toContain(
      'LEFT JOIN "user" "j1" ON "j1"."id" = "b"."assignee_id" AND "j1"."deleted_at" IS NULL',
    );
    expect(c.selectSql).toContain('LEFT JOIN "team" "j2" ON "j2"."id" = "j1"."team_id"');
    // team has no deleted_at → its ON clause must not filter on it.
    expect(c.selectSql).not.toContain('"j2"."deleted_at"');
    // Both alias fields project through the compiled aliases.
    expect(c.selectSql).toContain('"j2"."name" AS "team"');
    expect(c.selectSql).toContain('"j1"."name" AS "who"');
  });

  it('join aliases do not depend on field declaration order (byte-stable recompiles)', () => {
    const reordered: ComputedTableDef = {
      base: 'ticket',
      fields: {
        // Deepest path declared FIRST — aliases must still sort by path.
        team: { kind: 'alias', source: 'assignee.team.name' },
        who: { kind: 'alias', source: 'assignee.name' },
      },
    };
    const c = compileComputedTable('v', reordered, schema(), 'sqlite');
    expect(c.selectSql).toContain('LEFT JOIN "user" "j1"');
    expect(c.selectSql).toContain('LEFT JOIN "team" "j2"');
  });

  it('filters soft-deleted base rows in WHERE', () => {
    const c = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'sqlite');
    expect(c.selectSql).toContain('WHERE "b"."deleted_at" IS NULL');
  });

  it('omits the WHERE clause when the base has no deleted_at', () => {
    const c = compileComputedTable(
      'team_view',
      { base: 'team', fields: { label: { kind: 'alias', source: 'name' } } },
      schema(),
      'sqlite',
    );
    expect(c.selectSql).not.toContain('WHERE');
  });

  it('compiles calc fields through the sandboxed expression language', () => {
    const c = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'sqlite');
    expect(c.selectSql).toContain('("b"."priority" >= 3) AS "urgent"');
    expect(c.fieldTypes.urgent).toBe('boolean');
  });

  it('joins __lattice_ai_map for classify fields on the CAST input', () => {
    const c = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'sqlite');
    expect(c.selectSql).toContain(
      `LEFT JOIN "__lattice_ai_map" "m1" ON "m1"."field_key" = 'ticket_summary.category' ` +
        `AND "m1"."input_value" = CAST("b"."title" AS TEXT)`,
    );
    expect(c.selectSql).toContain('"m1"."label" AS "category"');
  });

  it('joins __lattice_ai_cell for transform fields with the ordered input key', () => {
    const sqlite = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'sqlite');
    const inputKeySqlite = `COALESCE(CAST("b"."title" AS TEXT), '') || CHAR(31) || COALESCE(CAST("b"."status" AS TEXT), '')`;
    expect(sqlite.selectSql).toContain(
      `LEFT JOIN "__lattice_ai_cell" "c1" ON "c1"."field_key" = 'ticket_summary.summary' ` +
        `AND "c1"."row_id" = CAST("b"."id" AS TEXT) AND "c1"."input_key" = ${inputKeySqlite}`,
    );
    expect(sqlite.selectSql).toContain('"c1"."output" AS "summary"');

    const pg = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'postgres');
    expect(pg.selectSql).toContain('CHR(31)');
    expect(pg.selectSql).not.toContain('CHAR(31)');
  });

  it('compiles aggregates to correlated subqueries with deleted_at folding', () => {
    const c = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'sqlite');
    expect(c.selectSql).toContain(
      '(SELECT COUNT(*) FROM "ticket_tags" "x1" ' +
        'JOIN "tag" "x2" ON "x2"."id" = "x1"."tag_id" AND "x2"."deleted_at" IS NULL ' +
        'WHERE "x1"."ticket_id" = "b"."id" AND "x1"."deleted_at" IS NULL) AS "tag_count"',
    );
    expect(c.fieldTypes.tag_count).toBe('integer');
  });

  it('emits concat aggregates per dialect', () => {
    const sqlite = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'sqlite');
    expect(sqlite.selectSql).toContain(`GROUP_CONCAT("x2"."name", ', ')`);
    const pg = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'postgres');
    expect(pg.selectSql).toContain(`STRING_AGG(CAST("x2"."name" AS TEXT), ', ')`);
  });

  it('resolves the aggregate remote side by relation name or table name', () => {
    const byTable: ComputedTableDef = {
      base: 'ticket',
      fields: { n: { kind: 'aggregate', via: 'ticket_tags.tag', fn: 'count' } },
    };
    const byRelation: ComputedTableDef = {
      base: 'ticket',
      fields: { n: { kind: 'aggregate', via: 'ticket_tags.tag', fn: 'count' } },
    };
    expect(compileComputedTable('v1', byTable, schema(), 'sqlite').selectSql).toBe(
      compileComputedTable('v1', byRelation, schema(), 'sqlite').selectSql,
    );
  });

  it('uses DROP + CREATE (never CREATE OR REPLACE) for Postgres', () => {
    const c = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'postgres');
    expect(c.createSql).toContain('DROP VIEW IF EXISTS "ticket_summary";');
    expect(c.createSql).toContain('CREATE VIEW "ticket_summary" AS');
    expect(c.createSql).not.toContain('CREATE OR REPLACE');
  });

  it('produces a stable content hash: identical defs match, changed defs differ', () => {
    const a = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'sqlite');
    const b = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'sqlite');
    expect(a.createSql).toBe(b.createSql);
    expect(a.contentHash).toBe(b.contentHash);
    const changed = compileComputedTable(
      'ticket_summary',
      {
        ...FULL_DEF,
        fields: { ...FULL_DEF.fields, urgent: { kind: 'calc', expr: 'priority >= 4' } },
      },
      schema(),
      'sqlite',
    );
    expect(changed.contentHash).not.toBe(a.contentHash);
  });

  it('lists sources: base + joined + junction + remote (no bookkeeping tables)', () => {
    const c = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'sqlite');
    expect(c.sources).toEqual(['ticket', 'user', 'team', 'ticket_tags', 'tag']);
  });

  it('reports display field types, including the projected id', () => {
    const c = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'sqlite');
    expect(c.fieldTypes.id).toBe('uuid');
    expect(c.fieldTypes.title).toBe('text');
    expect(c.fieldTypes.category).toBe('text');
    expect(c.fieldTypes.tag_names).toBe('text');
  });

  it('describes the AI fields with their fill queries', () => {
    const c = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'sqlite');
    const classify = c.aiFields.find((f) => f.kind === 'ai_classify');
    const transform = c.aiFields.find((f) => f.kind === 'ai_transform');
    expect(classify?.key).toBe('ticket_summary.category');
    expect(classify?.labels).toEqual(['bug', 'feature']);
    expect(classify?.pendingSql).toContain('SELECT DISTINCT CAST("b"."title" AS TEXT)');
    expect(classify?.pendingSql).toContain('NOT EXISTS');
    expect(transform?.key).toBe('ticket_summary.summary');
    expect(transform?.inputs).toEqual(['title', 'status']);
    expect(transform?.pendingSql).toContain('"cx"."row_id" IS NULL');
    // The pending query SELECTs the same input-key expression the view joins on.
    expect(transform?.inputKeySql).toBeDefined();
    expect(transform?.pendingSql).toContain(transform?.inputKeySql ?? '');
    expect(c.selectSql).toContain(transform?.inputKeySql ?? '');
  });
});

describe('compileComputedTable — cloud rowVisible variant', () => {
  it('adds lattice_row_visible to the base, every join, and aggregate subqueries', () => {
    const c = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'postgres', {
      rowVisible: true,
    });
    expect(c.selectSql).toContain(
      `WHERE "b"."deleted_at" IS NULL AND lattice_row_visible('ticket', CAST("b"."id" AS TEXT))`,
    );
    expect(c.selectSql).toContain(`lattice_row_visible('user', CAST("j1"."id" AS TEXT))`);
    expect(c.selectSql).toContain(`lattice_row_visible('team', CAST("j2"."id" AS TEXT))`);
    expect(c.selectSql).toContain(`lattice_row_visible('ticket_tags', CAST("x1"."id" AS TEXT))`);
    expect(c.selectSql).toContain(`lattice_row_visible('tag', CAST("x2"."id" AS TEXT))`);
  });

  it('adds no predicates without the cloud option', () => {
    const c = compileComputedTable('ticket_summary', FULL_DEF, schema(), 'postgres');
    expect(c.selectSql).not.toContain('lattice_row_visible');
  });
});

describe('compileComputedTable — validation errors', () => {
  const compile = (name: string, def: ComputedTableDef) =>
    compileComputedTable(name, def, schema(), 'sqlite');

  it('rejects an unknown base', () => {
    expect(() =>
      compile('v', { base: 'nope', fields: { a: { kind: 'alias', source: 'x' } } }),
    ).toThrow(/unknown base table "nope"/);
  });

  it('rejects unresolved alias paths segment by segment', () => {
    expect(() =>
      compile('v', { base: 'ticket', fields: { a: { kind: 'alias', source: 'nope' } } }),
    ).toThrow(/"ticket" has no column "nope"/);
    expect(() =>
      compile('v', { base: 'ticket', fields: { a: { kind: 'alias', source: 'assignee.nope' } } }),
    ).toThrow(/"user" has no column "nope"/);
    expect(() =>
      compile('v', { base: 'ticket', fields: { a: { kind: 'alias', source: 'nope.name' } } }),
    ).toThrow(/"ticket" has no belongsTo relation "nope"/);
  });

  it('rejects reserved-prefix and invalid names', () => {
    const def: ComputedTableDef = {
      base: 'ticket',
      fields: { a: { kind: 'alias', source: 'title' } },
    };
    expect(() => compile('__lattice_v', def)).toThrow(/reserved/i);
    expect(() => compile('bad name', def)).toThrow(/Invalid table name/);
  });

  it('rejects a name collision with an existing table', () => {
    expect(() =>
      compile('ticket', { base: 'user', fields: { a: { kind: 'alias', source: 'name' } } }),
    ).toThrow(/collides with an existing table/);
  });

  it('rejects a field named id and empty field sets', () => {
    expect(() =>
      compile('v', { base: 'ticket', fields: { id: { kind: 'alias', source: 'title' } } }),
    ).toThrow(/field "id" collides/);
    expect(() => compile('v', { base: 'ticket', fields: {} })).toThrow(/at least one field/);
  });

  it('rejects malformed calc expressions with the field named', () => {
    expect(() =>
      compile('v', {
        base: 'ticket',
        fields: { x: { kind: 'calc', expr: 'title; DROP TABLE x' } },
      }),
    ).toThrow(/field "x".*';' is not allowed/);
  });

  it('rejects bad aggregate specs', () => {
    expect(() =>
      compile('v', {
        base: 'ticket',
        fields: { n: { kind: 'aggregate', via: 'nope.tag', fn: 'count' } },
      }),
    ).toThrow(/unknown junction table "nope"/);
    expect(() =>
      compile('v', {
        base: 'team',
        fields: { n: { kind: 'aggregate', via: 'ticket_tags.tag', fn: 'count' } },
      }),
    ).toThrow(/no belongsTo relation to base "team"/);
    expect(() =>
      compile('v', {
        base: 'ticket',
        fields: { n: { kind: 'aggregate', via: 'ticket_tags.tag', fn: 'sum' } },
      }),
    ).toThrow(/requires a "column"/);
    expect(() =>
      compile('v', {
        base: 'ticket',
        fields: { n: { kind: 'aggregate', via: 'ticket_tags.tag', fn: 'count', column: 'name' } },
      }),
    ).toThrow(/remove "column"/);
    expect(() =>
      compile('v', {
        base: 'ticket',
        fields: { n: { kind: 'aggregate', via: 'ticket_tags.tag', fn: 'sum', column: 'nope' } },
      }),
    ).toThrow(/"tag" has no column "nope"/);
  });

  it('rejects empty prompts and empty label sets', () => {
    expect(() =>
      compile('v', {
        base: 'ticket',
        fields: { c: { kind: 'ai_classify', input: 'title', prompt: '  ', labels: ['a'] } },
      }),
    ).toThrow(/prompt must be a non-empty string/);
    expect(() =>
      compile('v', {
        base: 'ticket',
        fields: { c: { kind: 'ai_classify', input: 'title', prompt: 'p', labels: [] } },
      }),
    ).toThrow(/labels must be a non-empty array/);
  });
});

describe('computedTableOrder', () => {
  it('orders bases before dependents', () => {
    const defs: Record<string, ComputedTableDef> = {
      second: { base: 'first', fields: { a: { kind: 'alias', source: 'x' } } },
      first: { base: 'ticket', fields: { x: { kind: 'alias', source: 'title' } } },
    };
    const order = computedTableOrder(defs);
    expect(order.indexOf('first')).toBeLessThan(order.indexOf('second'));
  });

  it('throws a cycle error naming the cycle', () => {
    const defs: Record<string, ComputedTableDef> = {
      a: { base: 'b', fields: { x: { kind: 'alias', source: 'y' } } },
      b: { base: 'a', fields: { y: { kind: 'alias', source: 'x' } } },
    };
    expect(() => computedTableOrder(defs)).toThrowError(ComputedTableCycleError);
    expect(() => computedTableOrder(defs)).toThrow(/a → b → a|b → a → b/);
  });
});
