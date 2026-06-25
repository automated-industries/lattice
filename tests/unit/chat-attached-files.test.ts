import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { buildAttachedFilesNote } from '../../src/gui/chat-routes.js';

/**
 * Regression: attaching files to a chat message must CONNECT the message to those
 * files. The reported bug was "I attached 3 screenshots with 'analyze these' and the
 * assistant said it didn't see any attached" — the message was never linked to the
 * just-ingested files. buildAttachedFilesNote is the connective tissue: it grounds
 * the attached ids against the visible files table and produces the note prefixed to
 * the model's turn so it works on exactly those files. Generic across file types.
 */
describe('buildAttachedFilesNote — connects a chat message to its attached files', () => {
  let tmpDir: string;
  let db: Lattice;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-attach-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    db.define('files', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', original_name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'files.md',
    });
    await db.init();
    await db.insert('files', { id: 'f1', name: 'memo.md' });
    await db.insert('files', { id: 'f2', name: 'screenshot.png' });
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty note when nothing is attached', async () => {
    expect(await buildAttachedFilesNote(db, undefined)).toBe('');
    expect(await buildAttachedFilesNote(db, [])).toBe('');
  });

  it('names a single attached file so the assistant connects the request to it', async () => {
    const note = await buildAttachedFilesNote(db, [{ id: 'f1' }]);
    expect(note).toContain('memo.md');
    expect(note).toContain('f1');
    expect(note).toContain('this file');
    expect(note).toMatch(/added to their Files/);
  });

  it('names multiple attached files (the reported case: several screenshots at once)', async () => {
    const note = await buildAttachedFilesNote(db, [{ id: 'f1' }, { id: 'f2' }]);
    expect(note).toContain('memo.md');
    expect(note).toContain('screenshot.png');
    expect(note).toContain('these files');
  });

  it('drops stale/invisible ids instead of inventing a reference', async () => {
    expect(await buildAttachedFilesNote(db, [{ id: 'does-not-exist' }])).toBe('');
    const note = await buildAttachedFilesNote(db, [{ id: 'f1' }, { id: 'ghost' }]);
    expect(note).toContain('memo.md');
    expect(note).not.toContain('ghost');
    expect(note).toContain('this file'); // singular — only the real one survived
  });
});
