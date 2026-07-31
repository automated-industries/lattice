import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { diagnoseRetrieval, formatHealthReport } from '../../src/search/doctor.js';
import { storeEmbedding } from '../../src/search/embeddings.js';

/**
 * Retrieval health diagnostics on SQLite. Read-only: it reports FTS/embedding
 * coverage and flags gaps, never mutating the database.
 */
describe('diagnoseRetrieval (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  const fakeEmbed = (text: string) => Promise.resolve([text.length % 7, (text.length * 3) % 5, 1]);

  async function setup(): Promise<Lattice> {
    db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', body: 'TEXT', deleted_at: 'TEXT' },
      fts: { fields: ['title', 'body'] },
      embeddings: { fields: ['title', 'body'], embed: fakeEmbed },
      render: () => '',
      outputFile: 'n.md',
    });
    await db.init();
    return db;
  }

  it('reports full FTS + embedding coverage when every row is indexed/embedded', async () => {
    const d = await setup();
    await d.insert('notes', { id: 'n1', title: 'budget', body: 'review' });
    await d.insert('notes', { id: 'n2', title: 'grocery', body: 'list' });
    // FTS index is trigger-maintained; embeddings are written by the facade on insert.

    const report = await d.diagnoseRetrieval();
    const notes = report.tables.find((t) => t.table === 'notes')!;
    expect(notes.rowCount).toBe(2);
    expect(notes.ftsCoverage).toBe(1);
    expect(notes.embeddingCoverage).toBe(1);
    expect(report.healthy).toBe(true);
    // detected extension availability is reported
    expect(report.extensions.fts5).toBe(true);
  });

  it('flags missing embeddings as an error when a table expects them', async () => {
    const d = await setup();
    // Insert directly via the adapter so the facade's embedding write-path is bypassed,
    // leaving rows with no embeddings — the gap the doctor must surface.
    const { runAsyncOrSync } = await import('../../src/db/adapter.js');
    await runAsyncOrSync(d.adapter, `INSERT INTO "notes" (id, title, body) VALUES ('n1','a','b')`);
    await runAsyncOrSync(d.adapter, `INSERT INTO "notes" (id, title, body) VALUES ('n2','c','d')`);

    const report = await d.diagnoseRetrieval();
    const notes = report.tables.find((t) => t.table === 'notes')!;
    expect(notes.embeddingCount).toBe(0);
    const issue = notes.issues.find((i) => i.kind === 'embedding_missing');
    expect(issue?.severity).toBe('error');
    expect(report.healthy).toBe(false);
  });

  it('flags partial embedding coverage as a stale warning', async () => {
    const d = await setup();
    const { runAsyncOrSync } = await import('../../src/db/adapter.js');
    await runAsyncOrSync(d.adapter, `INSERT INTO "notes" (id, title, body) VALUES ('n1','a','b')`);
    await runAsyncOrSync(d.adapter, `INSERT INTO "notes" (id, title, body) VALUES ('n2','c','d')`);
    // Embed only one of the two rows.
    await storeEmbedding(
      d.adapter,
      'notes',
      'n1',
      { id: 'n1', title: 'a', body: 'b' },
      { fields: ['title', 'body'], embed: fakeEmbed },
    );

    const report = await d.diagnoseRetrieval();
    const notes = report.tables.find((t) => t.table === 'notes')!;
    expect(notes.embeddingCoverage).toBeCloseTo(0.5, 6);
    const stale = notes.issues.find((i) => i.kind === 'embedding_stale');
    expect(stale?.severity).toBe('warning');
    // a warning is not an error → still "healthy" (no error-severity issues)
    expect(report.healthy).toBe(true);
  });

  it('flags mixed embedding dimensions as a dimension_mismatch error', async () => {
    const d = await setup();
    const { runAsyncOrSync } = await import('../../src/db/adapter.js');
    await runAsyncOrSync(d.adapter, `INSERT INTO "notes" (id, title, body) VALUES ('n1','a','b')`);
    await runAsyncOrSync(d.adapter, `INSERT INTO "notes" (id, title, body) VALUES ('n2','c','d')`);
    // Two embeddings of DIFFERENT dimension for the same table — what a model
    // change without a full re-embed leaves behind. The doctor must surface it.
    await storeEmbedding(
      d.adapter,
      'notes',
      'n1',
      { id: 'n1', title: 'a', body: 'b' },
      {
        fields: ['title', 'body'],
        embed: () => Promise.resolve([0.1, 0.2, 0.3]),
      },
    );
    await storeEmbedding(
      d.adapter,
      'notes',
      'n2',
      { id: 'n2', title: 'c', body: 'd' },
      {
        fields: ['title', 'body'],
        embed: () => Promise.resolve([0.1, 0.2, 0.3, 0.4]),
      },
    );

    const report = await d.diagnoseRetrieval();
    const notes = report.tables.find((t) => t.table === 'notes')!;
    const mismatch = notes.issues.find((i) => i.kind === 'dimension_mismatch');
    expect(mismatch?.severity).toBe('error');
    expect(mismatch?.message).toMatch(/mixed embedding dimensions/);
    expect(report.healthy).toBe(false);
  });

  it('flags a stale native vector index (row count disagrees with embeddings)', async () => {
    const d = await setup();
    await d.insert('notes', { id: 'n1', title: 'a', body: 'b' });
    await d.insert('notes', { id: 'n2', title: 'c', body: 'd' }); // ≥ 2 embeddings stored
    // Simulate a native index table built earlier from a SUBSET — now stale.
    const { runAsyncOrSync } = await import('../../src/db/adapter.js');
    await runAsyncOrSync(
      d.adapter,
      `CREATE TABLE "_lattice_vec_notes" (row_pk TEXT, chunk_index INTEGER, embedding TEXT)`,
    );
    await runAsyncOrSync(
      d.adapter,
      `INSERT INTO "_lattice_vec_notes" (row_pk, chunk_index, embedding) VALUES ('n1', 0, '[]')`,
    );

    const report = await d.diagnoseRetrieval();
    const notes = report.tables.find((t) => t.table === 'notes')!;
    const stale = notes.issues.find((i) => i.kind === 'index_stale');
    expect(stale?.severity).toBe('warning');
    expect(stale?.message).toMatch(/stale/);
  });

  it('excludes soft-deleted rows from the row count denominator', async () => {
    const d = await setup();
    await d.insert('notes', { id: 'n1', title: 'budget', body: 'review' });
    await d.insert('notes', { id: 'n2', title: 'old', body: 'x', deleted_at: '2020-01-01' });
    const report = await d.diagnoseRetrieval();
    const notes = report.tables.find((t) => t.table === 'notes')!;
    expect(notes.rowCount).toBe(1);
  });

  it('formatHealthReport renders a readable summary', async () => {
    const d = await setup();
    await d.insert('notes', { id: 'n1', title: 'budget', body: 'review' });
    const report = await d.diagnoseRetrieval();
    const text = formatHealthReport(report);
    expect(text).toContain('Retrieval health — sqlite');
    expect(text).toContain('notes');
    expect(text).toContain('healthy');
  });

  it('diagnoseRetrieval(adapter) with explicit specs is read-only', async () => {
    const d = await setup();
    await d.insert('notes', { id: 'n1', title: 'budget', body: 'review' });
    const before = await d.count('notes');
    await diagnoseRetrieval(d.adapter, {
      tables: [{ table: 'notes', expectFts: true, expectEmbeddings: true }],
    });
    const after = await d.count('notes');
    expect(after).toBe(before);
  });
});

