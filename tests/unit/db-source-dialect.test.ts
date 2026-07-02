import { describe, it, expect } from 'vitest';

import { PostgresDialect, dialectFor } from '../../src/connectors/db-source/dialects.js';
import {
  buildModelDefs,
  naturalKeyFor,
  latticeTableName,
  slugify,
  type DbSchemaDescriptor,
} from '../../src/connectors/db-source/schema-cache.js';

describe('PostgresDialect', () => {
  it('detects Postgres connection strings only', () => {
    expect(PostgresDialect.detect('postgres://u:p@h:5432/db')).toBe(true);
    expect(PostgresDialect.detect('postgresql://h/db')).toBe(true);
    expect(PostgresDialect.detect('mysql://h/db')).toBe(false);
    expect(dialectFor('postgres://h/db').id).toBe('postgres');
    expect(() => dialectFor('mysql://h/db')).toThrow(/Postgres-family/);
  });

  it('maps native types to a safe Lattice spec', () => {
    for (const t of ['integer', 'bigint', 'smallint', 'boolean', 'serial'])
      expect(PostgresDialect.mapType(t)).toBe('INTEGER');
    for (const t of ['numeric', 'real', 'double precision', 'money'])
      expect(PostgresDialect.mapType(t)).toBe('REAL');
    for (const t of [
      'text',
      'character varying',
      'uuid',
      'jsonb',
      'timestamp',
      'date',
      'ARRAY',
      'bytea',
    ])
      expect(PostgresDialect.mapType(t)).toBe('TEXT');
  });

  it('quotes identifiers and escapes embedded quotes', () => {
    expect(PostgresDialect.quoteIdent('users')).toBe('"users"');
    expect(PostgresDialect.quoteIdent('we"ird')).toBe('"we""ird"');
  });

  it('builds a keyset page (first page + after a key) and never SELECT *', () => {
    const first = PostgresDialect.pageSql({
      schema: 'public',
      table: 'users',
      columns: ['id', 'name'],
      keyCol: 'id',
      offset: 0,
      limit: 500,
    });
    expect(first.sql).toContain('SELECT "id", "name" FROM "public"."users"');
    expect(first.sql).toContain('ORDER BY "id" ASC LIMIT 500');
    expect(first.sql).not.toContain('*');
    expect(first.params).toEqual([]);

    const next = PostgresDialect.pageSql({
      schema: 'public',
      table: 'users',
      columns: ['id', 'name'],
      keyCol: 'id',
      afterKey: 'abc',
      offset: 0,
      limit: 500,
    });
    expect(next.sql).toContain('WHERE "id" > $1 ORDER BY "id" ASC LIMIT 500');
    expect(next.params).toEqual(['abc']);
  });

  it('builds an offset page for keyless/composite tables', () => {
    const q = PostgresDialect.pageSql({
      schema: 'public',
      table: 'events',
      columns: ['a', 'b'],
      keyCol: null,
      offset: 1000,
      limit: 500,
    });
    expect(q.sql).toContain('ORDER BY "a", "b" LIMIT 500 OFFSET 1000');
    expect(q.params).toEqual([]);
  });
});

describe('schema-cache model building', () => {
  it('slugifies + namespaces imported table names', () => {
    expect(slugify('My DB!')).toBe('my_db');
    expect(slugify('')).toBe('db');
    expect(latticeTableName('shop', 'Order Items')).toBe('db_shop_order_items');
  });

  it('uses a single-column PK as the natural key; synthesizes _pk otherwise', () => {
    expect(naturalKeyFor({ pk: ['id'] })).toEqual({ key: 'id', synthesized: false });
    expect(naturalKeyFor({ pk: ['a', 'b'] })).toEqual({ key: '_pk', synthesized: true });
    expect(naturalKeyFor({ pk: [] })).toEqual({ key: '_pk', synthesized: true });
  });

  it('builds ConnectedModelDefs with lifecycle columns, source descriptor, and selection', () => {
    const descriptor: DbSchemaDescriptor = {
      dialect: 'postgres',
      schema: 'public',
      prefix: 'shop',
      tables: [
        {
          name: 'orders',
          pk: ['id'],
          selected: true,
          columns: [
            { name: 'id', sqlSpec: 'TEXT' },
            { name: 'total', sqlSpec: 'REAL' },
          ],
        },
        {
          name: 'line_items',
          pk: ['order_id', 'sku'],
          selected: true,
          columns: [
            { name: 'order_id', sqlSpec: 'TEXT' },
            { name: 'sku', sqlSpec: 'TEXT' },
          ],
        },
        {
          name: 'skip_me',
          pk: ['id'],
          selected: false,
          columns: [{ name: 'id', sqlSpec: 'TEXT' }],
        },
      ],
    };
    const defs = buildModelDefs('conn-1', descriptor);
    // De-selected table excluded.
    expect(defs.map((d) => d.model)).toEqual(['orders', 'line_items']);

    const orders = defs[0]!;
    expect(orders.table).toBe('db_shop_orders');
    expect(orders.naturalKey).toBe('id');
    expect(orders.definition.columns.id).toBe('TEXT PRIMARY KEY');
    expect(orders.definition.columns.total).toBe('REAL');
    expect(orders.definition.columns.deleted_at).toBe('TEXT');
    expect(orders.definition.source?.connector).toBe('db_source');
    expect(orders.definition.source?.toolkit).toBe('db_source:conn-1');

    // Composite PK → synthesized _pk as the natural key; real pk cols stay columns.
    const items = defs[1]!;
    expect(items.naturalKey).toBe('_pk');
    expect(items.definition.columns._pk).toBe('TEXT PRIMARY KEY');
    expect(items.definition.columns.order_id).toBe('TEXT');
    expect(items.definition.columns.sku).toBe('TEXT');
  });
});
