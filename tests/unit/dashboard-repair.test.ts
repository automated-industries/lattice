/**
 * Dashboard auto-repair: a BREAKING model change (rename/delete/merge) fired
 * through the shared schema-audit chokepoint re-authors every dashboard whose
 * source_tables touch the change — debounced into one pass, visible as an
 * ordinary row update (audit + feed), and fail-safe (an author failure keeps
 * the previous page). Additive changes never trigger it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { recordSchemaAudit, setSchemaChangeListener } from '../../src/gui/mutations.js';
import {
  createDashboardRepair,
  installDashboardRepair,
  type DashboardRepairHandle,
} from '../../src/gui/dashboard-repair.js';

let tmpDir: string;
let db: Lattice;
let feed: FeedBus;
let handle: DashboardRepairHandle | null = null;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lattice-dashrepair-'));
  db = new Lattice(join(tmpDir, 'test.db'), { encryptionKey: 'repair-test-key' });
  registerNativeEntities(db);
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
  feed = new FeedBus();
});

afterEach(() => {
  handle?.dispose();
  handle = null;
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function seedDashboard(id: string, sources: string[] | null, marker = 'v1'): Promise<void> {
  await db.insert('dashboards', {
    id,
    title: id,
    html:
      `<!doctype html><html><body>${marker}<script>lattice.query('${sources?.[0] ?? 'none'}')</scr` +
      `ipt></body></html>`,
    source_tables: sources ? JSON.stringify(sources) : null,
  });
}

const renameOrders = {
  table: 'orders',
  operation: 'schema.rename_entity',
  before: { name: 'orders' },
  after: { name: 'sales' },
  summary: 'Renamed orders to sales',
};

describe('dashboard auto-repair', () => {
  it('re-authors ONLY the dashboards that read a changed table', async () => {
    await seedDashboard('consumer', ['orders', 'widgets']);
    await seedDashboard('bystander', ['customers']);
    const author = vi.fn((instruction: string) =>
      Promise.resolve(
        `<!doctype html><html><body>repaired<script>lattice.sql("SELECT status, COUNT(*) FROM sales GROUP BY status")</scr` +
          `ipt></body></html>`,
      ),
    );
    handle = createDashboardRepair({
      db,
      feed,
      validTables: () => new Set(['sales', 'widgets', 'customers', 'dashboards']),
      author,
      debounceMs: 5,
    });

    const events: FeedEvent[] = [];
    feed.subscribe((e) => events.push(e));
    handle.onSchemaChange(renameOrders);
    await new Promise((r) => setTimeout(r, 20));
    await handle.settled();

    expect(author).toHaveBeenCalledTimes(1);
    expect(author.mock.calls[0]?.[0]).toContain('Renamed orders to sales');

    const consumer = (await db.get('dashboards', 'consumer')) as Record<string, unknown>;
    expect(String(consumer.html)).toContain('repaired');
    // source_tables re-extracted from the NEW page (a lattice.sql read).
    expect(JSON.parse(String(consumer.source_tables))).toEqual(['sales']);
    const bystander = (await db.get('dashboards', 'bystander')) as Record<string, unknown>;
    expect(String(bystander.html)).toContain('v1');
    // The rewrite is visible: an ordinary dashboards update on the feed.
    expect(events.some((e) => e.table === 'dashboards' && e.op === 'update')).toBe(true);
  });

  it('matches the OLD name of a rename (the page still references it)', async () => {
    await seedDashboard('legacy', ['orders']);
    const author = vi.fn(() =>
      Promise.resolve('<!doctype html><html><body>repaired</body></html>'),
    );
    handle = createDashboardRepair({
      db,
      feed,
      validTables: () => new Set(),
      author,
      debounceMs: 5,
    });
    // The event's table field carries the NEW name; before/after carry both.
    handle.onSchemaChange({ ...renameOrders, table: 'sales' });
    await new Promise((r) => setTimeout(r, 20));
    await handle.settled();
    expect(author).toHaveBeenCalledTimes(1);
  });

  it('debounces a burst of changes into ONE combined repair pass', async () => {
    await seedDashboard('consumer', ['orders']);
    const author = vi.fn(() =>
      Promise.resolve('<!doctype html><html><body>repaired</body></html>'),
    );
    handle = createDashboardRepair({
      db,
      feed,
      validTables: () => new Set(),
      author,
      debounceMs: 25,
    });
    handle.onSchemaChange(renameOrders);
    handle.onSchemaChange({
      table: 'orders',
      operation: 'schema.rename_column',
      before: { column: 'amount' },
      after: { column: 'total' },
      summary: 'Renamed amount to total on orders',
    });
    await new Promise((r) => setTimeout(r, 60));
    await handle.settled();
    expect(author).toHaveBeenCalledTimes(1);
    const instruction = author.mock.calls[0]?.[0] as string;
    expect(instruction).toContain('Renamed orders to sales');
    expect(instruction).toContain('Renamed amount to total');
  });

  it('keeps the previous page when the author fails (warned, never destructive)', async () => {
    await seedDashboard('consumer', ['orders']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handle = createDashboardRepair({
      db,
      feed,
      validTables: () => new Set(),
      author: () => Promise.reject(new Error('model unavailable')),
      debounceMs: 5,
    });
    handle.onSchemaChange(renameOrders);
    await new Promise((r) => setTimeout(r, 20));
    await handle.settled();
    const row = (await db.get('dashboards', 'consumer')) as Record<string, unknown>;
    expect(String(row.html)).toContain('v1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be auto-updated'));
    warn.mockRestore();
  });

  it('fires from the shared schema-audit chokepoint — breaking ops only', async () => {
    await seedDashboard('consumer', ['orders']);
    const author = vi.fn(() =>
      Promise.resolve('<!doctype html><html><body>repaired</body></html>'),
    );
    handle = installDashboardRepair({
      db,
      feed,
      validTables: () => new Set(),
      author,
      debounceMs: 5,
    });

    // Additive: never triggers a repair.
    await recordSchemaAudit(
      db,
      feed,
      'orders',
      'schema.add_column',
      null,
      { column: 'note' },
      'Added a column to orders',
    );
    await new Promise((r) => setTimeout(r, 20));
    await handle.settled();
    expect(author).not.toHaveBeenCalled();

    // Breaking: triggers it through the same chokepoint every schema op uses.
    await recordSchemaAudit(
      db,
      feed,
      'orders',
      'schema.rename_entity',
      { name: 'orders' },
      { name: 'sales' },
      'Renamed orders to sales',
    );
    await new Promise((r) => setTimeout(r, 20));
    await handle.settled();
    expect(author).toHaveBeenCalledTimes(1);
  });

  it('dispose() drops pending work and unregisters the listener', async () => {
    await seedDashboard('consumer', ['orders']);
    const author = vi.fn(() =>
      Promise.resolve('<!doctype html><html><body>repaired</body></html>'),
    );
    const h = installDashboardRepair({
      db,
      feed,
      validTables: () => new Set(),
      author,
      debounceMs: 25,
    });
    h.onSchemaChange(renameOrders);
    h.dispose();
    await new Promise((r) => setTimeout(r, 60));
    await h.settled();
    expect(author).not.toHaveBeenCalled();
    // The chokepoint no longer reaches a listener either.
    await recordSchemaAudit(db, feed, 'orders', 'schema.rename_entity', null, null, 'x');
    await new Promise((r) => setTimeout(r, 40));
    expect(author).not.toHaveBeenCalled();
    // afterEach double-dispose is safe.
    handle = h;
  });
});
