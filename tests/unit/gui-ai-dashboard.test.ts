import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import { executeFunction, DISPATCHABLE, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { getFunction } from '../../src/gui/ai/registry.js';
import { extractSourceTables } from '../../src/gui/dashboard-row.js';

describe('create_dashboard / edit_dashboard tools', () => {
  let tmpDir: string;
  let db: Lattice;
  let feed: FeedBus;
  let ctx: DispatchCtx;
  let authorCalls: { spec: string; current?: string }[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-dashboard-'));
    db = new Lattice(join(tmpDir, 'test.db'), { encryptionKey: 'dashboard-test-key' });
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
    // a model. Returns a distinct document for create vs edit, echoing the input,
    // and reads a table so source_tables extraction has something to find.
    ctx = {
      db,
      feed,
      validTables: new Set(['files', 'dashboards', 'widgets']),
      junctionTables: new Set(),
      softDeletable: new Set(['files', 'dashboards']),
      htmlAuthor: (spec: string, current?: string) => {
        authorCalls.push({ spec, ...(current !== undefined ? { current } : {}) });
        const body = current ? `edited:${spec}` : `created:${spec}`;
        return Promise.resolve(
          `<!doctype html><html><body>${body}<script>lattice.query('widgets', { limit: 50 })</scr` +
            `ipt></body></html>`,
        );
      },
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers both tools as dispatchable mutating row tools', () => {
    const create = getFunction('create_dashboard');
    expect(create?.mutates).toBe(true);
    expect(create?.category).toBe('row');
    expect(create?.args.required).toEqual(expect.arrayContaining(['title', 'spec']));
    expect(DISPATCHABLE.has('create_dashboard')).toBe(true);

    const edit = getFunction('edit_dashboard');
    expect(edit?.mutates).toBe(true);
    expect(edit?.args.required).toEqual(expect.arrayContaining(['instruction']));
    expect(DISPATCHABLE.has('edit_dashboard')).toBe(true);

    // The pre-5.0 html-file tools are gone — not silently aliased.
    expect(getFunction('create_html_file')).toBeUndefined();
    expect(DISPATCHABLE.has('create_html_file')).toBe(false);
  });

  it('create_dashboard saves a dashboards row and asks the GUI to open it', async () => {
    const events: FeedEvent[] = [];
    feed.subscribe((e) => events.push(e));

    const res = await executeFunction(ctx, 'create_dashboard', {
      title: 'Revenue',
      spec: 'a bar chart of widgets',
    });
    expect(res.ok).toBe(true);
    const result = res.result as { id: string; table: string; open: boolean };
    expect(result.table).toBe('dashboards');
    expect(result.open).toBe(true);

    const row = (await db.get('dashboards', result.id)) as Record<string, unknown>;
    expect(row.title).toBe('Revenue');
    expect(String(row.html)).toContain('created:a bar chart of widgets');
    expect(row.spec).toBe('a bar chart of widgets');
    // source_tables recorded from the authored page's lattice.query calls.
    expect(JSON.parse(String(row.source_tables))).toEqual(['widgets']);

    // The author got the spec; the write lands in the activity feed like any AI write.
    expect(authorCalls).toEqual([{ spec: 'a bar chart of widgets' }]);
    expect(events.some((e) => e.table === 'dashboards' && e.source === 'ai')).toBe(true);
  });

  it('reports unavailable (fails loud) when no author client is configured', async () => {
    const res = await executeFunction({ ...ctx, htmlAuthor: undefined }, 'create_dashboard', {
      title: 'X',
      spec: 'y',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unavailable/i);
  });

  it('rejects a missing title or spec', async () => {
    expect((await executeFunction(ctx, 'create_dashboard', { spec: 'x' })).ok).toBe(false);
    expect((await executeFunction(ctx, 'create_dashboard', { title: 'x' })).ok).toBe(false);
  });

  it('edit_dashboard rewrites the SAME row in place, passing the current page', async () => {
    const created = (
      (await executeFunction(ctx, 'create_dashboard', { title: 'Page', spec: 'first' })).result as {
        id: string;
      }
    ).id;

    const res = await executeFunction(ctx, 'edit_dashboard', {
      id: created,
      instruction: 'make it blue',
    });
    expect(res.ok).toBe(true);
    const result = res.result as { id: string; table: string; open: boolean };
    expect(result.id).toBe(created); // same row, no new dashboard
    expect(result.open).toBe(true);

    const row = (await db.get('dashboards', created)) as Record<string, unknown>;
    expect(String(row.html)).toContain('edited:make it blue');
    // The spec keeps a trail: original spec + the edit instruction.
    expect(String(row.spec)).toContain('first');
    expect(String(row.spec)).toContain('make it blue');
    // The author received the prior document so it can modify rather than restart.
    expect(authorCalls[authorCalls.length - 1]?.current).toContain('created:first');
  });

  it('edit_dashboard targets the open dashboard (activeDashboardId) when no id is given', async () => {
    const created = (
      (await executeFunction(ctx, 'create_dashboard', { title: 'Page', spec: 'first' })).result as {
        id: string;
      }
    ).id;

    const res = await executeFunction({ ...ctx, activeDashboardId: created }, 'edit_dashboard', {
      instruction: 'add a footer',
    });
    expect(res.ok).toBe(true);
    expect((res.result as { id: string }).id).toBe(created);
  });

  it('edit_dashboard errors when there is no resolvable target', async () => {
    const res = await executeFunction(ctx, 'edit_dashboard', { instruction: 'tweak it' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no dashboard/i);
  });

  it('edit_dashboard errors on an id that is not a dashboard', async () => {
    const res = await executeFunction(ctx, 'edit_dashboard', {
      id: 'no-such-row',
      instruction: 'x',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no dashboard/i);
  });

  // ── Planting gate: dashboards.html is reserved to the trusted tools ─────────
  it('refuses to plant an executable page via the generic create_row tool', async () => {
    const res = await executeFunction(ctx, 'create_row', {
      table: 'dashboards',
      values: { title: 'evil', html: '<script>EVIL()</scr' + 'ipt>' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/create_dashboard/i);
  });

  it('refuses to rewrite a dashboard page via the generic update_row tool', async () => {
    const created = (
      (await executeFunction(ctx, 'create_dashboard', { title: 'Page', spec: 'first' })).result as {
        id: string;
      }
    ).id;
    const res = await executeFunction(ctx, 'update_row', {
      table: 'dashboards',
      id: created,
      values: { html: '<script>EVIL()</scr' + 'ipt>' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/create_dashboard|edit_dashboard/i);
    // The legitimate content is untouched.
    const row = (await db.get('dashboards', created)) as Record<string, unknown>;
    expect(String(row.html)).toContain('created:first');
  });

  it('refuses html via bulk_update too', async () => {
    await executeFunction(ctx, 'create_dashboard', { title: 'Page', spec: 'first' });
    const res = await executeFunction(ctx, 'bulk_update', {
      table: 'dashboards',
      values: { html: 'x' },
    });
    expect(res.ok).toBe(false);
  });

  it('still allows non-page edits (title, description) via update_row', async () => {
    const created = (
      (await executeFunction(ctx, 'create_dashboard', { title: 'Page', spec: 'first' })).result as {
        id: string;
      }
    ).id;
    const res = await executeFunction(ctx, 'update_row', {
      table: 'dashboards',
      id: created,
      values: { title: 'Renamed', description: 'a friendly label' },
    });
    expect(res.ok).toBe(true);
    const row = (await db.get('dashboards', created)) as Record<string, unknown>;
    expect(row.title).toBe('Renamed');
  });

  // ── Read redaction: the page body never reaches the model ───────────────────
  it('get_row and list_rows redact the html body but keep spec/source_tables readable', async () => {
    const created = (
      (await executeFunction(ctx, 'create_dashboard', { title: 'Page', spec: 'first' })).result as {
        id: string;
      }
    ).id;

    const got = await executeFunction(ctx, 'get_row', { table: 'dashboards', id: created });
    expect(got.ok).toBe(true);
    const row = got.result as Record<string, unknown>;
    expect(String(row.html)).toMatch(/edit_dashboard/);
    expect(String(row.html)).not.toContain('created:first');
    expect(row.spec).toBe('first');

    const listed = await executeFunction(ctx, 'list_rows', { table: 'dashboards' });
    expect(listed.ok).toBe(true);
    const rows = listed.result as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.html)).not.toContain('created:first');
  });

  // ── Defense in depth: the pre-5.0 files html-artifact guard still holds ─────
  it('still refuses forging an executable html FILE artifact via create_row', async () => {
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

  it('still refuses rewriting a legacy html FILE artifact body via update_row', async () => {
    // Plant a legacy html artifact directly (simulates a pre-migration row).
    const id = 'legacy-html-artifact';
    await db.insert('files', {
      id,
      original_name: 'Legacy.html',
      mime: 'text/html',
      artifact_type: 'html',
      extracted_text: '<!doctype html><html><body>legacy</body></html>',
    });
    const res = await executeFunction(ctx, 'update_row', {
      table: 'files',
      id,
      values: { extracted_text: '<script>EVIL()</scr' + 'ipt>' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/executable html file/i);
  });
});

describe('extractSourceTables', () => {
  it('collects unique string-literal table names from lattice.query/get calls', () => {
    const html = `
      <script>
        const a = await lattice.query('orders', { limit: 10 });
        const b = await lattice.query("orders");
        const c = await lattice.get('customers', someId);
        const d = await lattice.search('free text — not a table');
      </script>`;
    expect(extractSourceTables(html)).toEqual(['orders', 'customers']);
  });

  it('returns null when the page reads no tables', () => {
    expect(extractSourceTables('<html><body>static</body></html>')).toBeNull();
  });
});
