import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * The data-model planner's `add_relationship` fix applies a belongsTo RELATION
 * over the EXISTING foreign-key column (via `createUserRelation` → the revertible
 * `schema.add_relation` op) — NOT an empty m2m junction. This drives the real flow
 * end-to-end and proves the undo/redo of that new op is sound: undo removes ONLY
 * the relation (never the data column), redo restores it.
 */

type Cfg = {
  entities?: Record<
    string,
    {
      fields?: Record<string, unknown>;
      relations?: Record<string, { type?: string; table?: string; foreignKey?: string }>;
    }
  >;
};

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<{ url: string; configPath: string }> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-planner-undo-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  customers:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      code: { type: text }',
      '      name: { type: text }',
      '    outputFile: customers.md',
      '  orders:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      customer: { type: text }',
      '      amount: { type: text }',
      '    outputFile: orders.md',
      '',
    ].join('\n'),
  );
  const handle = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
    autoRender: false,
  });
  servers.push(handle);
  return { url: handle.url, configPath };
}

const cfg = (configPath: string): Cfg => parse(readFileSync(configPath, 'utf8')) as Cfg;
const ordersRels = (configPath: string): { type?: string; table?: string; foreignKey?: string }[] =>
  Object.values(cfg(configPath).entities?.orders?.relations ?? {});
const hasBelongsToCustomers = (configPath: string): boolean =>
  ordersRels(configPath).some(
    (r) => r.type === 'belongsTo' && r.table === 'customers' && r.foreignKey === 'customer',
  );

describe('planner add_relationship — belongsTo apply + undo/redo', () => {
  it('auto-applies a belongsTo over the existing FK column; undo/redo toggle ONLY the relation', async () => {
    const { url, configPath } = await boot();
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // A small, FULLY-sampled + uniquely-keyed dimension, and a child referencing it —
    // enough distinct/rows + proven-unique target key to clear the unattended gate.
    for (let i = 1; i <= 10; i++) {
      expect(
        (await post('/api/tables/customers/rows', { code: `c${i}`, name: `Cust ${i}` })).status,
      ).toBe(201);
    }
    for (let i = 1; i <= 30; i++) {
      expect(
        (
          await post('/api/tables/orders/rows', {
            customer: `c${(i % 10) + 1}`,
            amount: String(i * 5),
          })
        ).status,
      ).toBe(201);
    }

    // The planner runs + applies the AUTO tier on the first plan request.
    expect((await fetch(`${url}/api/data-model/plan`)).status).toBe(200);

    // Applied artifact = a belongsTo RELATION over the existing column, NOT a junction.
    expect(hasBelongsToCustomers(configPath)).toBe(true);
    expect(cfg(configPath).entities?.orders?.fields?.customer).toBeTruthy(); // FK column intact
    expect(cfg(configPath).entities?.orders_customers).toBeUndefined(); // no junction table
    expect(cfg(configPath).entities?.customers_orders).toBeUndefined();

    // UNDO removes the relation but keeps the data column (add_relation ≠ add_link).
    expect((await post('/api/history/undo', {})).status).toBe(200);
    expect(hasBelongsToCustomers(configPath)).toBe(false);
    expect(cfg(configPath).entities?.orders?.fields?.customer).toBeTruthy();

    // REDO restores the relation.
    expect((await post('/api/history/redo', {})).status).toBe(200);
    expect(hasBelongsToCustomers(configPath)).toBe(true);
  });
});
