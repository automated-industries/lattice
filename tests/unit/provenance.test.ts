import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * AI-authored audit rows — with bounded reads.
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

  it('reads connected data via grouped aggregate, never an unbounded row query', async () => {
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

/**
 * Regression: an object whose files are linked through the existing `*_files`
 * junction must show those files as raw sources EVEN WHEN no `__lattice_lineage`
 * row was ever recorded (pre-existing data, or a row created by a path that
 * doesn't write lineage). Previously the builder read only the lineage table and
 * reported "0 sources" for such objects.
 */
describe('provenance: raw file sources from existing junctions (no lineage row)', () => {
  let db: Lattice | undefined;
  const dirs: string[] = [];
  afterEach(() => {
    db?.close();
    db = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeJunctionConfig(): { configPath: string; outputDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'lattice-prov-'));
    dirs.push(root);
    const configPath = join(root, 'lattice.config.yml');
    writeFileSync(
      configPath,
      [
        'db: ./data/test.db',
        'entities:',
        '  contracts:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '    outputFile: contracts.md',
        '  contract_files:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      contract_id: { type: uuid }',
        '      file_id: { type: uuid }',
        '    relations:',
        '      contract: { type: belongsTo, table: contracts, foreignKey: contract_id }',
        '      file: { type: belongsTo, table: files, foreignKey: file_id }',
        '    outputFile: contract-files.md',
        '',
      ].join('\n'),
    );
    return { configPath, outputDir: join(root, 'context') };
  }

  async function setupDb(): Promise<Lattice> {
    db = new Lattice(':memory:');
    db.define('contracts', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'c.md',
    });
    db.define('files', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'f.md',
    });
    db.define('contract_files', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        contract_id: 'TEXT',
        file_id: 'TEXT',
        deleted_at: 'TEXT',
      },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'cf.md',
    });
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
    await ensureLineageTable(db.adapter);
    return db;
  }

  it('row scope: a linked file appears as a raw source with NO lineage row', async () => {
    const { configPath, outputDir } = writeJunctionConfig();
    const d = await setupDb();
    await d.insert('contracts', { id: 'c1', name: 'Brickell COI' });
    await d.insert('files', { id: 'f1', name: 'BH Master- KW- COI.pdf' });
    await d.insert('contract_files', { id: 'j1', contract_id: 'c1', file_id: 'f1' });
    // Deliberately NO recordLineage — this is the pre-existing-data case.

    const g = await buildProvenanceGraph(d, 'contracts', { rowId: 'c1', configPath, outputDir });

    const fileNodes = g.nodes.filter((n) => n.type === 'raw' && n.kind === 'file');
    expect(fileNodes.length).toBeGreaterThanOrEqual(1);
    expect(fileNodes.some((n) => n.label.includes('BH Master- KW- COI.pdf'))).toBe(true);
    expect(
      g.edges.some((e) => e.relation === 'extracted_from' && e.target === 'obj:contracts:c1'),
    ).toBe(true);
  });

  it('table scope: a grouped file source counts the links with NO lineage row', async () => {
    const { configPath, outputDir } = writeJunctionConfig();
    const d = await setupDb();
    await d.insert('contracts', { id: 'c1', name: 'A' });
    await d.insert('contracts', { id: 'c2', name: 'B' });
    await d.insert('files', { id: 'f1', name: 'one.pdf' });
    await d.insert('files', { id: 'f2', name: 'two.pdf' });
    await d.insert('contract_files', { id: 'j1', contract_id: 'c1', file_id: 'f1' });
    await d.insert('contract_files', { id: 'j2', contract_id: 'c2', file_id: 'f2' });

    const g = await buildProvenanceGraph(d, 'contracts', { configPath, outputDir });

    const grouped = g.nodes.find((n) => n.type === 'raw' && n.kind === 'file');
    expect(grouped).toBeDefined();
    expect(grouped?.count).toBe(2);
  });

  it('without configPath, no junction derivation runs (member fallback = lineage only)', async () => {
    const d = await setupDb();
    await d.insert('contracts', { id: 'c1', name: 'A' });
    await d.insert('files', { id: 'f1', name: 'one.pdf' });
    await d.insert('contract_files', { id: 'j1', contract_id: 'c1', file_id: 'f1' });

    const g = await buildProvenanceGraph(d, 'contracts', { rowId: 'c1' });
    // No config → the junction path is skipped; only the center object remains.
    expect(g.nodes.filter((n) => n.kind === 'file')).toHaveLength(0);
  });
});

/**
 * Universal row traceback: an entity row created by the seed/upsert path (no
 * connector, no file junction, no __lattice_lineage row, no ai-audit) must STILL
 * trace back to something — its creation + its belongsTo parents — rather than
 * reporting "no sources". Surfacing the parents must be RLS-safe (a hidden parent
 * yields no node) and a graceful no-op for a member (no relation config).
 */
