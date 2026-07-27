import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { openConfig } from '../../src/gui/lifecycle.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import {
  createFileJunction,
  renameUserEntity,
  setTableDefinition,
  setTableRole,
  readTableRoles,
  applyShapeOp,
} from '../../src/gui/schema-ops.js';
import { upsertTableMeta, upsertColumnMeta } from '../../src/gui/column-descriptions.js';
import { recordLineage, LINEAGE_TABLE } from '../../src/gui/lineage-store.js';
import { recordDismissal, loadDismissed } from '../../src/gui/planner/plan-state.js';
import { buildStructurals } from '../../src/gui/planner/run.js';
import { buildModelProfile } from '../../src/gui/planner/introspect.js';
import { detect, detectShape } from '../../src/gui/planner/detect.js';
import { allAsyncOrSync } from '../../src/db/adapter.js';
import type { TableRole } from '../../src/import/roles.js';

/**
 * Renaming a table used to move exactly two things — the physical table and its
 * configuration entry — and leave every OTHER place the name is written behind:
 * the relationships other tables declare, the link tables named after it (and
 * their key columns), computed-table definitions, the browsable metadata rows,
 * the lineage trail, the tables a saved dashboard reads, and the fingerprints of
 * proposals the user had already waved off. Each of those is a dangling
 * reference the moment the rename lands.
 *
 * `renameUserEntity` is the single primitive that moves all of them together,
 * and — because every cascade is derived from the CURRENT state rather than
 * replayed from a log — renaming back is its exact inverse.
 */

const dirs: string[] = [];
const actives: ActiveDb[] = [];
const SESSION = 'test-session';

