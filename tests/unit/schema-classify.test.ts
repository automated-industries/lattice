import { describe, it, expect } from 'vitest';
import { classifySchema } from '../../src/gui/schema-classify.js';

/**
 * classifySchema buckets a table into its provenance schema for the schema-grouped
 * TABLES sidebar: no source → LATTICE, a connector toolkit → one schema per toolkit,
 * a `db_source:<id>` → one schema per connected external database.
 */
describe('classifySchema — provenance schema grouping', () => {
  const noLabels = new Map<string, string>();

  it('undefined / null / empty source → the LATTICE schema', () => {
    const lattice = { kind: 'lattice', key: 'lattice', label: 'LATTICE' };
    expect(classifySchema(undefined, noLabels)).toEqual(lattice);
    expect(classifySchema(null, noLabels)).toEqual(lattice);
    expect(classifySchema('', noLabels)).toEqual(lattice);
  });

  it('a connector toolkit → one connector schema keyed by toolkit, title-cased label', () => {
    expect(classifySchema('gmail', noLabels)).toEqual({
      kind: 'connector',
      key: 'conn:gmail',
      label: 'Gmail',
    });
    expect(classifySchema('google_calendar', noLabels)).toEqual({
      kind: 'connector',
      key: 'conn:google_calendar',
      label: 'Google Calendar',
    });
  });

  it('the legacy generic MCP connector groups under a "Connectors" header, not the "MCP" slug', () => {
    // CSS uppercases the label to "CONNECTORS" in the sidebar — "MCP" reads as jargon.
    expect(classifySchema('mcp', noLabels)).toEqual({
      kind: 'connector',
      key: 'conn:mcp',
      label: 'Connectors',
    });
  });

  it('a per-connection MCP toolkit gets its own group labeled by the server brand', () => {
    const labels = new Map([['mcp:abc-123', 'Justworks']]);
    expect(classifySchema('mcp:abc-123', labels)).toEqual({
      kind: 'connector',
      key: 'conn:mcp:abc-123',
      label: 'Justworks',
    });
    // No brand label yet → falls back to the connection id (never the raw "mcp:" slug).
    expect(classifySchema('mcp:abc-123', noLabels).label).toBe('abc-123');
  });

  it('two tables of the same toolkit share one schema key (keyed by toolkit, not instance)', () => {
    expect(classifySchema('jira', noLabels).key).toBe(classifySchema('jira', noLabels).key);
  });

  it('a db_source toolkit → one schema per connection id, labeled by the db display name', () => {
    const labels = new Map([['db_source:abc123', 'Prod Postgres']]);
    expect(classifySchema('db_source:abc123', labels)).toEqual({
      kind: 'db_source',
      key: 'db:abc123',
      label: 'Prod Postgres',
    });
  });

  it('db_source falls back to the entity label, then the connection id, without a display name', () => {
    expect(classifySchema('db_source:xyz', new Map(), 'Addresses')).toEqual({
      kind: 'db_source',
      key: 'db:xyz',
      label: 'Addresses',
    });
    expect(classifySchema('db_source:xyz', new Map())).toEqual({
      kind: 'db_source',
      key: 'db:xyz',
      label: 'xyz',
    });
  });
});
