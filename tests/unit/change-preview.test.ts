import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import type { GuiRequestContext } from '../../src/gui/request-context.js';
import { handleTablesRoutes } from '../../src/gui/tables-routes.js';
import { executeFunction, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import {
  maskPreviewFields,
  rowFieldDeltas,
  PREVIEW_DEFAULT_LIMIT,
  type RowChangePreview,
  type FieldDelta,
} from '../../src/gui/change-preview.js';
import { MAX_ROWS_PAGE } from '../../src/ops/paging.js';

/**
 * Change preview — a read-only, bounded, permission-checked lens on a proposed
 * row change (POST /api/tables/:table/preview-changes). What it must guarantee:
 *
 *  - the preview and a subsequent execution agree exactly (same selection, same
 *    per-field change decision — they run through the same functions);
 *  - it is bounded on a large table (page-sized read + capped total), never a
 *    whole-table scan;
 *  - a viewer without read access to a masked column never sees the masked
 *    value — in either direction, and not even as a changed/unchanged flag.
 */

// ── fake req/res plumbing (the question-routes pattern) ─────────────────────

function fakeReq(method: string, url: string, jsonBody?: unknown): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json' };
  req.setEncoding = (() => req) as IncomingMessage['setEncoding'];
  queueMicrotask(() => {
    if (jsonBody !== undefined) req.emit('data', JSON.stringify(jsonBody));
    req.emit('end');
  });
  return req;
}

