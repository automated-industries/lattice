import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { executeFunction, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { runChat, type LlmClient, type TurnResult } from '../../src/gui/ai/chat.js';

describe('Artifact authoring (create_artifact delegated vs. content)', () => {
  let tmpDir: string;
  let db: Lattice;
  let feed: FeedBus;
  let ctx: DispatchCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-artifact-'));
    db = new Lattice(join(tmpDir, 'test.db'));

    // Define files table (where artifacts go)
    db.define('files', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT',
        extracted_text: 'TEXT',
        artifact_type: 'TEXT',
        created_at: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: 'files.md',
    });

    // Define audit table (required for createRow)
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

  it('create_artifact with content creates a file with the markdown', async () => {
    const res = await executeFunction(ctx, 'create_artifact', {
      title: 'My Document',
      content: '# Hello\n\nThis is a test document.',
    });

    expect(res.ok).toBe(true);
    const id = (res.result as { id: string }).id;
    expect(id).toBeTruthy();

    // Verify the file was created
    const row = await db.get('files', id);
    expect(row).toBeTruthy();
    expect((row as { name: string }).name).toBe('My Document');
    expect((row as { extracted_text: string }).extracted_text).toBe(
      '# Hello\n\nThis is a test document.',
    );
    expect((row as { artifact_type: string }).artifact_type).toBe('markdown');
  });

  it('create_artifact with spec calls the markdownAuthor', async () => {
    let authorCalled = false;
    let authorSpec = '';

    ctx.markdownAuthor = async (spec: string) => {
      authorCalled = true;
      authorSpec = spec;
      return '# Authored Markdown\n\nThis was authored by the sub-call.';
    };

    const res = await executeFunction(ctx, 'create_artifact', {
      title: 'Big Report',
      spec: 'Write a comprehensive report about quarterly results.',
    });

    expect(res.ok).toBe(true);
    expect(authorCalled).toBe(true);
    expect(authorSpec).toBe('Write a comprehensive report about quarterly results.');

    // Verify the file contains the authored content
    const id = (res.result as { id: string }).id;
    const row = await db.get('files', id);
    expect((row as { extracted_text: string }).extracted_text).toBe(
      '# Authored Markdown\n\nThis was authored by the sub-call.',
    );
  });

  it('create_artifact with neither content nor spec returns clear error', async () => {
    const res = await executeFunction(ctx, 'create_artifact', {
      title: 'My Document',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('create_artifact requires either');
    expect(res.error).toContain('content');
    expect(res.error).toContain('spec');
  });

  it('create_artifact with both content and spec returns clear error', async () => {
    const res = await executeFunction(ctx, 'create_artifact', {
      title: 'My Document',
      content: 'Some content',
      spec: 'Some spec',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('exactly one of `content` or `spec`, not both');
  });

  it('create_artifact with spec but no markdownAuthor returns clear error', async () => {
    ctx.markdownAuthor = undefined;

    const res = await executeFunction(ctx, 'create_artifact', {
      title: 'Big Report',
      spec: 'Write a report.',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('Markdown authoring is unavailable');
  });

  it('create_artifact result includes open:true for GUI navigation', async () => {
    const res = await executeFunction(ctx, 'create_artifact', {
      title: 'My Document',
      content: 'Test',
    });

    expect(res.ok).toBe(true);
    const result = res.result as { open: boolean; table: string };
    expect(result.open).toBe(true);
    expect(result.table).toBe('files');
  });

  // ── max_tokens truncation detection ──────────────────────────────────────
  // max_tokens can clip the TEXT after a complete tool_use block, so the
  // truncation error must key off the ARGS being absent — a create_artifact
  // call that carries content (or spec) dispatches normally even when the turn
  // stopped at max_tokens; only an args-less call gets the steer-to-spec error.
  describe('truncation detection (stop_reason max_tokens)', () => {
    function scriptedClient(turns: TurnResult[]): LlmClient {
      let i = 0;
      return {
        runTurn: () => Promise.resolve(turns[Math.min(i++, turns.length - 1)]!),
      };
    }

    async function drive(client: LlmClient) {
      const records: { name: string; isError: boolean; errorText?: string }[] = [];
      const gen = runChat({
        client,
        dispatch: ctx,
        userMessage: 'make me a doc',
        onToolRecord: (rec) => {
          records.push({
            name: rec.name,
            isError: rec.isError,
            ...(rec.errorText ? { errorText: rec.errorText } : {}),
          });
        },
      });
      for await (const _ev of gen) {
        // drain the stream; assertions are on records + db state
      }
      return records;
    }

    it('dispatches a COMPLETE create_artifact call even when the turn stopped at max_tokens', async () => {
      const records = await drive(
        scriptedClient([
          {
            stopReason: 'max_tokens',
            text: '',
            toolUses: [
              {
                id: 't1',
                name: 'create_artifact',
                input: { title: 'Doc', content: '# Hello\n\nA complete short document.' },
              },
            ],
          },
          { stopReason: 'end_turn', text: 'done', toolUses: [] },
        ]),
      );
      const rec = records.find((r) => r.name === 'create_artifact');
      expect(rec).toBeDefined();
      expect(rec!.isError).toBe(false);
      const rows = await db.query('files', {});
      expect(rows.length).toBe(1);
    });

    it('returns the steer-to-spec error for an args-less create_artifact call at max_tokens', async () => {
      const records = await drive(
        scriptedClient([
          {
            stopReason: 'max_tokens',
            text: '',
            toolUses: [{ id: 't1', name: 'create_artifact', input: { title: 'Doc' } }],
          },
          { stopReason: 'end_turn', text: 'ok', toolUses: [] },
        ]),
      );
      const rec = records.find((r) => r.name === 'create_artifact');
      expect(rec).toBeDefined();
      expect(rec!.isError).toBe(true);
      expect(rec!.errorText).toContain('cut off due to output token limit');
      expect(rec!.errorText).toContain('spec');
      const rows = await db.query('files', {});
      expect(rows.length).toBe(0);
    });
  });
});
