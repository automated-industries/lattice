import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import type { Lattice } from '../lattice.js';

/**
 * Low-level config-document + DDL IO for the GUI server — a distinct concern
 * from HTTP routing. These three primitives are shared by every schema-mutation
 * path (the data-model editor handlers, the chat/ingest creation primitives),
 * so they live in one place instead of inline in the request dispatcher.
 */

/** Run a raw DDL statement against the live adapter (CREATE TABLE, etc.). */
export async function execSql(db: Lattice, sql: string): Promise<void> {
  type Adapter = { runAsync?: (sql: string) => Promise<void> };
  const adapter = (db as unknown as { _adapter: Adapter })._adapter;
  if (!adapter.runAsync) throw new Error('Adapter does not support runAsync');
  await adapter.runAsync(sql);
}

/**
 * Parse the config YAML as a round-trip Document so callers can mutate it while
 * preserving comments and ordering. Pair with {@link saveConfigDoc} to persist.
 */
export function loadConfigDoc(configPath: string): ReturnType<typeof parseDocument> {
  return parseDocument(readFileSync(configPath, 'utf8'));
}

export function saveConfigDoc(configPath: string, doc: ReturnType<typeof parseDocument>): void {
  writeFileSync(configPath, doc.toString(), 'utf8');
}