function fakeRes(): { res: ServerResponse; done: Promise<{ status: number; body: unknown }> } {
  let resolveDone!: (v: { status: number; body: unknown }) => void;
  const done = new Promise<{ status: number; body: unknown }>((r) => (resolveDone = r));
  let status = 200;
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end(payload?: string) {
      resolveDone({ status, body: payload ? JSON.parse(payload) : null });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

interface PreviewResponseRow {
  id: string;
  wouldChange: boolean | null;
  fields: ({ column: string; masked: true } | FieldDelta)[];
}
interface PreviewResponse {
  table: string;
  rows: PreviewResponseRow[];
  total: number;
  totalIsCapped: boolean;
  limit: number;
  offset: number;
  newColumns: string[];
}

describe('change preview route — POST /api/tables/:table/preview-changes', () => {
  let root: string;
  let db: Lattice;
  let feed: FeedBus;
  let active: ActiveDb;
  let gctx: GuiRequestContext;
  let dctx: DispatchCtx;
  let configPath: string;
  let outputDir: string;

  async function post(
    table: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown; handled: boolean }> {
    const url = `/api/tables/${table}/preview-changes`;
    const req = fakeReq('POST', url, body);
    const { res, done } = fakeRes();
    const handled = await handleTablesRoutes(req, res, gctx, { host: 'localhost' });
    if (!handled) return { status: 0, body: null, handled };
    const result = await done;
    return { ...result, handled };
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lattice-change-preview-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    configPath = join(root, 'lattice.config.yml');
    outputDir = join(root, 'context');
    writeFileSync(
      configPath,
      [
        'db: ./data/test.db',
        '',
        'entities:',
        '  companies:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '      status: { type: text }',
        '      tier: { type: text }',
        '      created_at: { type: timestamp }',
        '      deleted_at: { type: timestamp }',
        '    outputFile: companies.md',
        '',
      ].join('\n'),
    );
    db = new Lattice({ config: configPath }, { encryptionKey: 'change-preview-test-key' });
    db.define('big', {
      columns: { id: 'TEXT PRIMARY KEY', n: 'INTEGER' },
      render: () => '',
      outputFile: '.schema-only/big.md',
    });
    db.define('people', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', ssn: 'TEXT' },
      render: () => '',
      outputFile: '.schema-only/people.md',
    });
    db.define('vault', {
      columns: { id: 'TEXT PRIMARY KEY', label: 'TEXT', token: 'TEXT' },
      render: () => '',
      outputFile: '.schema-only/vault.md',
    });
    db.defineEntityContext('vault', {
      slug: (r) => r.id as string,
      encrypted: { columns: ['token'] },
      directoryRoot: 'vault',
      files: {},
    });
    // The GUI audit table (as lifecycle.ts defines it) so executions are audited.
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
        session_id: 'TEXT',
        source: 'TEXT',
        op_group: 'TEXT',
      },
      render: () => '',
      outputFile: '.lattice-gui/audit.md',
    });
    // The per-column secret-flag store loadSecretColumns reads.
    db.define('_lattice_gui_column_meta', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        table_name: 'TEXT NOT NULL',
        column_name: 'TEXT NOT NULL',
        secret: 'INTEGER NOT NULL DEFAULT 0',
        description: 'TEXT',
        updated_at: "TEXT DEFAULT (datetime('now'))",
      },
      render: () => '',
      outputFile: '.lattice-gui/column-meta.md',
    });
    await db.init();
    feed = new FeedBus();

    const validTables = new Set(['companies', 'big', 'people', 'vault', 'secrets']);
    const softDeletable = new Set(['companies']);
    active = {
      db,
      feed,
      validTables,
      junctionTables: new Set<string>(),
      softDeletable,
      maskedReadViews: new Map<string, string>(),
      configPath,
      outputDir,
    } as unknown as ActiveDb;
    gctx = {
      active: () => active,
      sessionId: 'sess-1',
      workspaceId: () => null,
      swapActive() {},
      goVirgin() {},
      buildMutationCtx: () => ({
        db,
        feed,
        softDeletable,
        source: 'gui',
        sessionId: 'sess-1',
      }),
    } as GuiRequestContext;
    dctx = {
      db,
      feed,
      validTables,
      junctionTables: new Set<string>(),
      softDeletable,
      configPath,
      outputDir,
      sessionId: 'sess-1',
    };

    const seed = [
      { id: 'c1', name: 'Company 1', status: 'active' },
      { id: 'c2', name: 'Company 2', status: 'active' },
      { id: 'c3', name: 'Company 3', status: 'active' },
      { id: 'c4', name: 'Company 4', status: 'archived' },
      { id: 'c5', name: 'Company 5', status: 'active', deleted_at: '2026-01-01T00:00:00Z' },
      { id: 'c6', name: 'Company 6', status: 'active' },
    ];
    for (const r of seed) await db.insert('companies', r);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  // ── parity: the preview IS what execution then does ───────────────────────

  it('bulk case: previewed rows + per-field afters match exactly what bulk_update then writes', async () => {
    const filter = [{ col: 'status', op: 'eq', val: 'active' }];
    const set = { status: 'flagged', tier: 'gold' };

    const r = await post('companies', { set, filter });
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    const body = r.body as PreviewResponse;

    // Exactly the live, matching rows — the trashed c5 and the archived c4 are
    // excluded, in pk order, with an honest total.
    expect(body.rows.map((x) => x.id)).toEqual(['c1', 'c2', 'c3', 'c6']);
    expect(body.total).toBe(4);
    expect(body.totalIsCapped).toBe(false);
    expect(body.newColumns).toEqual([]);
    for (const row of body.rows) {
      expect(row.wouldChange).toBe(true);
      const byCol = new Map(row.fields.map((f) => [f.column, f]));
      expect(byCol.get('status')).toMatchObject({
        before: 'active',
        after: 'flagged',
        changed: true,
      });
      expect(byCol.get('tier')).toMatchObject({ before: null, after: 'gold', changed: true });
    }

    // Execute the SAME change description through the bulk tool.
    const exec = await executeFunction(dctx, 'bulk_update', { table: 'companies', set, filter });
    expect(exec.ok).toBe(true);
    expect(exec.result).toMatchObject({ affected: 4, matched: 4 });

    // Every previewed field's `after` is now the stored value, row for row.
    for (const row of body.rows) {
      const stored = await db.get('companies', row.id);
      for (const f of row.fields) {
        expect((stored as Record<string, unknown>)[f.column]).toBe((f as FieldDelta).after);
      }
    }
    // And the rows the preview did NOT list are untouched.
    expect((await db.get('companies', 'c4'))?.status).toBe('archived');
    expect((await db.get('companies', 'c5'))?.status).toBe('active');
  });

  it('update case (ids): previewed deltas match what update_row then writes, incl. the no-op field', async () => {
    // 'status' is already 'active' — the preview must call it unchanged, and
    // execution must treat it as the same no-op (both run rowFieldDeltas).
    const values = { name: 'Company Two Renamed', status: 'active' };
    const r = await post('companies', { set: values, ids: ['c2', 'no-such-row'] });
    expect(r.status).toBe(200);
    const body = r.body as PreviewResponse;

    // The id that resolves to no row is simply absent — it cannot be changed.
    expect(body.rows.map((x) => x.id)).toEqual(['c2']);
    expect(body.total).toBe(1);
    const byCol = new Map(body.rows[0]!.fields.map((f) => [f.column, f as FieldDelta]));
    expect(byCol.get('name')).toMatchObject({ before: 'Company 2', changed: true });
    expect(byCol.get('status')).toMatchObject({
      before: 'active',
      after: 'active',
      changed: false,
    });
    expect(body.rows[0]!.wouldChange).toBe(true);

    const exec = await executeFunction(dctx, 'update_row', {
      table: 'companies',
      id: 'c2',
      values,
    });
    expect(exec.ok).toBe(true);
    const stored = await db.get('companies', 'c2');
    expect(stored?.name).toBe('Company Two Renamed');
    expect(stored?.status).toBe('active');
  });

  it('all-no-op change: preview says nothing would change, and execution agrees (genuine no-op, no throw)', async () => {
    const values = { name: 'Company 3', status: 'active' };
    const r = await post('companies', { set: values, ids: ['c3'] });
    expect(r.status).toBe(200);
    const body = r.body as PreviewResponse;
    expect(body.rows[0]!.wouldChange).toBe(false);
    expect(body.rows[0]!.fields.every((f) => !(f as FieldDelta).changed)).toBe(true);

    // The same decision function drives updateRow's write-landed guard: a
    // previewed no-op executes as a clean no-op, never a phantom conflict.
    const exec = await executeFunction(dctx, 'update_row', {
      table: 'companies',
      id: 'c3',
      values,
    });
    expect(exec.ok).toBe(true);
    expect((await db.get('companies', 'c3'))?.name).toBe('Company 3');
  });

  // ── bounded on a large table ───────────────────────────────────────────────

  it('is bounded on a large table: page-sized rows, capped total, working pagination, clamped limit', async () => {
    for (let i = 0; i < 1200; i++) {
      await db.insert('big', { id: `r${String(i).padStart(4, '0')}`, n: i });
    }

    // Default page: PREVIEW_DEFAULT_LIMIT rows, total capped at MAX_ROWS_PAGE + 1.
    const r1 = await post('big', { set: { flag: 'x' } });
    expect(r1.status).toBe(200);
    const b1 = r1.body as PreviewResponse;
    expect(b1.rows).toHaveLength(PREVIEW_DEFAULT_LIMIT);
    expect(b1.total).toBe(MAX_ROWS_PAGE + 1);
    expect(b1.totalIsCapped).toBe(true);
    expect(b1.limit).toBe(PREVIEW_DEFAULT_LIMIT);
    // 'flag' doesn't exist yet — the preview says so instead of faking a before.
    expect(b1.newColumns).toEqual(['flag']);
    expect(b1.rows[0]!.fields[0]).toMatchObject({
      column: 'flag',
      before: null,
      after: 'x',
      changed: true,
    });

    // Pagination: disjoint, ordered pages.
    const p1 = (await post('big', { set: { n: 0 }, limit: 50, offset: 0 })).body as PreviewResponse;
    const p2 = (await post('big', { set: { n: 0 }, limit: 50, offset: 50 }))
      .body as PreviewResponse;
    expect(p1.rows).toHaveLength(50);
    expect(p2.rows).toHaveLength(50);
    expect(p1.rows[0]!.id).toBe('r0000');
    expect(p2.rows[0]!.id).toBe('r0050');
    const ids1 = new Set(p1.rows.map((x) => x.id));
    expect(p2.rows.every((x) => !ids1.has(x.id))).toBe(true);

    // A huge requested limit is clamped to the global page bound — a client can
    // never turn the preview into an unbounded read.
    const big = (await post('big', { set: { n: 0 }, limit: 999999 })).body as PreviewResponse;
    expect(big.limit).toBe(MAX_ROWS_PAGE);
    expect(big.rows).toHaveLength(MAX_ROWS_PAGE);
  });

  // ── masking: a viewer without read access never sees the value ────────────

  it('masks a member-guarded (secret-flagged) column: no value, no changed flag, in either direction', async () => {
    await db.insert('people', { id: 'p1', name: 'Ada', ssn: '123-45-6789' });
    await db.insert('_lattice_gui_column_meta', {
      id: 'm1',
      table_name: 'people',
      column_name: 'ssn',
      secret: 1,
    });
    // A scoped member connection is exactly the viewer the mask exists for.
    (db as unknown as { isCloudMemberOpen: () => boolean }).isCloudMemberOpen = () => true;

    const r = await post('people', { set: { ssn: '000-00-0000', name: 'Ada L.' }, ids: ['p1'] });
    expect(r.status).toBe(200);
    const body = r.body as PreviewResponse;
    const byCol = new Map(body.rows[0]!.fields.map((f) => [f.column, f]));
    expect(byCol.get('ssn')).toEqual({ column: 'ssn', masked: true });
    expect(byCol.get('name')).toMatchObject({ before: 'Ada', after: 'Ada L.', changed: true });
    // A visible field changes, so wouldChange is honestly true.
    expect(body.rows[0]!.wouldChange).toBe(true);
    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain('123-45-6789'); // the stored value
    expect(raw).not.toContain('000-00-0000'); // the requested value
    expect(raw).not.toContain('"changed":true,"column":"ssn"');

    // When ONLY the masked field is in question, wouldChange degrades to null —
    // a boolean would be an equality oracle against the guarded cell.
    const r2 = await post('people', { set: { ssn: '123-45-6789' }, ids: ['p1'] });
    const body2 = r2.body as PreviewResponse;
    expect(body2.rows[0]!.wouldChange).toBeNull();
    expect(body2.rows[0]!.fields).toEqual([{ column: 'ssn', masked: true }]);
    expect(JSON.stringify(r2.body)).not.toContain('123-45-6789');
  });

  it('always masks a framework-encrypted column (decrypted-on-read), even for the local owner', async () => {
    await db.insert('vault', { id: 'v1', label: 'github', token: 'sk-CLEARTEXT-42' });

    const r = await post('vault', { set: { token: 'sk-NEW-99', label: 'gh' }, ids: ['v1'] });
    expect(r.status).toBe(200);
    const body = r.body as PreviewResponse;
    const byCol = new Map(body.rows[0]!.fields.map((f) => [f.column, f]));
    expect(byCol.get('token')).toEqual({ column: 'token', masked: true });
    expect(byCol.get('label')).toMatchObject({ before: 'github', after: 'gh', changed: true });
    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain('sk-CLEARTEXT-42');
    expect(raw).not.toContain('sk-NEW-99');
  });

  // ── permission + input gates ───────────────────────────────────────────────

  it('refuses an unknown table, the secrets store, bad filters, ids+filter, and sharing flips', async () => {
    expect((await post('nope', { set: { a: 1 } })).status).toBe(400);
    expect((await post('secrets', { set: { value: 'x' } })).status).toBe(403);
    expect((await post('companies', { set: {} })).status).toBe(400);
    expect(
      (await post('companies', { set: { status: 'x' }, ids: ['c1'], filter: [] })).status,
    ).toBe(400);
    const badCol = await post('companies', {
      set: { status: 'x' },
      filter: [{ col: 'not_a_column', op: 'eq', val: 1 }],
    });
    expect(badCol.status).toBe(400);
    expect((badCol.body as { error: string }).error).toContain('unknown column');
    const badOp = await post('companies', {
      set: { status: 'x' },
      filter: [{ col: 'status', op: 'regex', val: '.*' }],
    });
    expect(badOp.status).toBe(400);
    expect((await post('companies', { set: { visibility: 'private' } })).status).toBe(400);
    expect((await post('companies', { set: { status: 'x' }, limit: 1.5 })).status).toBe(400);
    expect((await post('companies', { set: { status: 'x' }, offset: -1 })).status).toBe(400);
  });

  it('refuses a computed table with the same explanation execution gives (409)', async () => {
    const orig = db.isComputedTable.bind(db);
    (db as unknown as { isComputedTable: (t: string) => boolean }).isComputedTable = (t) =>
      t === 'companies' ? true : orig(t);
    try {
      const r = await post('companies', { set: { status: 'x' } });
      expect(r.status).toBe(409);
      expect((r.body as { error: string }).error).toContain('computed view');
    } finally {
      (db as unknown as { isComputedTable: (t: string) => boolean }).isComputedTable = orig;
    }
  });
});

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('maskPreviewFields — the leak-proof viewer mask', () => {
  const rows: RowChangePreview[] = [
    {
      id: 'r1',
      wouldChange: true,
      fields: [
        { column: 'name', before: 'a', after: 'b', changed: true },
        { column: 'ssn', before: '123', after: '456', changed: true },
      ],
    },
    {
      id: 'r2',
      wouldChange: true,
      fields: [{ column: 'ssn', before: '123', after: '123', changed: false }],
    },
    {
      id: 'r3',
      wouldChange: false,
      fields: [{ column: 'name', before: 'a', after: 'a', changed: false }],
    },
  ];

  it('replaces masked columns with a bare marker and recomputes wouldChange honestly', () => {
    const out = maskPreviewFields(rows, new Set(['ssn']));
    // r1: visible field changes → true; the ssn marker carries nothing.
    expect(out[0]!.wouldChange).toBe(true);
    expect(out[0]!.fields[1]).toEqual({ column: 'ssn', masked: true });
    expect(JSON.stringify(out[0])).not.toContain('123');
    // r2: ONLY the masked field is in question → null, never a boolean oracle.
    expect(out[1]!.wouldChange).toBeNull();
    expect(out[1]!.fields).toEqual([{ column: 'ssn', masked: true }]);
    // r3: nothing masked, nothing changed → false, fields untouched.
    expect(out[2]!.wouldChange).toBe(false);
    expect(out[2]!.fields[0]).toMatchObject({ column: 'name', changed: false });
    // Pure: the inputs were not mutated.
    expect(rows[1]!.fields[0]).toMatchObject({ before: '123' });
  });

  it('is the identity (modulo copies) when nothing is masked', () => {
    const out = maskPreviewFields(rows, new Set());
    // wouldChange recomputes from the visible fields — with nothing masked that
    // is simply "did any field change": r1 yes, r2 no, r3 no.
    expect(out.map((r) => r.wouldChange)).toEqual([true, false, false]);
    expect(out[0]!.fields).toEqual(rows[0]!.fields);
    expect(out[1]!.fields).toEqual(rows[1]!.fields);
  });
});

describe('rowFieldDeltas — the shared "what would change" computation', () => {
  it('flags coercion-tolerant no-ops exactly like the write-landed guard', () => {
    const row = { id: 'x', count: 3, done: 1, note: null } as Record<string, unknown>;
    const deltas = rowFieldDeltas(row, { count: '3', done: true, note: '' });
    expect(deltas.map((d) => d.changed)).toEqual([false, false, false]);
  });

  it('normalizes a missing column to a null before (stable over JSON) but still calls it a change', () => {
    const deltas = rowFieldDeltas({ id: 'x' }, { brand_new: 'v' });
    expect(deltas[0]).toEqual({ column: 'brand_new', before: null, after: 'v', changed: true });
  });
});
