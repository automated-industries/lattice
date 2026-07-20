import { describe, it, expect } from 'vitest';
import {
  connectorUpstreamNode,
  CONNECTED_SOURCE_FALLBACK_LABEL,
} from '../../src/gui/lineage-source.js';

/**
 * A connected table's lineage must always show its connector as an upstream source, even when
 * no other synced table links to it. Before this, an isolated connected table (source tier,
 * zero belongsTo/m2m edges) rendered an EMPTY lineage panel and read as "no lineage" — the
 * bug where lineage appeared under some connected tables (those another table referenced) but
 * not others (e.g. a standalone "Accounts" mirror nothing else pointed at).
 */
describe('connectorUpstreamNode', () => {
  it('returns an external connector node for a connected source table', () => {
    expect(
      connectorUpstreamNode({
        tier: 'source',
        connectorToolkit: 'quickbooks',
        schemaLabel: 'QuickBooks',
      }),
    ).toEqual({ external: true, label: 'QuickBooks', kind: 'connector' });
  });

  it('falls back to a generic label when the connected source has no clean label', () => {
    const node = connectorUpstreamNode({
      tier: 'source',
      connectorToolkit: 'mcp:abc',
      schemaLabel: null,
    });
    expect(node).toEqual({
      external: true,
      label: CONNECTED_SOURCE_FALLBACK_LABEL,
      kind: 'connector',
    });
  });

  it('returns null for a source-tier table that is NOT a connector (e.g. the native files source)', () => {
    // `files` and other authored/ingested sources are source tier but carry no connectorToolkit,
    // so they keep their ordinary table-to-table lineage — no synthetic external node.
    expect(connectorUpstreamNode({ tier: 'source', connectorToolkit: null })).toBeNull();
    expect(connectorUpstreamNode({ tier: 'source' })).toBeNull();
  });

  it('returns null for derived and computed tables even if a connector id lingers in props', () => {
    expect(connectorUpstreamNode({ tier: 'model', connectorToolkit: 'quickbooks' })).toBeNull();
    expect(connectorUpstreamNode({ tier: 'computed', connectorToolkit: 'quickbooks' })).toBeNull();
  });
});
