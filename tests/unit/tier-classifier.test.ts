import { describe, it, expect } from 'vitest';

import { classifyTier, type ClassifiableTable } from '../../src/gui/tier-classify.js';

describe('classifyTier — generic Inputs/Derived/Computed tier heuristic', () => {
  const t = (name: string, extra: Partial<ClassifiableTable> = {}): ClassifiableTable => ({
    name,
    columns: [],
    ...extra,
  });

  it('COMPUTED: the server flag is authoritative, ahead of every SOURCE signal', () => {
    expect(classifyTier(t('pipeline_totals', { computedTable: true }))).toBe('computed');
    // A computed projection may surface provenance columns from its base — the
    // computed flag must beat both the connector and the stamped-column signals.
    expect(
      classifyTier(t('synced_rollup', { computedTable: true, connectorToolkit: 'jira' })),
    ).toBe('computed');
    expect(
      classifyTier(
        t('stamped_rollup', { computedTable: true, columns: ['id', '_source_connector_id'] }),
      ),
    ).toBe('computed');
  });

  it('SOURCE ("Inputs"): connector-synced, ingested files, and stamped tables', () => {
    expect(classifyTier(t('issues', { connectorToolkit: 'jira' }))).toBe('source');
    expect(classifyTier(t('files', { native: true }))).toBe('source');
    expect(classifyTier(t('imported_rows', { columns: ['id', '_source_connector_id'] }))).toBe(
      'source',
    );
  });

  it("SOURCE: a server-stamped origin of 'source' classifies without any other signal", () => {
    expect(classifyTier(t('warehouse_dump', { origin: 'source' }))).toBe('source');
  });

  it("MODEL ('Derived Tables'): a server-stamped origin of 'derived' stays in the default tier", () => {
    // 'derived' is provenance metadata, not a tier of its own in the explorer —
    // materialized tables list under Derived Tables with the authored ones.
    expect(classifyTier(t('investments', { origin: 'derived' }))).toBe('model');
  });

  it('MODEL: app/system plumbing-looking user tables stay in the default tier', () => {
    expect(classifyTier(t('user_settings'))).toBe('model');
    expect(classifyTier(t('oauth_tokens'))).toBe('model');
    expect(classifyTier(t('chat_messages'))).toBe('model');
    expect(classifyTier(t('todos'))).toBe('model');
  });

  it('MODEL: first-class business entities (the default)', () => {
    expect(classifyTier(t('people'))).toBe('model');
    expect(classifyTier(t('projects'))).toBe('model');
    expect(classifyTier(t('companies'))).toBe('model');
    // An unknown brand-new table falls through to MODEL, not a guess.
    expect(classifyTier(t('widgets_v2'))).toBe('model');
    // AI-loop/embedding-looking tables fall through to MODEL too unless they
    // carry a stronger COMPUTED or SOURCE signal.
    expect(classifyTier(t('predictions'))).toBe('model');
    expect(classifyTier(t('observations'))).toBe('model');
    expect(classifyTier(t('note_embeddings'))).toBe('model');
    expect(classifyTier(t('chunks', { columns: ['id', 'embedding'] }))).toBe('model');
  });

  it('priority: explicit connector provenance wins over the name heuristic', () => {
    // A connector-synced table is a SOURCE — the toolkit is authoritative
    // provenance, ahead of the MODEL default.
    expect(classifyTier(t('insights', { connectorToolkit: 'salesforce' }))).toBe('source');
  });
});
