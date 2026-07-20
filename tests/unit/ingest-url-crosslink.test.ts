import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import type { MutationCtx } from '../../src/gui/mutations.js';
import { resetFetchPolicyState } from '../../src/ai/fetch-policy.js';

/**
 * The URL ingest path extracts the objects a page is about (createEntity is supplied),
 * so it must ALSO cross-link them — to each other and to existing records — exactly like
 * the text/file path, via the shared engine. This pins that ingestUrlAsFile forwards
 * `createObjectJunction` (and marks the content untrusted) to enrichWithLlm; the linking
 * logic itself is covered end-to-end by enrich-cross-link.test.ts.
 */

const enrichSpy = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
vi.mock('../../src/gui/ai/enrich.js', async (orig) => {
  const actual = await orig<typeof import('../../src/gui/ai/enrich.js')>();
  return { ...actual, enrichWithLlm: enrichSpy };
});
import { ingestUrlAsFile } from '../../src/gui/ingest-url.js';

function htmlResponder(body: string): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }),
    )) as unknown as typeof fetch;
}
const PAGE = `<!doctype html><html><head><title>Widgets</title></head><body>
  <article><h1>Widgets</h1><p>${'A thorough explanation of widgets and their uses. '.repeat(15)}</p></article>
</body></html>`;

describe('ingestUrlAsFile forwards createObjectJunction (URL cross-linking)', () => {
  let tmpDir: string;
  let db: Lattice;
  let mctx: MutationCtx;

  beforeEach(async () => {
    resetFetchPolicyState();
    enrichSpy.mockClear();
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-url-xlink-'));
    db = new Lattice(join(tmpDir, 'test.db'), { encryptionKey: 'url-xlink-key' });
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
    mctx = { db, feed: new FeedBus(), softDeletable: new Set(['files']), source: 'ingest' };
  });

  afterEach(() => {
    db.close();
    resetFetchPolicyState();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes createObjectJunction (and untrusted:true) through to enrichWithLlm', async () => {
    const createEntity = vi.fn(() => Promise.resolve<string | null>(null));
    const createObjectJunction = vi.fn(() => Promise.resolve(null));
    const { id } = await ingestUrlAsFile(
      {
        db,
        mctx,
        enrich: { fileJunctions: [], entityDescriptions: {}, createEntity, createObjectJunction },
      },
      'https://example.test/widgets',
      { fetcher: htmlResponder(PAGE), allowPrivate: true },
    );

    expect(enrichSpy).toHaveBeenCalledTimes(1);
    const a = enrichSpy.mock.calls[0] as unknown[];
    expect(a[2]).toBe(id); // fileId
    expect(a[9]).toBe(createEntity); // extract → new objects
    expect(a[10]).toBe(true); // untrusted (web content)
    expect(a[12]).toBe(createObjectJunction); // cross-link the extracted objects
  });
});
