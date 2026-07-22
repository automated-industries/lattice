/**
 * Schema-drift reconciliation against a REAL Postgres-backed Lattice — the
 * SQLite-CI-masks-Postgres guard for the adaptive MCP connector.
 *
 * The unit suite (mcp-adaptive-connector.test.ts) drives the same drift logic on
 * SQLite, where `ADD COLUMN` has no `IF NOT EXISTS` gymnastics and identifier
 * rules differ. The class of bug this file exists to catch only surfaces on the
 * Postgres runtime the cloud ships on: `reconcileLate` -> `db.defineLate` ->
 * `_addMissingColumns` emits `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (see
 * src/db/postgres.ts) exclusively on the `postgres` dialect. So this test:
 *   1. connects a generic MCP connector to a fake v1 transport, introspects, and
 *      defines/populates the typed tables (mirroring the sync bootstrap);
 *   2. swaps the transport to v2 (adds a kind, adds a column to a kind, drops a
 *      kind) and runs the real drift reconcile (reconcileMcpSchema);
 *   3. asserts on the live Postgres catalog: the new kind's table was CREATEd,
 *      the added column exists (information_schema), the dropped kind's table +
 *      rows SURVIVE (frozen, not dropped) and stop being written, and a second
 *      reconcile is a clean no-op (idempotent ADD COLUMN IF NOT EXISTS).
 *
 * Gating + disposable-Postgres boot are handled entirely by tests/setup/
 * pg-global-setup.ts (globalSetup) and tests/setup/pg-env.ts (per-fork db); this
 * file only reads LATTICE_TEST_PG_URL and skips when it is absent, exactly like
 * every other *-postgres.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { allAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';
import { genericConnector } from '../../src/connectors/generic/connector.js';
import { setMcpServerUrl, clearMcpConnection } from '../../src/connectors/mcp/oauth.js';
import {
  getMcpSchemaDescriptor,
  clearMcpSchemaDescriptor,
  mcpToolkitFor,
  mcpTableName,
  type McpSchemaDescriptor,
} from '../../src/connectors/mcp/schema-cache.js';
import {
  reconcileMcpSchema,
  applyDescriptorDiff,
  type SchemaDiff,
} from '../../src/connectors/mcp/schema-drift.js';
import type {
  McpTransport,
  McpToolCall,
  McpToolInfo,
  McpResourceInfo,
  McpResourceContent,
} from '../../src/connectors/mcp/transport.js';
import type { ExternalRecord, ListChangesContext } from '../../src/connectors/types.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

/**
 * A fake MCP transport whose tool set + canned results are fixed at construction.
 * Two instances model the server BEFORE and AFTER a config change; the connector's
 * transportFactory returns whichever is `current`, so "the server changed its
 * schema" is a single pointer swap (no network, no MCP SDK).
 */
