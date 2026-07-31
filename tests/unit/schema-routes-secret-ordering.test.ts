import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActiveDb } from '../../src/gui/active-db.js';
import type { GuiRequestContext } from '../../src/gui/request-context.js';
import type { SchemaRoutesDeps } from '../../src/gui/schema-routes.js';

/**
 * C6 (5.2.1) — the "mark column secret" route applies the DATABASE mask
 * (setColumnAudience) BEFORE persisting the local `_lattice_gui_column_meta.secret`
 * flag. If the mask throws, the local flag must NEVER be written — otherwise a
 * failed mask leaves a column shown-masked to the owner + redacted from the
 * assistant while a scoped member's Postgres connection can still SELECT it.
 */

const { setColumnAudienceMock, writeColumnMetaRowMock } = vi.hoisted(() => ({
  setColumnAudienceMock: vi.fn(),
  writeColumnMetaRowMock: vi.fn(async () => {}),
}));

vi.mock('../../src/cloud/audience.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cloud/audience.js')>();
  return { ...actual, setColumnAudience: setColumnAudienceMock };
});
vi.mock('../../src/gui/column-descriptions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/gui/column-descriptions.js')>();
  return { ...actual, writeColumnMetaRow: writeColumnMetaRowMock };
});
vi.mock('../../src/gui/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/gui/http.js')>();
  return { ...actual, readJson: async () => ({ secret: true }) };
});

const { handleSchemaRoutes } = await import('../../src/gui/schema-routes.js');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** Minimal Postgres-dialect ActiveDb: a real config backs columnRefTarget's
 *  loadConfigDoc read (person.ssn is a plain scalar → maskable), the rest is a
 *  fake so the cloud mask branch runs without a live Postgres. */
function makeActive(): ActiveDb {
  const root = mkdtempSync(join(tmpdir(), 'lattice-c6-'));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      'entities:',
      '  person:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      ssn: { type: text }',
      '    outputFile: person.md',
      '',
    ].join('\n'),
    'utf8',
  );
  return {
    validTables: new Set(['person']),
    configPath,
    db: {
      getDialect: () => 'postgres',
      getRegisteredColumns: () => ({ id: {}, ssn: {} }),
      getPrimaryKey: () => ['id'],
      // An ordinary Postgres, not a secured shared one: the bookkeeping table
      // the owner check looks for is absent, so the caller is nobody's member and
      // the ordering under test is what decides the outcome.
      adapter: { getAsync: () => Promise.resolve(undefined) },
    },
  } as unknown as ActiveDb;
}

function makeReqRes(): { req: IncomingMessage; res: ServerResponse } {
  return {
    req: { method: 'PUT', url: '/api/gui-meta/columns/person/ssn' } as unknown as IncomingMessage,
    res: {
      writeHead: vi.fn(),
      end: vi.fn(),
      setHeader: vi.fn(),
    } as unknown as ServerResponse,
  };
}

function ctxDeps(active: ActiveDb): { ctx: GuiRequestContext; deps: SchemaRoutesDeps } {
  return {
    ctx: { active: () => active, sessionId: 'test-session' } as unknown as GuiRequestContext,
    deps: { host: 'localhost', autoRender: false },
  };
}

describe('mark-column-secret ordering (C6 — DB mask before local flag)', () => {
  it('does NOT persist the local secret flag when the DB mask throws', async () => {
    setColumnAudienceMock.mockRejectedValueOnce(new Error('audience view failed'));
    const { req, res } = makeReqRes();
    const { ctx, deps } = ctxDeps(makeActive());

    await expect(handleSchemaRoutes(req, res, ctx, deps)).rejects.toThrow(/audience view failed/);

    expect(setColumnAudienceMock).toHaveBeenCalledTimes(1); // mask attempted first
    expect(writeColumnMetaRowMock).not.toHaveBeenCalled(); // local flag never written
  });

  it('applies the DB mask strictly BEFORE the local flag on success', async () => {
    setColumnAudienceMock.mockResolvedValueOnce(undefined);
    const { req, res } = makeReqRes();
    const { ctx, deps } = ctxDeps(makeActive());

    const handled = await handleSchemaRoutes(req, res, ctx, deps);
    expect(handled).toBe(true);
    expect(setColumnAudienceMock).toHaveBeenCalledTimes(1);
    expect(writeColumnMetaRowMock).toHaveBeenCalledTimes(1);
    expect(setColumnAudienceMock.mock.invocationCallOrder[0]!).toBeLessThan(
      writeColumnMetaRowMock.mock.invocationCallOrder[0]!,
    );
  });
});