describe('provenance: universal row traceback (creation + belongsTo parents)', () => {
  let db: Lattice | undefined;
  const dirs: string[] = [];
  afterEach(() => {
    db?.close();
    db = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function setupProjects(): Promise<{ db: Lattice; configPath: string; outputDir: string }> {
    const root = mkdtempSync(join(tmpdir(), 'lattice-prov-'));
    dirs.push(root);
    const outputDir = join(root, 'context');
    mkdirSync(outputDir, { recursive: true });
    const configPath = join(root, 'lattice.config.yml');
    writeFileSync(
      configPath,
      [
        'db: ./data/x.db',
        'entities:',
        '  projects:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '      org_id: { type: uuid }',
        '      client_id: { type: uuid }',
        '    relations:',
        '      org: { type: belongsTo, table: orgs, foreignKey: org_id }',
        '      client: { type: belongsTo, table: clients, foreignKey: client_id }',
        '    outputFile: PROJECTS.md',
        '  orgs:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '    outputFile: ORGS.md',
        '  clients:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '    outputFile: CLIENTS.md',
        '',
      ].join('\n'),
    );
    const d = new Lattice(':memory:');
    db = d;
    d.define('projects', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT',
        org_id: 'TEXT',
        client_id: 'TEXT',
        created_at: 'TEXT',
        updated_at: 'TEXT',
        deleted_at: 'TEXT',
      },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'p.md',
    });
    d.define('orgs', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'o.md',
    });
    d.define('clients', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'cl.md',
    });
    d.define('_lattice_gui_audit', {
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
    await d.init();
    await d.insert('orgs', { id: 'org1', name: 'Acme Org' });
    await d.insert('clients', { id: 'cli1', name: 'Beta Client' });
    return { db: d, configPath, outputDir };
  }

  it('gives every entity row a traceback: a creation node + its belongsTo parents', async () => {
    const { db: d, configPath, outputDir } = await setupProjects();
    await d.insert('projects', {
      id: 'p1',
      name: 'Proj',
      org_id: 'org1',
      client_id: 'cli1',
      created_at: '2026-04-06 02:56:54',
      updated_at: '2026-04-06 02:56:54',
    });
    const row = await d.get('projects', 'p1');
    const g = await buildProvenanceGraph(d, 'projects', {
      rowId: 'p1',
      row: row ?? undefined,
      configPath,
      outputDir,
    });
    // More than just the centre object node — the bug was an empty graph here.
    expect(g.nodes.filter((n) => n.type !== 'object').length).toBeGreaterThan(0);
    // Universal floor: a creation node always present for a row.
    expect(g.nodes.some((n) => n.type === 'created')).toBe(true);
    // belongsTo parents surfaced as related nodes, each linked to the object.
    expect(g.nodes.find((n) => n.id === 'rel:orgs:org1')?.type).toBe('related');
    expect(g.nodes.find((n) => n.id === 'rel:clients:cli1')?.type).toBe('related');
    expect(g.edges.some((e) => e.source === 'rel:orgs:org1' && e.target.includes('projects'))).toBe(
      true,
    );
  });

  it('is RLS-safe: a belongsTo FK whose parent row is not visible yields NO node', async () => {
    const { db: d, configPath, outputDir } = await setupProjects();
    // org_id points at a row that does not exist (simulates an RLS-hidden parent).
    await d.insert('projects', {
      id: 'p2',
      name: 'Hidden-parent',
      org_id: 'ghost',
      client_id: 'cli1',
      created_at: 't',
      updated_at: 't',
    });
    const row = await d.get('projects', 'p2');
    const g = await buildProvenanceGraph(d, 'projects', {
      rowId: 'p2',
      row: row ?? undefined,
      configPath,
      outputDir,
    });
    expect(g.nodes.some((n) => n.id.startsWith('rel:orgs:'))).toBe(false);
    expect(g.edges.some((e) => e.source.startsWith('rel:orgs:'))).toBe(false);
    // …but the creation floor + the VISIBLE client parent still show.
    expect(g.nodes.some((n) => n.type === 'created')).toBe(true);
    expect(g.nodes.some((n) => n.id === 'rel:clients:cli1')).toBe(true);
  });

  it('degrades for a member (no relation config): creation floor only, no relation nodes, no throw', async () => {
    const { db: d } = await setupProjects();
    await d.insert('projects', {
      id: 'p3',
      name: 'NoCfg',
      org_id: 'org1',
      client_id: 'cli1',
      created_at: 't',
      updated_at: 't',
    });
    const row = await d.get('projects', 'p3');
    const g = await buildProvenanceGraph(d, 'projects', { rowId: 'p3', row: row ?? undefined });
    expect(g.nodes.some((n) => n.type === 'created')).toBe(true);
    expect(g.nodes.some((n) => n.type === 'related')).toBe(false);
  });
});
