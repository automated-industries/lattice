import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import type { MutationCtx } from '../../src/gui/mutations.js';
import { ingestUrlAsFile } from '../../src/gui/ingest-url.js';
import { FetchBudget, resetFetchPolicyState } from '../../src/ai/fetch-policy.js';

function htmlResponder(body: string, contentType = 'text/html'): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': contentType } }),
    )) as unknown as typeof fetch;
}

const PAGE = `<!doctype html><html><head><title>Widgets Guide</title></head><body>
  <article><h1>Widgets</h1><p>${'A thorough explanation of widgets and their uses. '.repeat(15)}</p></article>
</body></html>`;

describe('ingestUrlAsFile', () => {
  let tmpDir: string;
  let db: Lattice;
  let mctx: MutationCtx;

  beforeEach(async () => {
    resetFetchPolicyState();
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-ingest-url-'));
    db = new Lattice(join(tmpDir, 'test.db'), { encryptionKey: 'ingest-url-test-key' });
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

  it('saves the fetched page as a cloud_ref files row flagged untrusted', async () => {
    const result = await ingestUrlAsFile({ db, mctx }, 'https://example.test/widgets', {
      fetcher: htmlResponder(PAGE),
      allowPrivate: true,
    });

    expect(result.title).toBe('Widgets Guide');
    expect(result.url).toBe('https://example.test/widgets');
    expect(result.charsExtracted).toBeGreaterThan(0);

    const row = (await db.get('files', result.id)) as Record<string, unknown>;
    expect(row.ref_kind).toBe('cloud_ref');
    expect(row.ref_provider).toBe('web');
    expect(row.ref_uri).toBe('https://example.test/widgets');
    expect(String(row.extracted_text)).toMatch(/thorough explanation of widgets/);
    expect(row.extraction_status).toBe('extracted');
    const source = JSON.parse(String(row.source_json)) as { origin?: string; untrusted?: boolean };
    expect(source.origin).toBe('web_fetch');
    expect(source.untrusted).toBe(true);
  });

  it('THROWS when the page yields no readable text (never stores the URL as a doc)', async () => {
    await expect(
      ingestUrlAsFile({ db, mctx }, 'https://example.test/empty', {
        fetcher: htmlResponder('<html><body></body></html>'),
        allowPrivate: true,
      }),
    ).rejects.toThrow(/no readable text/i);
    // Nothing was persisted.
    const rows = await db.query('files', {});
    expect(rows.length).toBe(0);
  });

  it('enforces the per-turn fetch budget before fetching', async () => {
    const budget = new FetchBudget(0); // already exhausted
    await expect(
      ingestUrlAsFile({ db, mctx }, 'https://example.test/widgets', {
        fetcher: htmlResponder(PAGE),
        allowPrivate: true,
        budget,
      }),
    ).rejects.toThrow(/budget exhausted/i);
  });

  it('refuses a block-listed host (deployment policy)', async () => {
    const saved = process.env.LATTICE_URL_BLOCK_DOMAINS;
    process.env.LATTICE_URL_BLOCK_DOMAINS = 'example.test';
    try {
      await expect(
        ingestUrlAsFile({ db, mctx }, 'https://example.test/widgets', {
          fetcher: htmlResponder(PAGE),
          allowPrivate: true,
        }),
      ).rejects.toThrow(/block-list/i);
    } finally {
      if (saved === undefined) delete process.env.LATTICE_URL_BLOCK_DOMAINS;
      else process.env.LATTICE_URL_BLOCK_DOMAINS = saved;
    }
  });
});
