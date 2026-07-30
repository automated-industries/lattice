import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import {
  addSourceRoot,
  ingestSourceFolder,
  listSourceFolder,
  listSourceRoots,
  removeSourceRoot,
  type SourceRootDeps,
} from '../../src/ops/source-roots.js';
import { ingestPath, type IngestContext } from '../../src/ops/ingest-file.js';
import { ingestErrorCode } from '../../src/ops/ingest-errors.js';
import { readImportSource, applyImport } from '../../src/ops/import-apply.js';
import type { MutationCtx } from '../../src/gui/mutations.js';
import type { LocalFileIngestResult } from '../../src/ops/ingest-file.js';
import { folderSummary } from '../../src/cli-ingest.js';
import { importSummary } from '../../src/cli-import.js';
import * as lattice from '../../src/index.js';
import { CAPABILITIES } from '../../src/capabilities.js';

/**
 * Bringing documents in WITHOUT a server.
 *
 * The registry, the walk, the single-file read, and the whole structured import
 * used to exist only as request handlers, which meant a browser was the only way
 * to get a document into a workspace. These exercise the capability functions
 * directly — no request, no response, no dispatcher — because that is the whole
 * claim: the same operations, reachable from a script.
 *
 * A refusal is checked by its CODE rather than its wording. The code is what a
 * caller branches on, and a test that pinned the sentence would go green while
 * the thing a script reads changed underneath it.
 */

let cfgDir: string;
let workDir: string;
let wsDir: string;
let db: Lattice;
const ingested: string[] = [];

const fakeIngest = (p: string): Promise<LocalFileIngestResult> => {
  ingested.push(p);
  return Promise.resolve({ id: 'row-' + String(ingested.length), extraction_status: 'extracted' });
};

/** The config path a workspace is identified by; its registry sits next to it. */
function configPath(): string {
  return join(wsDir, 'workspace.yml');
}

function deps(): SourceRootDeps {
  return { db, ingestFile: fakeIngest, configPath: configPath() };
}

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'lattice-hi-cfg-'));
  workDir = mkdtempSync(join(tmpdir(), 'lattice-hi-work-'));
  wsDir = mkdtempSync(join(tmpdir(), 'lattice-hi-ws-'));
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  delete process.env.LATTICE_LOCAL_OPEN;
  ingested.length = 0;
  db = new Lattice(':memory:');
});
afterEach(() => {
  db.close();
  for (const d of [cfgDir, workDir, wsDir]) rmSync(d, { recursive: true, force: true });
});

/** Run `fn` and return the tagged code of whatever it threw. */
async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (e) {
    return ingestErrorCode(e);
  }
  return undefined;
}

