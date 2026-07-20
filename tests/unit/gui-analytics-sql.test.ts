/**
 * The dashboard SQL read surface: POST /api/analytics/sql executes ONE
 * read-only SELECT/WITH statement against the workspace and returns capped
 * rows. Anything write-shaped, multi-statement, or referencing a protected
 * table is refused loudly — this is the sandboxed frames' aggregation path,
 * so the server, not the caller, is the enforcement point.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

let dir: string;
let server: GuiServerHandle;

async function runSql(sql: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${server.url}/api/analytics/sql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lattice-analytics-sql-'));
  const outputDir = join(dir, 'context');
  mkdirSync(outputDir, { recursive: true });
  const configPath = join(dir, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  orders:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      status: { type: text }',
      '      amount: { type: integer }',
      '    render: default-list',
      '    outputFile: orders.md',
      '',
    ].join('\n'),
  );
  server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
  for (const [status, amount] of [
    ['open', 10],
    ['open', 15],
    ['closed', 7],
  ] as const) {
    const res = await fetch(`${server.url}/api/tables/orders/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status, amount }),
    });
    if (!res.ok) throw new Error(`seed failed: ${res.status}`);
  }
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/analytics/sql', () => {
  it('runs a SELECT aggregation and returns rows', async () => {
    const { status, body } = await runSql(
      'SELECT status, COUNT(*) AS n, SUM(amount) AS total FROM orders GROUP BY status ORDER BY status',
    );
    expect(status).toBe(200);
    expect(body.truncated).toBe(false);
    expect(body.rows).toEqual([
      { status: 'closed', n: 1, total: 7 },
      { status: 'open', n: 2, total: 25 },
    ]);
  });

  it('supports WITH … SELECT (and a trailing semicolon)', async () => {
    const { status, body } = await runSql(
      "WITH open_orders AS (SELECT * FROM orders WHERE status = 'open') SELECT COUNT(*) AS n FROM open_orders;",
    );
    expect(status).toBe(200);
    expect(body.rows).toEqual([{ n: 2 }]);
  });

  it('refuses write-shaped statements', async () => {
    for (const sql of [
      "UPDATE orders SET status = 'x'",
      'DELETE FROM orders',
      "INSERT INTO orders (id) VALUES ('x')",
      'DROP TABLE orders',
      'PRAGMA table_info(orders)',
    ]) {
      const { status, body } = await runSql(sql);
      expect(status, sql).toBe(400);
      expect(String(body.error), sql).toMatch(/SELECT/i);
    }
  });

  it('refuses multiple statements — a separator inside a string is fine', async () => {
    const multi = await runSql('SELECT 1 AS a; DELETE FROM orders');
    expect(multi.status).toBe(400);
    expect(String(multi.body.error)).toMatch(/multiple statements/i);

    const stringy = await runSql("SELECT COUNT(*) AS n FROM orders WHERE status <> 'a;b'");
    expect(stringy.status).toBe(200);
    expect(stringy.body.rows).toEqual([{ n: 3 }]);
  });

  it('refuses reads of protected tables', async () => {
    for (const sql of [
      'SELECT * FROM secrets',
      'SELECT * FROM chat_messages',
      'SELECT o.id FROM orders o JOIN secrets s ON 1=1',
      'SELECT * FROM _lattice_gui_audit',
      'SELECT * FROM __lattice_migrations',
    ]) {
      const { status, body } = await runSql(sql);
      expect(status, sql).toBe(400);
      expect(String(body.error), sql).toMatch(/protected table/i);
    }
  });

  it('rejects a missing/blank statement and reports execution errors as 400', async () => {
    expect((await runSql('')).status).toBe(400);
    expect((await runSql(42)).status).toBe(400);
    const bad = await runSql('SELECT nope FROM orders');
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/query failed/i);
  });
});
