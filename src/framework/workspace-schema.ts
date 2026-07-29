/**
 * The ONE definition of "what schema does an opened workspace have".
 *
 * A workspace can be opened three ways — from the library, from a command, from
 * the browser — and every one of them must end up with the SAME set of tables
 * and the SAME rendered layout. When they disagree, the disagreement is not
 * cosmetic: the rendered `Context/` tree is reconciled against a manifest of
 * what the LAST render produced, so a client that opens with a smaller schema
 * reads every context it does not know about as "this was removed" and DELETES
 * it from disk. One client renders the tree, the next deletes it, the next
 * renders it again — with no error at any point.
 *
 * That is why this lives in its own module instead of being repeated at each
 * open site: the repetition is what drifted, twice. Every opener calls
 * {@link applyWorkspaceSchema} and there is nothing left to keep in sync.
 */
import type { Lattice } from '../lattice.js';
import type { TableDefinition } from '../types.js';
import { deriveCanonicalContexts } from './canonical-context.js';
import { registerNativeEntities } from './native-entities.js';

/**
 * Give an opened workspace its full schema: the canonical, database-aligned
 * `Context/` layout for every table that does not declare one of its own, plus
 * the framework's own tables (the file index, the secret store, and the rest).
 *
 * Order matters. The canonical layout is applied FIRST so that a workspace which
 * declares its own version of a framework table keeps exactly the rendered shape
 * its declaration earns; the framework never registers over a declaration.
 *
 * @param tables the workspace's declared tables, as parsed from its config.
 */
export function applyWorkspaceSchema(
  db: Lattice,
  tables: readonly { name: string; definition: TableDefinition }[],
): void {
  const existing = db.entityContexts();
  for (const { table, definition } of deriveCanonicalContexts(tables)) {
    if (!existing.has(table)) db.defineEntityContext(table, definition);
  }
  registerNativeEntities(db);
}