/**
 * What the doctor does when it has NO expectations to check.
 *
 * An empty expectation list is not the same as "everything is fine" — it means
 * the doctor was handed nothing to diagnose. It must fall back to discovering
 * what the database actually has, and when even that turns up nothing it must
 * say so as an error, so a command or CI job gating on the result fails instead
 * of passing on a database whose retrieval health was never assessed.
 */
describe('diagnoseRetrieval — with no expectations', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  const fakeEmbed = (text: string) => Promise.resolve([text.length % 7, (text.length * 3) % 5, 1]);

  it('falls back to discovery when the expectation list is empty', async () => {
    db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', deleted_at: 'TEXT' },
      embeddings: { fields: ['title'], embed: fakeEmbed },
      render: () => '',
      outputFile: 'n.md',
    });
    await db.init();
    await db.insert('notes', { id: 'n1', title: 'budget' });

    // An empty array must behave like "no expectations given", not like
    // "diagnose nothing" — the stored embeddings are discoverable.
    const report = await diagnoseRetrieval(db.adapter, { tables: [] });
    expect(report.tables.map((t) => t.table)).toEqual(['notes']);
    expect(report.tables[0]?.embeddingCount).toBe(1);
    expect(report.issues.some((i) => i.kind === 'nothing_to_diagnose')).toBe(false);
  });

  it('reports an error when the caller described nothing and the database implies nothing', async () => {
    db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT' },
      render: () => '',
      outputFile: 'n.md',
    });
    await db.init();
    await db.insert('notes', { id: 'n1', title: 'budget' });

    // No expectations, and no promise that any were looked for: this caller
    // never walked the schema, so an empty result means nothing was assessed.
    const report = await diagnoseRetrieval(db.adapter, {});
    expect(report.tables).toHaveLength(0);
    const issue = report.issues.find((i) => i.kind === 'nothing_to_diagnose');
    expect(issue?.severity).toBe('error');
    // healthy:false is what makes the command exit non-zero instead of
    // silently passing a database it never checked.
    expect(report.healthy).toBe(false);
    expect(formatHealthReport(report)).toMatch(/nothing to diagnose/i);
  });

  it('reports no-search-here, not an error, when the whole schema was read', async () => {
    db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT' },
      render: () => '',
      outputFile: 'n.md',
    });
    await db.init();
    await db.insert('notes', { id: 'n1', title: 'budget' });

    // Opening a workspace enumerates every registered table before asking, so
    // an empty list is an answer about this workspace rather than a gap in what
    // the caller knew. A brand-new workspace is exactly this state, and calling
    // it unhealthy failed the health check on every first run.
    const report = await db.diagnoseRetrieval();
    expect(report.tables).toHaveLength(0);
    expect(report.issues.some((i) => i.kind === 'nothing_to_diagnose')).toBe(false);
    expect(report.issues.find((i) => i.kind === 'no_retrieval_configured')?.severity).toBe('info');
    expect(report.healthy).toBe(true);
    expect(formatHealthReport(report)).toMatch(/no search is configured here/i);
  });

  it('does not extend that to an empty list the caller supplied itself', async () => {
    db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT' },
      render: () => '',
      outputFile: 'n.md',
    });
    await db.init();

    // An explicit `[]` is the caller's list, and it carries no promise that the
    // schema was walked — the one way this could otherwise become a silent pass
    // for somebody who simply built their expectations wrong.
    const report = await db.diagnoseRetrieval({ tables: [] });
    expect(report.issues.find((i) => i.kind === 'nothing_to_diagnose')?.severity).toBe('error');
    expect(report.healthy).toBe(false);
  });

  it('extension advice still fires for discovered tables', async () => {
    db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', deleted_at: 'TEXT' },
      embeddings: { fields: ['title'], embed: fakeEmbed },
      render: () => '',
      outputFile: 'n.md',
    });
    await db.init();
    await db.insert('notes', { id: 'n1', title: 'budget' });

    // Discovery established that this database uses embeddings, so the
    // vector-extension note applies even though no caller declared it.
    const report = await diagnoseRetrieval(db.adapter, { tables: [] });
    if (report.extensions.sqliteVec === false) {
      expect(report.issues.some((i) => i.kind === 'extension_missing')).toBe(true);
    }
  });
});