describe('source roots without a server', () => {
  it('registers a folder, walks it, lists it, and forgets it', async () => {
    writeFileSync(join(workDir, 'a.txt'), 'a');
    mkdirSync(join(workDir, 'sub'));
    writeFileSync(join(workDir, 'sub', 'b.txt'), 'b');

    const added = await addSourceRoot(deps(), { path: workDir, kind: 'folder' });
    expect(added.root.path).toBe(workDir);
    expect(added.result).toMatchObject({ ingested: 2 });
    expect(ingested).toHaveLength(2);

    // The registry is durable and scoped to this workspace's own config path.
    expect(listSourceRoots(configPath()).map((r) => r.path)).toEqual([workDir]);

    // Forgetting reports whether anything matched, so a script cannot believe it
    // stopped watching a folder it is still watching.
    expect(removeSourceRoot(configPath(), 'no-such-id')).toEqual({ removed: false });
    expect(removeSourceRoot(configPath(), added.root.id)).toEqual({ removed: true });
    expect(listSourceRoots(configPath())).toEqual([]);
  });

  it('registering the same folder twice keeps one root and re-walks it', async () => {
    writeFileSync(join(workDir, 'a.txt'), 'a');
    const first = await addSourceRoot(deps(), { path: workDir, kind: 'folder' });
    const second = await addSourceRoot(deps(), { path: workDir, kind: 'folder' });
    // Same root, not a duplicate — this is what makes a re-run pick up changes.
    expect(second.root.id).toBe(first.root.id);
    expect(listSourceRoots(configPath())).toHaveLength(1);
    expect(ingested).toHaveLength(2); // walked once per call
  });

  it('refuses a path that is not there, and one that is the other kind', async () => {
    expect(
      await codeOf(() => addSourceRoot(deps(), { path: join(workDir, 'nope'), kind: 'folder' })),
    ).toBe('not_found');

    const file = join(workDir, 'a.txt');
    writeFileSync(file, 'a');
    expect(await codeOf(() => addSourceRoot(deps(), { path: file, kind: 'folder' }))).toBe(
      'invalid_request',
    );
    expect(await codeOf(() => addSourceRoot(deps(), { path: workDir, kind: 'file' }))).toBe(
      'invalid_request',
    );
    // Nothing was registered by any of the refusals.
    expect(listSourceRoots(configPath())).toEqual([]);
  });

  it('refuses to walk or list anywhere outside a registered root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'lattice-hi-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 's');
      await addSourceRoot(deps(), { path: workDir, kind: 'folder' });

      expect(await codeOf(() => ingestSourceFolder(deps(), outside))).toBe('outside_roots');
      expect(await codeOf(() => Promise.resolve(listSourceFolder(configPath(), outside)))).toBe(
        'outside_roots',
      );
      // A sibling whose name merely starts with the root's does not get in.
      expect(await codeOf(() => ingestSourceFolder(deps(), workDir + '-evil'))).toBe(
        'outside_roots',
      );
      expect(ingested).toHaveLength(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('walks a registered root when asked for it by path', async () => {
    writeFileSync(join(workDir, 'a.txt'), 'a');
    writeFileSync(join(workDir, 'b.txt'), 'b');
    await addSourceRoot(deps(), { path: workDir, kind: 'folder' });
    ingested.length = 0;
    const r = await ingestSourceFolder(deps(), workDir);
    expect(r).toMatchObject({ ingested: 2, skipped: 0, capped: false, scanTruncated: false });
  });
});

describe('ingesting one named file without a server', () => {
  // A pre-create refusal never touches the database, so a bare context is enough
  // to prove the refusal happens BEFORE any row exists.
  const bareCtx = () => ({ db }) as unknown as IngestContext;
  const bareMctx = () => ({}) as unknown as MutationCtx;

  it('refuses a path that names nothing', async () => {
    expect(
      await codeOf(() => ingestPath(bareCtx(), bareMctx(), join(workDir, 'missing.txt'))),
    ).toBe('not_found');
  });

  it('refuses a directory, which is the folder walk’s job', async () => {
    expect(await codeOf(() => ingestPath(bareCtx(), bareMctx(), workDir))).toBe('not_found');
  });
});

describe('importing a structured file without a server', () => {
  it('reads a JSON source and materializes it into tables and rows', async () => {
    const file = join(workDir, 'shop.json');
    writeFileSync(
      file,
      JSON.stringify({
        widgets: [
          { sku: 'a-1', name: 'Anvil', price: 10 },
          { sku: 'b-2', name: 'Rope', price: 4 },
        ],
      }),
    );
    const source = await readImportSource(file, 'shop.json');
    expect(Object.keys(source.data)).toEqual(['widgets']);

    // The import creates its tables live, which the schema layer only permits on
    // an initialized workspace — the same state a command or a request is in.
    await db.init();
    const result = await applyImport(
      {
        db,
        configPath: configPath(),
        latticeRoot: wsDir,
        validTables: new Set<string>(),
        softDeletable: new Set<string>(),
        feed: { publish: () => undefined } as never,
      },
      source,
      { mode: 'both' },
    );
    expect(result.tablesCreated).toContain('widgets');
    expect(result.rowsByTable.widgets).toBe(2);
    // The no-overwrite guarantee: a source carrying no date of its own is filed
    // under one anyway, so a later re-import appends rather than clobbering.
    expect(result.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('refuses a source whose bytes are not there, and one it cannot parse', async () => {
    expect(await codeOf(() => readImportSource(join(workDir, 'gone.json'), 'gone.json'))).toBe(
      'not_found',
    );
    const bad = join(workDir, 'bad.json');
    writeFileSync(bad, 'this is not json');
    expect(await codeOf(() => readImportSource(bad, 'bad.json'))).toBe('invalid_request');
    // A JSON array is valid JSON and still not an importable shape — saying so is
    // the difference between "nothing imported" and knowing why.
    const arr = join(workDir, 'arr.json');
    writeFileSync(arr, '[1,2,3]');
    expect(await codeOf(() => readImportSource(arr, 'arr.json'))).toBe('invalid_request');
  });
});

describe('what the command line prints', () => {
  it('a folder summary names what was left out, never only what came in', () => {
    expect(folderSummary('/docs', { ingested: 3, skipped: 0, scanned: 3 } as never)).toBe(
      'Ingested 3 of 3 files from /docs',
    );
    const capped = folderSummary('/docs', {
      ingested: 500,
      skipped: 2,
      scanned: 900,
      capped: true,
      scanTruncated: false,
    } as never);
    expect(capped).toContain('2 skipped');
    expect(capped).toContain('run it again for the rest');
  });

  it('an import summary counts tables WRITTEN, not tables created', () => {
    // A re-import of a known document creates nothing — every table is already
    // there — and "across 0 tables" after loading hundreds of rows reads as
    // though the run did nothing at all.
    const reimport = importSummary('book.xlsx', {
      mode: 'both',
      asOf: '2026-08-30',
      asOfColumn: null,
      tablesCreated: [],
      rowsByTable: { widgets: 200 },
      links: [],
      views: [],
    } as never);
    expect(reimport).toContain('200 rows across 1 table');
    expect(reimport).not.toContain('0 tables');
    expect(reimport).not.toContain('new:');
  });

  it('an import summary says what landed and under what date', () => {
    const line = importSummary('book.xlsx', {
      mode: 'both',
      asOf: '2026-07-30',
      asOfColumn: null,
      tablesCreated: ['widgets'],
      rowsByTable: { widgets: 12 },
      links: [],
      views: [],
    } as never);
    expect(line).toContain('12 rows');
    expect(line).toContain('(new: widgets)');
    expect(line).toContain('1 table');
    expect(line).toContain('2026-07-30 snapshot');
  });
});

describe('the ingest and import capabilities are on the public surface', () => {
  // The manifest already checks this mechanically; pinning the names here as
  // well is the difference between "a test walks the manifest" and "a consumer
  // can import these", which is the only thing that matters to a script.
  it('every named symbol is importable from the package entry point', () => {
    for (const name of [
      'ingestPath',
      'ingestBytes',
      'ingestText',
      'addSourceRoot',
      'removeSourceRoot',
      'ingestSourceFolder',
      'listSourceRoots',
      'readImportSource',
      'applyImport',
      'ingestErrorCode',
    ]) {
      expect(lattice, name).toHaveProperty(name);
    }
  });

  it('every ingest and import capability names a command somebody can run', () => {
    // These are the capabilities whose whole point is being scriptable, so a
    // manifest entry for one without a verb is a gap wearing a capability's coat.
    const scriptable = CAPABILITIES.filter(
      (c) => c.id.startsWith('ingest.') || c.id.startsWith('source-root.'),
    );
    expect(scriptable.length).toBeGreaterThan(0);
    expect(scriptable.filter((c) => c.cli === undefined).map((c) => c.id)).toEqual([
      // Bytes are the one shape a command line has no way to hand over: a
      // command is given a path, and a path is `ingest.path`. It exists for a
      // job or a library caller that already holds the bytes.
      'ingest.bytes',
    ]);
  });
});
