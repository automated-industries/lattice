import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import type { MutationCtx } from '../../src/gui/mutations.js';
import { enrichWithLlm } from '../../src/gui/ai/enrich.js';
import type { TurnParams, TurnResult } from '../../src/gui/ai/chat.js';

/**
 * The ingest engine's last-resort capture: when a document linked to nothing and
 * produced no extracted objects, and inference is turned up high, the content is
 * still kept rather than lost.
 *
 * That capture now lands in the document-artifact store — a `files` row flagged
 * `artifact_type='markdown'` — which is the surface the user actually browses.
 * It must NOT create a generic note row: those are no longer surfaced, so a
 * capture written there would accumulate where nobody can find it. The trigger
 * conditions and the captured content are unchanged; only the destination moved.
 */

const scripted = vi.hoisted(() => ({
  summary: 'A quarterly revenue rundown.',
  classifyJson: '```json\n[]\n```',
  extractJson: '```json\n[]\n```',
}));

vi.mock('../../src/gui/ai/chat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/gui/ai/chat.js')>();
  return {
    ...actual,
    createAnthropicClient: () => ({
      runTurn(params: TurnParams): Promise<TurnResult> {
        const sys = params.system;
        let text = '';
        if (sys.includes('one or two sentence')) text = scripted.summary;
        else if (sys.includes('which existing records')) text = scripted.classifyJson;
        else if (sys.includes('extracting the key structured objects')) text = scripted.extractJson;
        return Promise.resolve({ stopReason: 'end_turn', text, toolUses: [] });
      },
    }),
  };
});
vi.mock('../../src/ops/ai-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ops/ai-config.js')>();
  return { ...actual, resolveClaudeAuth: () => Promise.resolve({ apiKey: 'test-key' }) };
});

describe('enrich last-resort capture writes a markdown artifact, not a note', () => {
  let tmpDir: string;
  let cfgDir: string;
  let db: Lattice;
  let feed: FeedBus;
  let feedEvents: FeedEvent[];
  let mctx: MutationCtx;
  let fileId: string;

  const t = (cols: Record<string, string>, out: string) => ({
    columns: cols,
    render: () => '',
    outputFile: out,
  });

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-enrich-fallback-'));
    cfgDir = mkdtempSync(join(tmpdir(), 'lattice-enrich-fallback-cfg-'));
    process.env.LATTICE_CONFIG_DIR = cfgDir;
    scripted.summary = 'A quarterly revenue rundown.';
    scripted.classifyJson = '```json\n[]\n```';
    scripted.extractJson = '```json\n[]\n```';
    db = new Lattice(join(tmpDir, 'test.db'));
    db.define(
      'files',
      t(
        {
          id: 'TEXT PRIMARY KEY',
          slug: 'TEXT',
          name: 'TEXT',
          title: 'TEXT',
          original_name: 'TEXT',
          mime: 'TEXT',
          size_bytes: 'INTEGER',
          description: 'TEXT',
          extracted_text: 'TEXT',
          extraction_status: 'TEXT',
          artifact_type: 'TEXT',
          deleted_at: 'TEXT',
        },
        '.s/files.md',
      ),
    );
    db.define(
      'notes',
      t(
        {
          id: 'TEXT PRIMARY KEY',
          title: 'TEXT',
          body: 'TEXT',
          source_file_id: 'TEXT',
          deleted_at: 'TEXT',
        },
        '.s/notes.md',
      ),
    );
    // A writable entity with records, so the classifier has a non-empty catalog
    // and the run genuinely reaches the "linked nothing" state.
    db.define(
      'suppliers',
      t({ id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' }, '.s/suppliers.md'),
    );
    db.define(
      '_lattice_gui_audit',
      t(
        {
          id: 'TEXT PRIMARY KEY',
          ts: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
          table_name: 'TEXT NOT NULL',
          row_id: 'TEXT',
          operation: 'TEXT NOT NULL',
          before_json: 'TEXT',
          after_json: 'TEXT',
          undone: 'INTEGER NOT NULL DEFAULT 0',
        },
        '.s/audit.md',
      ),
    );
    await db.init();
    fileId = await db.insert('files', {
      original_name: 'Q3 Revenue.txt',
      extracted_text: 'Revenue was up.',
    });
    await db.insert('suppliers', { name: 'Acme Corp' });
    feed = new FeedBus();
    feedEvents = [];
    feed.subscribe((e) => feedEvents.push(e));
    mctx = { db, feed, softDeletable: new Set(['files', 'notes', 'suppliers']), source: 'ingest' };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  });

  // 0.8 clears the last-resort threshold (>= 0.66). No junction creator and no
  // entity creator, so nothing links and nothing is created — the exact state the
  // capture exists for.
  function run(aggressiveness: number): ReturnType<typeof enrichWithLlm> {
    return enrichWithLlm(
      mctx,
      db,
      fileId,
      'Revenue was up across every region this quarter.',
      'Q3 Revenue.txt',
      [], // junctions
      {}, // descriptions
      undefined, // createJunction
      aggressiveness,
      undefined, // createEntity
    );
  }

  async function liveRows(table: string): Promise<Record<string, unknown>[]> {
    const rows = (await db.query(table, {})) as Record<string, unknown>[];
    return rows.filter((r) => !r.deleted_at);
  }

  it('captures the source as a markdown file artifact and creates no note', async () => {
    await run(0.8);

    expect(await liveRows('notes')).toEqual([]);

    const artifacts = (await liveRows('files')).filter((r) => r.artifact_type === 'markdown');
    expect(artifacts.length).toBe(1);
    const artifact = artifacts[0] ?? {};
    // Same content the note carried: the summary as the body, the file's name
    // (extension stripped) as the title.
    expect(artifact.extracted_text).toBe('A quarterly revenue rundown.');
    expect(artifact.title).toBe('Q3 Revenue');
    expect(artifact.mime).toBe('text/markdown');
    expect(String(artifact.original_name)).toMatch(/\.md$/);
    expect(artifact.id).not.toBe(fileId); // a new row, not the source file
    // And the capture is announced, so the user can find it.
    expect(feedEvents.some((e) => (e.summary ?? '').includes('Q3 Revenue'))).toBe(true);
  });

  it('falls back to the document text when there is no summary', async () => {
    scripted.summary = '';
    await run(0.8);
    const artifacts = (await liveRows('files')).filter((r) => r.artifact_type === 'markdown');
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]?.extracted_text).toBe('Revenue was up across every region this quarter.');
    expect(await liveRows('notes')).toEqual([]);
  });

  it('does not capture below the aggressiveness threshold', async () => {
    await run(0.5);
    expect((await liveRows('files')).filter((r) => r.artifact_type === 'markdown')).toEqual([]);
    expect(await liveRows('notes')).toEqual([]);
  });
});
