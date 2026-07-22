import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * Write-back from the record's Markdown view: PUT an edited rendered record to
 * /api/tables/:table/rows/:id/context. The server derives the round-trippable
 * column updates from the markdown (frontmatter + `key: value` body) via the same
 * parser the file-watcher uses, applies them, and reports what changed. Free-form
 * prose that parses to no known column is a deliberate no-op (the value is never
 * guessed at, so a custom/lossy render can't corrupt the row).
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-ctxwb-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      body: { type: text }',
      '    outputFile: notes.md',
      '',
    ].join('\n'),
  );
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
  });
  servers.push(server);
  return server;
}

async function createNote(s: GuiServerHandle, values: Record<string, unknown>): Promise<string> {
  const r = await fetch(`${s.url}/api/tables/notes/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

function putContext(s: GuiServerHandle, id: string, content: string): Promise<Response> {
  return fetch(`${s.url}/api/tables/notes/rows/${id}/context`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

async function getNote(s: GuiServerHandle, id: string): Promise<Record<string, unknown>> {
  return (await (await fetch(`${s.url}/api/tables/notes/rows/${id}`)).json()) as Record<
    string,
    unknown
  >;
}

describe('record markdown write-back — PUT /api/tables/:t/rows/:id/context', () => {
  it('round-trips a frontmatter field edit back to the row column', async () => {
    const s = await boot();
    const id = await createNote(s, { title: 'Original', body: 'unchanged' });

    const res = await putContext(s, id, '---\ntitle: Renamed\n---\n\n# Original\n');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 1, fields: ['title'] });

    const row = await getNote(s, id);
    expect(row.title).toBe('Renamed');
    expect(row.body).toBe('unchanged'); // untouched columns stay put
  });

  it('round-trips a body `key: value` edit (the shape an edited markdown body has)', async () => {
    const s = await boot();
    const id = await createNote(s, { title: 'T', body: 'old body' });

    const res = await putContext(s, id, '# T\n\nbody: new body\n');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 1, fields: ['body'] });
    expect((await getNote(s, id)).body).toBe('new body');
  });

  it('is a no-op for free-form prose that parses to no known column (never guesses)', async () => {
    const s = await boot();
    const id = await createNote(s, { title: 'Keep', body: 'keep' });

    const res = await putContext(
      s,
      id,
      '# Keep\n\nJust some narrative prose, nothing structured.\n',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 0, fields: [] });
    const row = await getNote(s, id);
    expect(row.title).toBe('Keep');
    expect(row.body).toBe('keep');
  });

  it('rejects an unknown table (400) and a missing row (404)', async () => {
    const s = await boot();
    const badTable = await fetch(`${s.url}/api/tables/ghosts/rows/x/context`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(badTable.status).toBe(400);

    const missingRow = await putContext(s, 'no-such-id', '---\ntitle: X\n---\n');
    expect(missingRow.status).toBe(404);
  });

  it('round-trips content with lattice:// links without corruption (links as free-form prose)', async () => {
    const s = await boot();
    const id = await createNote(s, { title: 'Keep', body: 'keep' });

    // When a link appears in free-form prose (edge case), it round-trips as literal text.
    // This verifies that the link syntax doesn't confuse the parser.
    const contentWithLink =
      '---\ntitle: Updated\n---\n\n# Keep\n\nbody: new body with [link](lattice://other/id-123)\n';
    const res = await putContext(s, id, contentWithLink);
    expect(res.status).toBe(200);
    const result = (await res.json()) as { updated: number; fields: string[] };
    expect(result.updated).toBe(2); // title + body both updated
    expect(result.fields.sort()).toEqual(['body', 'title']);

    const row = await getNote(s, id);
    expect(row.title).toBe('Updated');
    // The link is part of the body value (free-form prose), not structured
    expect(row.body).toBe('new body with [link](lattice://other/id-123)');
  });
});
