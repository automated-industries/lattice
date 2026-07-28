import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';
import { recordLineage } from '../../src/gui/lineage-store.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * The row-provenance HTTP surface (`GET /api/tables/:table/rows/:id/provenance`)
 * end-to-end against an in-process SQLite GUI server: a row with a recorded
 * file-extraction lineage edge returns the chain, a row without lineage returns
 * an empty (but well-formed) summary, and system/denied tables are refused.
 * This is the read surface the sandboxed dashboard bridge's `lattice.provenance`
 * op fetches through.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<{
  handle: GuiServerHandle;
  noteId: string;
  fileId: string;
  bareId: string;
}> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-provenance-route-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  files:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      original_name: { type: text }',
      '    outputFile: files.md',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '    outputFile: notes.md',
      '',
    ].join('\n'),
    'utf8',
  );
  // Seed the db BEFORE the server opens it: a source file, an extracted note,
  // and the lineage edge between them — plus a second note with no lineage.
  // (Constructed on the db FILE with matching define()s; the server then opens
  // the same file via the YAML config.)
  const db = new Lattice(join(root, 'data', 'test.db'));
  db.define('files', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', original_name: 'TEXT' },
    render: () => '',
    outputFile: 'files.md',
  });
  db.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT' },
    render: () => '',
    outputFile: 'notes.md',
  });
  await db.init();
  const fileId = randomUUID();
  const noteId = randomUUID();
  const bareId = randomUUID();
  await db.insert('files', { id: fileId, name: 'report.pdf', original_name: 'report.pdf' });
  await db.insert('notes', { id: noteId, title: 'Extracted note' });
  await db.insert('notes', { id: bareId, title: 'Hand-written note' });
  await recordLineage(db.adapter, [
    {
      objectTable: 'notes',
      objectId: noteId,
      sourceKind: 'file',
      sourceTable: 'files',
      sourceId: fileId,
      tier: 'raw',
      relation: 'extracted_from',
    },
  ]);
  db.close();

  const handle = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
  });
  servers.push(handle);
  return { handle, noteId, fileId, bareId };
}

describe('GET /api/tables/:table/rows/:id/provenance', () => {
  it('returns the lineage chain incl. the source file for an extracted row', async () => {
    const { handle, noteId, fileId } = await boot();
    const res = await fetch(`${handle.url}/api/tables/notes/rows/${noteId}/provenance`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      links?: { relation?: string }[];
      sources?: { table: string; id: string; label: string }[];
    };
    expect(JSON.stringify(body.links)).toContain('extracted_from');
    // The machine-usable source refs the dashboard inset wires open-record from:
    // the actual file row, labeled by its own name — not the table name.
    const fileSource = (body.sources ?? []).find((s) => s.table === 'files');
    expect(fileSource?.id).toBe(fileId);
    expect(fileSource?.label).toBe('report.pdf');
  });

  it('returns a well-formed empty summary for a row with no lineage', async () => {
    const { handle, bareId } = await boot();
    const res = await fetch(`${handle.url}/api/tables/notes/rows/${bareId}/provenance`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { links?: unknown[] };
    expect(JSON.stringify(body)).not.toContain('extracted_from');
  });

  it('refuses system and denied tables', async () => {
    const { handle } = await boot();
    for (const t of ['__lattice_lineage', 'secrets', 'chat_threads']) {
      const res = await fetch(
        `${handle.url}/api/tables/${encodeURIComponent(t)}/rows/x/provenance`,
      );
      expect(res.status).toBe(403);
    }
  });

  it('404s an unknown row id on a real table', async () => {
    const { handle } = await boot();
    const res = await fetch(`${handle.url}/api/tables/notes/rows/does-not-exist/provenance`);
    expect(res.status).toBe(404);
  });
});
