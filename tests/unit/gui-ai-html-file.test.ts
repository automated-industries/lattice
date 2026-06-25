import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import { executeFunction, DISPATCHABLE, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { getFunction } from '../../src/gui/ai/registry.js';

describe('create_html_file / edit_html_file tools', () => {
  let tmpDir: string;
  let db: Lattice;
  let feed: FeedBus;
  let ctx: DispatchCtx;
  let authorCalls: { spec: string; current?: string }[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-htmlfile-'));
    db = new Lattice(join(tmpDir, 'test.db'), { encryptionKey: 'html-file-test-key' });
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
    authorCalls = [];
    // Stub the delegated authoring sub-call so the handler logic is tested without
    // a model. Returns a distinct document for create vs edit, echoing the input.
    ctx = {
      db,
      feed,
      validTables: new Set(['files']),
      junctionTables: new Set(),
      softDeletable: new Set(['files']),
      htmlAuthor: (spec: string, current?: string) => {
        authorCalls.push({ spec, ...(current !== undefined ? { current } : {}) });
        return Promise.resolve(
          current
            ? `<!doctype html><html><body>edited:${spec}</body></html>`
            : `<!doctype html><html><body>created:${spec}</body></html>`,
        );
      },
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers both tools as dispatchable mutating row tools', () => {
    const create = getFunction('create_html_file');
    expect(create?.mutates).toBe(true);
    expect(create?.category).toBe('row');
    expect(create?.args.required).toEqual(expect.arrayContaining(['title', 'spec']));
    expect(DISPATCHABLE.has('create_html_file')).toBe(true);

    const edit = getFunction('edit_html_file');
    expect(edit?.mutates).toBe(true);
    expect(edit?.args.required).toEqual(expect.arrayContaining(['instruction']));
    expect(DISPATCHABLE.has('edit_html_file')).toBe(true);
  });

  it('create_html_file saves an html artifact and asks the GUI to open it', async () => {
    const events: FeedEvent[] = [];
    feed.subscribe((e) => events.push(e));

    const res = await executeFunction(ctx, 'create_html_file', {
      title: 'My Page',
      spec: 'a bar chart of widgets',
    });
    expect(res.ok).toBe(true);
    const result = res.result as { id: string; table: string; open: boolean };
    expect(result.table).toBe('files');
    expect(result.open).toBe(true);

    const row = (await db.get('files', result.id)) as Record<string, unknown>;
    expect(row.mime).toBe('text/html');
    expect(row.artifact_type).toBe('html');
    expect(row.original_name).toBe('My Page.html');
    expect(String(row.extracted_text)).toContain('created:a bar chart of widgets');
    expect(row.extraction_status).toBe('extracted');

    // The author got the spec; the write lands in the activity feed like any AI write.
    expect(authorCalls).toEqual([{ spec: 'a bar chart of widgets' }]);
    expect(events.some((e) => e.table === 'files' && e.source === 'ai')).toBe(true);
  });

  it('reports unavailable (fails loud) when no author client is configured', async () => {
    const res = await executeFunction({ ...ctx, htmlAuthor: undefined }, 'create_html_file', {
      title: 'X',
      spec: 'y',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unavailable/i);
  });

  it('rejects a missing title or spec', async () => {
    expect((await executeFunction(ctx, 'create_html_file', { spec: 'x' })).ok).toBe(false);
    expect((await executeFunction(ctx, 'create_html_file', { title: 'x' })).ok).toBe(false);
  });

  it('edit_html_file rewrites the SAME row in place, passing the current HTML', async () => {
    const created = (
      (await executeFunction(ctx, 'create_html_file', { title: 'Page', spec: 'first' })).result as {
        id: string;
      }
    ).id;

    const res = await executeFunction(ctx, 'edit_html_file', {
      id: created,
      instruction: 'make it blue',
    });
    expect(res.ok).toBe(true);
    const result = res.result as { id: string; table: string; open: boolean };
    expect(result.id).toBe(created); // same row, no new file
    expect(result.open).toBe(true);

    const row = (await db.get('files', created)) as Record<string, unknown>;
    expect(String(row.extracted_text)).toContain('edited:make it blue');
    // The author received the prior document so it can modify rather than restart.
    expect(authorCalls[authorCalls.length - 1]?.current).toContain('created:first');
  });

  it('edit_html_file targets the open html file (activeHtmlFileId) when no id is given', async () => {
    const created = (
      (await executeFunction(ctx, 'create_html_file', { title: 'Page', spec: 'first' })).result as {
        id: string;
      }
    ).id;

    const res = await executeFunction({ ...ctx, activeHtmlFileId: created }, 'edit_html_file', {
      instruction: 'add a footer',
    });
    expect(res.ok).toBe(true);
    expect((res.result as { id: string }).id).toBe(created);
  });

  it('edit_html_file errors when there is no resolvable target', async () => {
    const res = await executeFunction(ctx, 'edit_html_file', { instruction: 'tweak it' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no html file/i);
  });

  it('edit_html_file refuses a row that is not an html artifact', async () => {
    const md = (
      (await executeFunction(ctx, 'create_artifact', { title: 'Note', content: '# hi' }))
        .result as { id: string }
    ).id;
    const res = await executeFunction(ctx, 'edit_html_file', { id: md, instruction: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not an html file/i);
  });

  // ── Planting gate: artifact_type='html' is reserved to the trusted tools ──────
  it('refuses to forge an executable html artifact via the generic create_row tool', async () => {
    const res = await executeFunction(ctx, 'create_row', {
      table: 'files',
      values: {
        original_name: 'evil.html',
        mime: 'text/html',
        artifact_type: 'html',
        extracted_text: '<script>EVIL()</scr' + 'ipt>',
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/artifact_type/i);
  });

  it('refuses to flip an existing file into an executable html artifact via update_row', async () => {
    const md = (
      (await executeFunction(ctx, 'create_artifact', { title: 'Note', content: '# hi' }))
        .result as { id: string }
    ).id;
    const res = await executeFunction(ctx, 'update_row', {
      table: 'files',
      id: md,
      values: { mime: 'text/html', artifact_type: 'html' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/artifact_type/i);
  });

  it('does NOT block a normal markdown artifact (artifact_type=markdown) — only html is reserved', async () => {
    const res = await executeFunction(ctx, 'create_artifact', { title: 'Doc', content: '# ok' });
    expect(res.ok).toBe(true);
    const row = (await db.get('files', (res.result as { id: string }).id)) as Record<
      string,
      unknown
    >;
    expect(row.artifact_type).toBe('markdown');
  });

  it('refuses to rewrite an existing html artifact body via the generic update_row tool', async () => {
    const created = (
      (await executeFunction(ctx, 'create_html_file', { title: 'Page', spec: 'first' })).result as {
        id: string;
      }
    ).id;
    const res = await executeFunction(ctx, 'update_row', {
      table: 'files',
      id: created,
      values: { extracted_text: '<script>EVIL()</scr' + 'ipt>' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/executable html file/i);
    // The legitimate content is untouched.
    const row = (await db.get('files', created)) as Record<string, unknown>;
    expect(String(row.extracted_text)).toContain('created:first');
  });

  it('still allows non-body edits to an html artifact (e.g. description) via update_row', async () => {
    const created = (
      (await executeFunction(ctx, 'create_html_file', { title: 'Page', spec: 'first' })).result as {
        id: string;
      }
    ).id;
    const res = await executeFunction(ctx, 'update_row', {
      table: 'files',
      id: created,
      values: { description: 'a friendly label' },
    });
    expect(res.ok).toBe(true);
  });
});