class FakeMcpTransport implements McpTransport {
  readonly callLog: McpToolCall[] = [];
  constructor(
    private readonly tools: McpToolInfo[],
    private readonly results: Record<string, unknown>,
  ) {}
  listTools(): Promise<McpToolInfo[]> {
    return Promise.resolve(this.tools);
  }
  callTool(call: McpToolCall): Promise<unknown> {
    this.callLog.push(call);
    return Promise.resolve(this.results[call.tool] ?? {});
  }
  listResources(): Promise<McpResourceInfo[]> {
    return Promise.resolve([]);
  }
  readResource(): Promise<McpResourceContent[]> {
    return Promise.resolve([]);
  }
  serverInfo(): { name?: string } | undefined {
    return { name: 'acme-mcp' };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

async function collect(it: AsyncIterable<ExternalRecord>): Promise<ExternalRecord[]> {
  const out: ExternalRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe.skipIf(!PG_URL)('MCP adaptive-connector schema drift (Postgres)', () => {
  const runId = randomBytes(4).toString('hex');
  const CONN = `mcp_drift_${runId}`;
  const TK = mcpToolkitFor(CONN);

  let cfgDir: string;
  let prevCfgDir: string | undefined;
  let db: Lattice;

  // Descriptors + diff captured across the drift so the `it`s can assert on them.
  let prefix: string;
  let v1: McpSchemaDescriptor;
  let v2: McpSchemaDescriptor;
  let merged: McpSchemaDescriptor;
  let diff: SchemaDiff;

  // Resolved physical table names (namespaced by the connection prefix).
  let widgetsTbl: string; // gains a `color` column at v2
  let gadgetsTbl: string; // unchanged control
  let gizmosTbl: string; // vanishes at v2 -> frozen, never dropped
  let sprocketsTbl: string; // appears at v2 -> table CREATEd

  const v1Transport = new FakeMcpTransport(
    [{ name: 'list_widgets' }, { name: 'list_gadgets' }, { name: 'list_gizmos' }],
    {
      list_widgets: { items: [{ id: 'w1', name: 'Widget One' }] },
      list_gadgets: { items: [{ id: 'g1', name: 'Gadget One' }] },
      list_gizmos: { items: [{ id: 'z1', name: 'Gizmo One' }] },
    },
  );
  const v2Transport = new FakeMcpTransport(
    [{ name: 'list_widgets' }, { name: 'list_gadgets' }, { name: 'list_sprockets' }],
    {
      list_widgets: { items: [{ id: 'w1', name: 'Widget One', color: 'red' }] },
      list_gadgets: { items: [{ id: 'g1', name: 'Gadget One' }] },
      list_sprockets: { items: [{ id: 's1', name: 'Sprocket One', teeth: 12 }] },
    },
  );
  let current: FakeMcpTransport = v1Transport;
  const conn = genericConnector({ transportFactory: () => Promise.resolve(current) });

  const pgColumns = async (tbl: string): Promise<string[]> => {
    const rows = (await allAsyncOrSync(
      db.adapter,
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ? ORDER BY column_name`,
      [tbl],
    )) as { column_name: string }[];
    return rows.map((r) => r.column_name);
  };
  const pgTableExists = async (tbl: string): Promise<boolean> => {
    const rows = (await allAsyncOrSync(
      db.adapter,
      `SELECT 1 AS x FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ?`,
      [tbl],
    )) as unknown[];
    return rows.length > 0;
  };
  const colCount = async (tbl: string, col: string): Promise<number> => {
    const rows = (await allAsyncOrSync(
      db.adapter,
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
      [tbl, col],
    )) as { n: number | string }[];
    return Number(rows[0]?.n ?? 0);
  };

  beforeAll(async () => {
    prevCfgDir = process.env.LATTICE_CONFIG_DIR;
    cfgDir = mkdtempSync(join(tmpdir(), 'lattice-mcp-drift-pg-'));
    process.env.LATTICE_CONFIG_DIR = cfgDir;
    process.env.LATTICE_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
    setMcpServerUrl(CONN, 'https://mcp.acme.example.com/');

    db = new Lattice(PG_URL!);
    await db.init();

    // (1) Connect-time introspect against v1 -> persist the typed descriptor, then
    //     define its tables the way the sync bootstrap does and seed rows via the
    //     SYNC write path (db.upsert bypasses the connected-table write guard).
    const introspected = await conn.introspect(CONN, TK, `acme_${runId}`);
    expect(introspected).toBeTruthy();
    v1 = getMcpSchemaDescriptor(CONN)!;
    prefix = v1.prefix;
    widgetsTbl = mcpTableName(prefix, 'widgets');
    gadgetsTbl = mcpTableName(prefix, 'gadgets');
    gizmosTbl = mcpTableName(prefix, 'gizmos');
    sprocketsTbl = mcpTableName(prefix, 'sprockets');

    for (const m of conn.models(TK)) await db.defineLate(m.table, m.definition);

    await db.upsert(widgetsTbl, { id: 'w1', name: 'Widget One' });
    await db.upsert(gadgetsTbl, { id: 'g1', name: 'Gadget One' });
    await db.upsert(gizmosTbl, { id: 'z1', name: 'Gizmo One' });
    await db.upsert(gizmosTbl, { id: 'z2', name: 'Gizmo Two' });

    // (2) The server changes its config -> swap the transport, re-discover, and run
    //     the real drift reconcile. introspect(v2) transiently overwrites the stored
    //     descriptor, but reconcileMcpSchema takes prev+next explicitly and re-persists
    //     the MERGED descriptor, so the transient state is never used for a DB op.
    current = v2Transport;
    v2 = (await conn.introspect(CONN, TK, `acme_${runId}`))!;
    const result = await reconcileMcpSchema(db, conn, CONN, TK, v1, v2);
    expect(result).not.toBeNull();
    diff = result!;
    merged = getMcpSchemaDescriptor(CONN)!;
  });

  afterAll(async () => {
    try {
      for (const t of [widgetsTbl, gadgetsTbl, gizmosTbl, sprocketsTbl]) {
        if (t) await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${t}" CASCADE`, []);
      }
    } catch {
      /* best effort */
    }
    clearMcpSchemaDescriptor(CONN);
    clearMcpConnection(CONN);
    db.close();
    if (prevCfgDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = prevCfgDir;
    rmSync(cfgDir, { recursive: true, force: true });
  });

  it('classifies the drift: one added kind, one changed kind (+column), one retired kind', () => {
    expect(diff.addedKinds).toEqual(['sprockets']);
    expect(diff.retiredKinds).toEqual(['gizmos']);
    const widgetsChange = diff.changedKinds.find((c) => c.kind === 'widgets');
    expect(widgetsChange).toBeTruthy();
    expect(widgetsChange!.addedColumns.map((c) => c.name)).toEqual(['color']);
    expect(diff.changedKinds.some((c) => c.kind === 'gadgets')).toBe(false);
  });

  it('CREATEs the new kind table on Postgres', async () => {
    expect(await pgTableExists(sprocketsTbl)).toBe(true);
    expect(await db.count(sprocketsTbl)).toBe(0);
    const cols = await pgColumns(sprocketsTbl);
    expect(cols).toEqual(expect.arrayContaining(['id', 'deleted_at', 'name', 'teeth', 'data']));
  });

  it('ADDs the new column to the existing kind table (real Postgres ADD COLUMN path)', async () => {
    const cols = await pgColumns(widgetsTbl);
    expect(cols).toContain('color'); // the SQLite-CI-masked assertion: it exists in the PG catalog
    expect(cols).toEqual(expect.arrayContaining(['id', 'deleted_at', 'name', 'color', 'data']));
    expect(await colCount(widgetsTbl, 'color')).toBe(1); // exactly one — no duplicate artifact
  });

  it('preserves the pre-existing row and backfills the new column as NULL', async () => {
    const row = await db.get(widgetsTbl, 'w1');
    expect(row).toBeTruthy();
    expect(row!.name).toBe('Widget One');
    expect(row!.color ?? null).toBeNull(); // existing rows get NULL, never dropped/rewritten
  });

  it('FREEZES the vanished kind: its table + rows survive (never dropped)', async () => {
    expect(await pgTableExists(gizmosTbl)).toBe(true);
    expect(await db.count(gizmosTbl)).toBe(2);
    const rows = await db.query(gizmosTbl);
    expect(rows.map((r) => r.id).sort()).toEqual(['z1', 'z2']);
    const gizmos = merged.kinds.find((k) => k.kind === 'gizmos');
    expect(gizmos).toBeTruthy();
    expect(gizmos!.retired).toBe(true);
  });

  it('STOPS writing the retired kind while live kinds keep syncing', async () => {
    const ctx: ListChangesContext = { connectionId: CONN, userId: 'u1' };
    expect(await collect(conn.listChanges(TK, 'gizmos', ctx))).toHaveLength(0);
    const live = await collect(conn.listChanges(TK, 'widgets', ctx));
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe('w1');
    expect(live[0]!.row.color).toBe('red');
  });

  it('is idempotent: re-applying the SAME diff re-runs ADD COLUMN IF NOT EXISTS without error', async () => {
    await expect(applyDescriptorDiff(db, conn, CONN, TK, merged, diff)).resolves.toBeUndefined();
    expect(await colCount(widgetsTbl, 'color')).toBe(1);
    expect(await pgTableExists(gizmosTbl)).toBe(true);
    expect(await db.count(gizmosTbl)).toBe(2);
  });

  it('is idempotent: a second reconcile against the converged descriptor is a no-op', async () => {
    const again = await reconcileMcpSchema(db, conn, CONN, TK, merged, v2);
    expect(again).toBeNull();
    expect(await colCount(widgetsTbl, 'color')).toBe(1);
    const gizmos = getMcpSchemaDescriptor(CONN)!.kinds.find((k) => k.kind === 'gizmos');
    expect(gizmos!.retired).toBe(true);
  });
});
