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

  it('MODEL ("Tables"): the former Surface app/system plumbing now lists under Tables', () => {
    // The "Surface · app" tier was removed as arbitrary — settings/auth/chat/todos
    // and the secrets store all fall through to MODEL ("Tables") now.
    expect(classifyTier(t('user_settings'))).toBe('model');
    expect(classifyTier(t('oauth_tokens'))).toBe('model');
    expect(classifyTier(t('chat_messages'))).toBe('model');
    expect(classifyTier(t('todos'))).toBe('model');
    expect(classifyTier(t('secrets', { native: true }))).toBe('model');
  });

  it('MODEL: first-class business entities (the default)', () => {
    expect(classifyTier(t('people'))).toBe('model');
    expect(classifyTier(t('projects'))).toBe('model');
    expect(classifyTier(t('companies'))).toBe('model');
    // An unknown brand-new table falls through to MODEL, not a guess.
    expect(classifyTier(t('widgets_v2'))).toBe('model');
    // Former AI-loop/embedding tables fall through to MODEL too unless they carry a
    // stronger SOURCE signal.
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
