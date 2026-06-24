import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { ConnectedSourceImmutableError } from '../../src/schema/connected.js';

/**
 * 4.3 — connected data types: the `source` flag injects connector-lineage
 * columns, stamps them at ingest, keeps the lineage immutable, and upserts
 * idempotently on the natural key (the primary key).
 */
describe('connected data type (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function setup(): Promise<Lattice> {
    db = new Lattice(':memory:');
    db.define('jira_issues', {
      columns: {
        issue_key: 'TEXT PRIMARY KEY',
        summary: 'TEXT',
        status: 'TEXT',
        deleted_at: 'TEXT',
      },
      primaryKey: 'issue_key',
      source: { connector: 'jira', toolkit: 'jira', model: 'issue', naturalKey: 'issue_key' },
      render: () => '',
      outputFile: 'i.md',
    });
    await db.init();
    return db;
  }

  it('injects connector-lineage columns and stamps them on insert', async () => {
    const d = await setup();
    await d.insert('jira_issues', {
      issue_key: 'PROJ-1',
      summary: 'first',
      status: 'open',
      _source_connector_id: 'c1',
    });
    const row = await d.get('jira_issues', 'PROJ-1');
    expect(row!._source_connector_id).toBe('c1');
    expect(row!._source_model).toBe('issue'); // defaulted from the source descriptor
    expect(typeof row!._source_synced_at).toBe('string'); // auto-stamped
  });

  it('exposes the source descriptor and connected-table list', async () => {
    const d = await setup();
    expect(d.connectedTables()).toEqual(['jira_issues']);
    expect(d.getConnectedSource('jira_issues')).toMatchObject({
      connector: 'jira',
      toolkit: 'jira',
      model: 'issue',
    });
    expect(d.getConnectedSource('nope')).toBeUndefined();
  });

  it('rejects an update that relabels an immutable lineage column', async () => {
    const d = await setup();
    await d.insert('jira_issues', {
      issue_key: 'PROJ-1',
      summary: 'x',
      _source_connector_id: 'c1',
    });
    await expect(
      d.update('jira_issues', 'PROJ-1', { _source_connector_id: 'c2' }),
    ).rejects.toBeInstanceOf(ConnectedSourceImmutableError);
    await expect(
      d.update('jira_issues', 'PROJ-1', { _source_model: 'epic' }),
    ).rejects.toBeInstanceOf(ConnectedSourceImmutableError);
    // a content update still works
    await d.update('jira_issues', 'PROJ-1', { status: 'closed' });
    expect((await d.get('jira_issues', 'PROJ-1'))!.status).toBe('closed');
  });

  it('re-sync via upsert is idempotent on the natural key and preserves lineage', async () => {
    const d = await setup();
    await d.insert('jira_issues', {
      issue_key: 'PROJ-1',
      summary: 'first',
      status: 'open',
      _source_connector_id: 'c1',
    });
    // A later sync upserts the SAME key with fresh content + a (would-be) different
    // connector id — content updates, lineage is preserved (kept on conflict).
    await d.upsert('jira_issues', {
      issue_key: 'PROJ-1',
      summary: 'updated',
      status: 'closed',
      _source_connector_id: 'attacker',
      _source_synced_at: new Date().toISOString(),
    });
    const row = await d.get('jira_issues', 'PROJ-1');
    expect(row!.summary).toBe('updated'); // content updated
    expect(row!.status).toBe('closed');
    expect(row!._source_connector_id).toBe('c1'); // lineage preserved
    // and no duplicate row was created
    const all = await d.query('jira_issues', {});
    expect(all).toHaveLength(1);
  });

  it('a table without source adds no connector columns', async () => {
    db = new Lattice(':memory:');
    db.define('plain', {
      columns: { id: 'TEXT PRIMARY KEY', v: 'TEXT' },
      render: () => '',
      outputFile: 'p.md',
    });
    await db.init();
    await db.insert('plain', { id: 'p1', v: 'x' });
    const row = await db.get('plain', 'p1');
    expect('_source_connector_id' in row!).toBe(false);
    expect(db.connectedTables()).toEqual([]);
  });
});
