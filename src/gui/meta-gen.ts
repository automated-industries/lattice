/**
 * Non-blocking, fail-silent hooks that auto-generate column + table definitions
 * via a cheap model when a user creates a column or table.
 *
 * This module resolves the Claude client (so the leaf `column-descriptions`
 * generators stay client-agnostic) and is imported only by the ctx-building
 * sites (server, ingest-routes, chat-routes). Crucially, `ai/dispatch` does NOT
 * import it — so the `dispatch → chat → …` graph never loops back here.
 */
import type { Lattice } from '../lattice.js';
import { resolveLlmClient } from './ai/provider.js';
import {
  generateAndStoreColumnDescriptions,
  generateAndStoreTableDescription,
} from './column-descriptions.js';

async function resolveClientOrNull(db: Lattice) {
  try {
    return await resolveLlmClient(db);
  } catch {
    return null;
  }
}

/** Hook for `MutationCtx.onColumnsAdded`: define new columns in the background. */
export function columnDescriptionHook(db: Lattice): (table: string, columns: string[]) => void {
  return (table, columns) => {
    void (async () => {
      const client = await resolveClientOrNull(db);
      await generateAndStoreColumnDescriptions(db, table, columns, client);
    })();
  };
}

/** Hook for a new user table: define it in the background. */
export function tableDescriptionHook(db: Lattice): (table: string, columns: string[]) => void {
  return (table, columns) => {
    void (async () => {
      const client = await resolveClientOrNull(db);
      await generateAndStoreTableDescription(db, table, columns, client);
    })();
  };
}
