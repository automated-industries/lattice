import { describe, it, expect, afterEach, vi } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { createConnector } from '../../src/connectors/registry.js';
import {
  ensureLineageTable,
  recordLineage,
  type LineageEdge,
} from '../../src/gui/lineage-store.js';
import { buildProvenanceGraph, labelForSource, relFor } from '../../src/gui/provenance.js';

/**
 * Data-provenance builder: traces an object's sources across the raw / computed
 * / observation tiers from connector lineage, the __lattice_lineage table, and
 * AI-authored audit rows — with bounded (bounded reads) reads.
 */
describe('provenance graph (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function setup(): Promise<Lattice> {
    db = new Lattice(':memory:');
    // A connected table → injects + stamps `_source_connector_id`.
    db.define('jira_issues', {
      columns: { issue_key: 'TEXT PRIMARY KEY', summary: 'TEXT', deleted_at: 'TEXT' },
      primaryKey: 'issue_key',
      source: { connector: 'jira', toolkit: 'jira', model: 'issue', naturalKey: 'issue_key' },
      render: () => '',
      outputFile: 'i.md',
    });
    // A plain object table for file-extraction + import lineage.
    db.define('contracts', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'c.md',
    });
    // The audit log (db.define'd by GUI lifecycle in production).
    db.define('_lattice_gui_audit', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        ts: 'TEXT',
        table_name: 'TEXT',
        row_id: 'TEXT',
        operation: 'TEXT',
        source: 'TEXT',
      },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'a.md',
    });
    await db.init();
    // The lineage substrate is an unregistered raw-DDL table (created by the GUI
    // lifecycle in production); create it directly here.
    await ensureLineageTable(db.adapter);
    return db;
  }

  const lineageEdge = (over: Partial<LineageEdge>): LineageEdge => ({
    objectTable: 'contracts',
    objectId: 'c1',
    sourceKind: 'file',
    sourceTable: 'files',
    sourceId: 'f1',
    tier: 'raw',
    relation: 'extracted_from',
    ...over,
  });

  it('labels sources and maps relations', () => {
    expect(labelForSource('connector', 'Acme Jira')).toBe('Connector: Acme Jira');
    expect(labelForSource('file')).toBe('File');
    expect(relFor('connector')).toBe('synced_from');
    expect(relFor('file')).toBe('extracted_from');
    expect(relFor('import')).toBe('materialized_from');
    expect(relFor('observation')).toBe('observed_by');
  });

  it('builds a connector RAW source node with a grouped count (table scope)', async () => {
    const d = await setup();
    const cid = await createConnector(d, {
      connector: 'jira',
      toolkit: 'jira',
      displayName: 'Acme Jira',
    });
    await d.insert('jira_issues', { issue_key: 'PROJ-1', summary: 'a', _source_connector_id: cid });
    await d.insert('jira_issues', { issue_key: 'PROJ-2', summary: 'b', _source_connector_id: cid });

    const g = await buildProvenanceGraph(d, 'jira_issues');
    expect(g.nodes.find((n) => n.id === 'table:jira_issues')?.type).toBe('object');
    const conn = g.nodes.find((n) => n.id === 'src:connector:' + cid);
    expect(conn?.type).toBe('raw');
    expect(conn?.kind).toBe('connector');
    expect(conn?.count).toBe(2);
    expect(conn?.label).toContain('Acme Jira');
    expect(g.edges).toContainEqual(
      expect.objectContaining({
        source: 'src:connector:' + cid,
        target: 'table:jira_issues',
        relation: 'synced_from',
      }),
    );
  });

  it('scopes the connector source to a single row (row scope)', async () => {
    const d = await setup();
    const cid = await createConnector(d, {
      connector: 'jira',
      toolkit: 'jira',
      displayName: 'Acme Jira',
    });
    await d.insert('jira_issues', { issue_key: 'PROJ-1', summary: 'a', _source_connector_id: cid });
    await d.insert('jira_issues', { issue_key: 'PROJ-2', summary: 'b', _source_connector_id: cid });

    const g = await buildProvenanceGraph(d, 'jira_issues', { rowId: 'PROJ-1' });
    expect(g.nodes.find((n) => n.type === 'object')?.id).toBe('obj:jira_issues:PROJ-1');
    expect(g.nodes.find((n) => n.id === 'src:connector:' + cid)?.count).toBe(1);
  });

  it('surfaces file-extraction lineage as a raw source (row scope)', async () => {
    const d = await setup();
    await recordLineage(d.adapter, [lineageEdge({})]);
    const g = await buildProvenanceGraph(d, 'contracts', { rowId: 'c1' });
    const fileNode = g.nodes.find((n) => n.kind === 'file');
    expect(fileNode?.type).toBe('raw');
    expect(g.edges).toContainEqual(
      expect.objectContaining({ target: 'obj:contracts:c1', relation: 'extracted_from' }),
    );
  });

  it('folds table-level import lineage into the table view but not a single row', async () => {
    const d = await setup();
    await recordLineage(d.adapter, [
      lineageEdge({
        objectId: '*',
        sourceKind: 'import',
        sourceTable: null,
        sourceId: null,
        tier: 'computed',
        relation: 'materialized_from',
      }),
    ]);
    const tableG = await buildProvenanceGraph(d, 'contracts');
    expect(tableG.nodes.some((n) => n.kind === 'import' && n.type === 'computed')).toBe(true);
    const rowG = await buildProvenanceGraph(d, 'contracts', { rowId: 'c1' });
    expect(rowG.nodes.some((n) => n.kind === 'import')).toBe(false);
  });

  it('counts only AI-authored audit rows as the observation tier', async () => {
    const d = await setup();
    await d.insert('_lattice_gui_audit', {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      table_name: 'contracts',
      row_id: 'c1',
      operation: 'update',
      source: 'ai',
    });
    await d.insert('_lattice_gui_audit', {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      table_name: 'contracts',
      row_id: 'c1',
      operation: 'update',
      source: 'gui',
    });
    const g = await buildProvenanceGraph(d, 'contracts');
    const obs = g.nodes.find((n) => n.id === 'src:observation:ai');
    expect(obs?.type).toBe('observation');
    expect(obs?.count).toBe(1); // the 'gui' row does not count
  });

  it('returns just the center for an object with no sources, and never dangling edges', async () => {
    const d = await setup();
    const g = await buildProvenanceGraph(d, 'contracts');
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]?.type).toBe('object');
    expect(g.edges).toHaveLength(0);
    // Every edge endpoint must resolve to a node (prune invariant).
    await recordLineage(d.adapter, [lineageEdge({})]);
    const g2 = await buildProvenanceGraph(d, 'contracts', { rowId: 'c1' });
    const ids = new Set(g2.nodes.map((n) => n.id));
    for (const e of g2.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  it('reads connected data via grouped aggregate, never an unbounded row query (bounded reads)', async () => {
    const d = await setup();
    const cid = await createConnector(d, {
      connector: 'jira',
      toolkit: 'jira',
      displayName: 'Acme Jira',
    });
    for (let i = 0; i < 1000; i++) {
      await d.insert('jira_issues', {
        issue_key: 'K-' + i,
        summary: 'x',
        _source_connector_id: cid,
      });
    }
    const querySpy = vi.spyOn(d, 'query');
    const g = await buildProvenanceGraph(d, 'jira_issues');
    // Correct grouped count over 1000 rows…
    expect(g.nodes.find((n) => n.id === 'src:connector:' + cid)?.count).toBe(1000);
    // …with no `query` (SELECT-rows) call against the data table.
    const dataTableQueried = querySpy.mock.calls.some((c) => c[0] === 'jira_issues');
    expect(dataTableQueried).toBe(false);
    querySpy.mockRestore();
  });
});
