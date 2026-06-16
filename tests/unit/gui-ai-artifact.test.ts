import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import { executeFunction, DISPATCHABLE, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { getFunction } from '../../src/gui/ai/registry.js';

describe('create_artifact tool', () => {
  let tmpDir: string;
  let db: Lattice;
  let feed: FeedBus;
  let ctx: DispatchCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-artifact-'));
    // encryptionKey: the native `secrets` entity declares encrypted:true.
    db = new Lattice(join(tmpDir, 'test.db'), { encryptionKey: 'artifact-test-key' });
    // The real native `files` entity (carries the new `artifact_type` column).
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
    ctx = {
      db,
      feed,
      validTables: new Set(['files']),
      junctionTables: new Set(),
      softDeletable: new Set(['files']),
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is registered as a dispatchable mutating row tool with title + content args', () => {
    const fn = getFunction('create_artifact');
    expect(fn).toBeDefined();
    expect(fn?.mutates).toBe(true);
    expect(fn?.category).toBe('row');
    expect(fn?.args.required).toEqual(expect.arrayContaining(['title', 'content']));
    expect(DISPATCHABLE.has('create_artifact')).toBe(true);
  });

  it('saves a markdown artifact in files and asks the GUI to open it', async () => {
    const events: FeedEvent[] = [];
    feed.subscribe((e) => events.push(e));

    const content = '# Plan\n\n- one\n- two\n';
    const res = await executeFunction(ctx, 'create_artifact', { title: 'My Plan', content });
    expect(res.ok).toBe(true);
    const result = res.result as { id: string; table: string; open: boolean };
    expect(result.table).toBe('files');
    expect(result.open).toBe(true);
    expect(typeof result.id).toBe('string');

    const row = (await db.get('files', result.id)) as Record<string, unknown>;
    expect(row.mime).toBe('text/markdown');
    expect(row.artifact_type).toBe('markdown');
    expect(row.extracted_text).toBe(content);
    expect(row.original_name).toBe('My Plan.md');
    expect(row.extraction_status).toBe('extracted');

    // Lands in the activity feed like any assistant write.
    expect(events.some((e) => e.table === 'files' && e.source === 'ai')).toBe(true);
  });

  it('does not double-append .md when the title already ends in .md', async () => {
    const res = await executeFunction(ctx, 'create_artifact', {
      title: 'notes.md',
      content: 'hi',
    });
    const row = (await db.get('files', (res.result as { id: string }).id)) as Record<
      string,
      unknown
    >;
    expect(row.original_name).toBe('notes.md');
  });

  it('rejects a missing title or content', async () => {
    expect((await executeFunction(ctx, 'create_artifact', { content: 'x' })).ok).toBe(false);
    expect((await executeFunction(ctx, 'create_artifact', { title: 'x' })).ok).toBe(false);
  });

  it('private mode still creates the row (visibility forcing degrades to a plain insert on SQLite)', async () => {
    const res = await executeFunction({ ...ctx, privateMode: true }, 'create_artifact', {
      title: 'Secret',
      content: '# secret',
    });
    expect(res.ok).toBe(true);
    const row = (await db.get('files', (res.result as { id: string }).id)) as Record<
      string,
      unknown
    >;
    expect(row.artifact_type).toBe('markdown');
  });
});