afterEach(() => {
  for (const a of actives.splice(0)) {
    try {
      a.db.close();
    } catch {
      // already disposed
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<{ active: ActiveDb; configPath: string }> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-rename-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  orders:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      code: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: orders.md',
      '  customers:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      order_id: { type: uuid }',
      '      deleted_at: { type: text }',
      '    relations:',
      '      order: { type: belongsTo, table: orders, foreignKey: order_id }',
      '    outputFile: customers.md',
      '',
      'computed:',
      '  order_report:',
      '    base: orders',
      '    fields:',
      '      code: { kind: alias, source: code }',
      '',
      'entityContexts:',
      '  orders:',
      '    slug: "{{code}}"',
      '    files:',
      '      ORDER.md:',
      '        source: self',
      '        template: default-detail',
      '',
    ].join('\n'),
    'utf8',
  );
  const active = await openConfig(configPath, join(root, 'context'), false);
  actives.push(active);
  await active.converged; // the workspace's own schema convergence owns the connection first
  return { active, configPath };
}

function readConfig(configPath: string): {
  entities?: Record<
    string,
    { relations?: Record<string, { table?: string; foreignKey?: string }> }
  >;
  entityContexts?: Record<string, unknown>;
  computed?: Record<string, { base?: string }>;
} {
  return parseYaml(readFileSync(configPath, 'utf8')) as ReturnType<typeof readConfig>;
}

/** Every referrer the cascade is responsible for, read back from the workspace. */
async function referrerSnapshot(
  active: ActiveDb,
  configPath: string,
): Promise<Record<string, unknown>> {
  const cfg = readConfig(configPath);
  const metaRows = (await active.db.query('_lattice_gui_meta', {})) as { entity_name: string }[];
  const colMetaRows = (await active.db.query('_lattice_gui_column_meta', {})) as {
    table_name: string;
  }[];
  const lineage = (await allAsyncOrSync(
    active.db.adapter,
    `SELECT "object_table", "source_table" FROM "${LINEAGE_TABLE}" ORDER BY "object_table"`,
  )) as { object_table: string; source_table: string | null }[];
  const dashboards = (await active.db.query('dashboards', {
    filters: [{ col: 'source_tables', op: 'isNotNull' }],
  })) as { source_tables: string }[];
  return {
    entityKeys: Object.keys(cfg.entities ?? {}).sort(),
    entityContextKeys: Object.keys(cfg.entityContexts ?? {}).sort(),
    customerRelation: cfg.entities?.customers?.relations?.order?.table,
    computedBase: cfg.computed?.order_report?.base,
    junctionRelations: cfg.entities?.files_orders ?? cfg.entities?.files_sales,
    metaTables: metaRows.map((r) => r.entity_name).sort(),
    columnMetaTables: colMetaRows.map((r) => r.table_name).sort(),
    lineage,
    dashboardSources: dashboards.map((d) => d.source_tables),
    dismissed: (await loadDismissed(active.db)).sort(),
    registered: active.db.getRegisteredTableNames().includes('orders') ? 'orders' : 'sales',
    validTables: [...active.validTables].filter((t) => t === 'orders' || t === 'sales'),
  };
}

/** Seed one referrer of every kind that stores a table name. */
async function seedReferrers(active: ActiveDb): Promise<void> {
  await createFileJunction(active, 'orders', SESSION);
  await upsertTableMeta(active.db, 'orders', { description: 'Customer orders', icon: '📦' });
  await upsertColumnMeta(active.db, 'orders', 'code', { description: 'Order code' });
  await recordLineage(active.db.adapter, [
    {
      objectTable: 'orders',
      objectId: '*',
      sourceKind: 'import',
      sourceTable: null,
      tier: 'derived',
      relation: 'materialized_from',
    },
    {
      objectTable: 'customers',
      objectId: '*',
      sourceKind: 'table',
      sourceTable: 'orders',
      tier: 'derived',
      relation: 'derived_from',
    },
  ]);
  await active.db.insert('dashboards', {
    id: 'dash-1',
    title: 'Orders overview',
    html: '<p>x</p>',
    source_tables: JSON.stringify(['orders', 'customers']),
  });
  await recordDismissal(active.db, 'dedup_rows:orders::', 'dedup_rows');
}

describe('renameUserEntity — the rename cascade', () => {
  it('moves every referrer of the renamed table', async () => {
    const { active, configPath } = await boot();
    await seedReferrers(active);

    const result = await renameUserEntity(active, 'orders', 'sales', SESSION);
    expect(result).toMatchObject({ ok: true });

    const after = await referrerSnapshot(active, configPath);
    // The table itself.
    expect(after.entityKeys).toContain('sales');
    expect(after.entityKeys).not.toContain('orders');
    expect(after.entityContextKeys).toContain('sales');
    expect(after.validTables).toEqual(['sales']);
    // Relationship declared by another table.
    expect(after.customerRelation).toBe('sales');
    // Computed-table definition.
    expect(after.computedBase).toBe('sales');
    // The link table named after it, its key column, and its relation.
    const cfg = readConfig(configPath);
    expect(Object.keys(cfg.entities ?? {})).toContain('files_sales');
    expect(Object.keys(cfg.entities ?? {})).not.toContain('files_orders');
    expect(cfg.entities?.files_sales?.relations?.sales).toMatchObject({
      table: 'sales',
      foreignKey: 'sales_id',
    });
    expect(active.db.getRegisteredColumns('files_sales')).toHaveProperty('sales_id');
    // Metadata rows, lineage, dashboards, dismissed proposals.
    expect(after.metaTables).toContain('sales');
    expect(after.metaTables).not.toContain('orders');
    expect(after.columnMetaTables).toEqual(['sales']);
    expect(after.lineage).toEqual([
      { object_table: 'customers', source_table: 'sales' },
      { object_table: 'sales', source_table: null },
    ]);
    expect(after.dashboardSources).toEqual([JSON.stringify(['sales', 'customers'])]);
    expect(after.dismissed).toEqual(['dedup_rows:sales::']);
    // The rows survived the physical rename.
    expect(await active.db.count('sales')).toBe(0);
  });

  it('is its own inverse: renaming back restores every referrer', async () => {
    const { active, configPath } = await boot();
    await seedReferrers(active);
    const before = await referrerSnapshot(active, configPath);

    const forward = await renameUserEntity(active, 'orders', 'sales', SESSION);
    expect(forward).toMatchObject({ ok: true });
    const renamed = await referrerSnapshot(active, configPath);
    expect(renamed).not.toEqual(before);

    const back = await renameUserEntity(active, 'sales', 'orders', SESSION);
    expect(back).toMatchObject({ ok: true });
    expect(await referrerSnapshot(active, configPath)).toEqual(before);
  });

  it('records one audited, revertible schema op carrying the cascade inventory', async () => {
    const { active } = await boot();
    await seedReferrers(active);
    await renameUserEntity(active, 'orders', 'sales', SESSION);

    const entries = (await active.db.query('_lattice_gui_audit', {
      filters: [{ col: 'operation', op: 'eq', val: 'schema.rename_entity' }],
    })) as { before_json: string; after_json: string; table_name: string }[];
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.table_name).toBe('sales');
    const before = JSON.parse(entry.before_json) as { entity: string; cascade?: unknown };
    const after = JSON.parse(entry.after_json) as { entity: string; cascade?: unknown };
    expect(before.entity).toBe('orders');
    expect(after.entity).toBe('sales');
    // The inventory is part of the record, so what moved is auditable.
    // Referrers are listed under the names they were FOUND with; `linkTables`
    // maps the ones this same cascade renamed.
    expect(after.cascade).toMatchObject({
      relations: [
        { table: 'customers', relation: 'order' },
        { table: 'files_orders', relation: 'orders' },
      ],
      computed: ['order_report'],
      linkTables: [
        {
          from: 'files_orders',
          to: 'files_sales',
          column: { from: 'orders_id', to: 'sales_id' },
          relation: { from: 'orders', to: 'sales' },
        },
      ],
    });
  });

  it('refuses a rename it cannot make, without touching anything', async () => {
    const { active, configPath } = await boot();
    const before = await referrerSnapshot(active, configPath);
    expect(await renameUserEntity(active, 'nope', 'other', SESSION)).toMatchObject({ ok: false });
    expect(await renameUserEntity(active, 'orders', 'customers', SESSION)).toMatchObject({
      ok: false,
    });
    expect(await renameUserEntity(active, 'orders', '1bad name', SESSION)).toMatchObject({
      ok: false,
    });
    expect(await renameUserEntity(active, 'files', 'documents', SESSION)).toMatchObject({
      ok: false,
    });
    expect(await referrerSnapshot(active, configPath)).toEqual(before);
  });
});

