import { describe, it, expect } from 'vitest';

import { classifyTier, type ClassifiableTable } from '../../src/gui/tier-classify.js';

describe('classifyTier — generic Model/Tables tier heuristic', () => {
  const t = (name: string, extra: Partial<ClassifiableTable> = {}): ClassifiableTable => ({
    name,
    columns: [],
    ...extra,
  });

  it('SOURCE: connector-synced, ingested files, and stamped tables', () => {
    expect(classifyTier(t('issues', { connectorToolkit: 'jira' }))).toBe('source');
    expect(classifyTier(t('files', { native: true }))).toBe('source');
    expect(classifyTier(t('imported_rows', { columns: ['id', '_source_connector_id'] }))).toBe(
      'source',
    );
  });

  it('DERIVED: AI-loop outputs by name or an embedding/vector column', () => {
    expect(classifyTier(t('predictions'))).toBe('derived');
    expect(classifyTier(t('learnings'))).toBe('derived');
    expect(classifyTier(t('observations'))).toBe('derived');
    expect(classifyTier(t('note_embeddings'))).toBe('derived');
    expect(classifyTier(t('chunks', { columns: ['id', 'embedding'] }))).toBe('derived');
  });

  it('SURFACE: app/system plumbing + the secrets store', () => {
    expect(classifyTier(t('user_settings'))).toBe('surface');
    expect(classifyTier(t('oauth_tokens'))).toBe('surface');
    expect(classifyTier(t('chat_messages'))).toBe('surface');
    expect(classifyTier(t('todos'))).toBe('surface');
    expect(classifyTier(t('secrets', { native: true }))).toBe('surface');
  });

  it('MODEL: first-class business entities (the default)', () => {
    expect(classifyTier(t('people'))).toBe('model');
    expect(classifyTier(t('projects'))).toBe('model');
    expect(classifyTier(t('companies'))).toBe('model');
    // An unknown brand-new table falls through to MODEL, not a guess.
    expect(classifyTier(t('widgets_v2'))).toBe('model');
  });

  it('priority: explicit connector provenance wins over a name that looks derived', () => {
    // A connector-synced table named like an AI output is still a SOURCE — the
    // toolkit is authoritative provenance, not a name guess.
    expect(classifyTier(t('insights', { connectorToolkit: 'salesforce' }))).toBe('source');
  });
});