describe('table roles — persistence + the shape ops', () => {
  it('round-trips a role, its provenance, its grain, and when it was set', async () => {
    const { active } = await boot();
    await setTableRole(active, 'orders', 'fact', 'inferred', 'one row per code');

    const stored = await readTableRoles(active.db);
    const orders = stored.get('orders');
    expect(orders?.role).toBe('fact');
    expect(orders?.source).toBe('inferred');
    expect(orders?.grain).toBe('one row per code');
    expect(typeof orders?.setAt).toBe('string');
    expect(Number.isNaN(Date.parse(String(orders?.setAt)))).toBe(false);

    // A user-set role replaces an inferred one and keeps its provenance.
    await setTableRole(active, 'orders', 'dimension', 'user', 'one row per order');
    const after = await readTableRoles(active.db);
    expect(after.get('orders')).toMatchObject({ role: 'dimension', source: 'user' });

    // The existing table metadata is untouched by a role write.
    await upsertTableMeta(active.db, 'orders', { description: 'Customer orders' });
    await setTableRole(active, 'orders', 'fact', 'inferred', null);
    const row = (await active.db.get('_lattice_gui_meta', 'orders')) as { description?: string };
    expect(row.description).toBe('Customer orders');
  });

  it('a stored role travels with the table through a rename', async () => {
    const { active } = await boot();
    await setTableRole(active, 'orders', 'fact', 'user', 'one row per code');
    await renameUserEntity(active, 'orders', 'sales', SESSION);
    const stored = await readTableRoles(active.db);
    expect(stored.get('sales')).toMatchObject({ role: 'fact', source: 'user' });
    expect(stored.has('orders')).toBe(false);
  });

  it('applies an assign_role op, and the planner then stops proposing it', async () => {
    const { active } = await boot();
    // Two orders, referenced by five customers: `orders` is the smaller,
    // pointed-at side, which is what makes its role unambiguous.
    await active.db.insert('orders', { id: 'o1', code: 'A-1' });
    await active.db.insert('orders', { id: 'o2', code: 'A-2' });
    for (let i = 0; i < 5; i++) {
      await active.db.insert('customers', {
        id: `c${String(i)}`,
        name: `Person ${String(i)}`,
        order_id: i % 2 === 0 ? 'o1' : 'o2',
      });
    }

    const profile = await buildModelProfile(active.db, buildStructurals(active));
    const ops = detectShape(profile, new Map<string, TableRole | null>());
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops.filter((o) => o.tier === 'auto')) {
      expect(await applyShapeOp(active, op, SESSION)).toMatchObject({ ok: true });
    }

    const stored = await readTableRoles(active.db);
    const roles = new Map<string, TableRole | null>(
      [...stored].map(([table, v]) => [table, v.role]),
    );
    expect(roles.size).toBeGreaterThan(0);
    expect(detectShape(profile, roles).filter((o) => o.kind === 'assign_role')).toEqual([]);
  });
});

describe('the document proposal converges', () => {
  it('proposes documentation once and then stops', async () => {
    const { active } = await boot();
    // A link table with no definition is what the documentation rule fires on.
    await createFileJunction(active, 'orders', SESSION);

    const docOps = async (): Promise<string[]> => {
      const profile = await buildModelProfile(active.db, buildStructurals(active));
      return detect(profile)
        .filter((o) => o.kind === 'document')
        .map((o) => o.target.table);
    };

    const first = await docOps();
    expect(first).toEqual(['files_orders']);

    // Apply it through the write half of the rule.
    await setTableDefinition(active, 'files_orders', 'Join table linking files and orders.');

    expect(await docOps()).toEqual([]);
  });

  it('writes the definition where BOTH the reader and the browser look', async () => {
    const { active, configPath } = await boot();
    await setTableDefinition(active, 'orders', 'Customer orders.');
    const cfg = parseYaml(readFileSync(configPath, 'utf8')) as {
      entities: Record<string, { description?: string }>;
    };
    expect(cfg.entities.orders.description).toBe('Customer orders.');
    const row = (await active.db.get('_lattice_gui_meta', 'orders')) as { description?: string };
    expect(row.description).toBe('Customer orders.');
  });
});
