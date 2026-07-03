// ---------------------------------------------------------------------------
// Silent config-shape upgrade-on-open.
//
// 4.0 keeps PARSING 3.x config shapes (see config/parser.ts) so an existing
// config never fails to open. Separately, when the GUI opens a config it rewrites
// the on-disk YAML to the current shape — silently, preserving comments + layout —
// so real-world configs migrate forward and a FUTURE major can drop the parser's
// back-compat tolerance once configs are upgraded.
//
// Each upgrade here MUST be idempotent (a config already in the new shape is left
// byte-untouched and triggers no write) and MUST mirror exactly what the parser's
// tolerance does in-memory, so the on-disk rewrite never changes behavior.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument, isMap } from 'yaml';

/**
 * Rewrite the deprecated per-field `ref: <table>` shorthand to an explicit
 * entity-level `relations:` belongsTo (relation name = field name minus a trailing
 * `_id`) — exactly the conversion the parser does in-memory. An explicit
 * `relations:` entry of the same name already wins in the parser, so we never
 * clobber one here. Mutates the Document in place; returns whether it changed it.
 */
function upgradeRefShorthand(doc: ReturnType<typeof parseDocument>): boolean {
  const entities: unknown = doc.get('entities');
  if (!isMap(entities)) return false;
  let changed = false;
  for (const entItem of entities.items) {
    const entityName = String(entItem.key);
    const fields: unknown = doc.getIn(['entities', entityName, 'fields']);
    if (!isMap(fields)) continue;
    for (const fieldItem of fields.items) {
      const fieldName = String(fieldItem.key);
      const refVal: unknown = doc.getIn(['entities', entityName, 'fields', fieldName, 'ref']);
      if (typeof refVal !== 'string' || refVal.length === 0) continue;
      const relName = fieldName.endsWith('_id') ? fieldName.slice(0, -3) : fieldName;
      if (!doc.hasIn(['entities', entityName, 'relations', relName])) {
        doc.setIn(['entities', entityName, 'relations', relName], {
          type: 'belongsTo',
          table: refVal,
          foreignKey: fieldName,
        });
      }
      doc.deleteIn(['entities', entityName, 'fields', fieldName, 'ref']);
      changed = true;
    }
  }
  return changed;
}

/**
 * Rewrite legacy ROOT-LEVEL `outputFile` values to the hidden `.schema-only/`
 * home. Early create paths persisted `outputFile: <NAME>.md` (upper-cased, at the
 * Context root) for GUI-created entities and junctions; the writers were fixed to
 * default `.schema-only/<name>.md`, but existing configs were never migrated — so
 * every render kept re-creating a root-level rollup (e.g. STATES.md) right next
 * to the table's per-record folder (States/), an orphan the user can't delete
 * (it reappears on the next render). A root-level rollup is always an anomaly:
 * the compiled default has been `.schema-only/<table>.md` since the fix, so any
 * bare `<X>.md` (no directory) is rewritten. Idempotent — values containing a
 * path separator are never touched.
 */
function upgradeLegacyRootOutputFile(doc: ReturnType<typeof parseDocument>): boolean {
  const entities: unknown = doc.get('entities');
  if (!isMap(entities)) return false;
  let changed = false;
  for (const entItem of entities.items) {
    const entityName = String(entItem.key);
    const val: unknown = doc.getIn(['entities', entityName, 'outputFile']);
    if (typeof val !== 'string') continue;
    if (val.includes('/') || val.includes('\\')) continue; // already homed somewhere
    if (!val.toLowerCase().endsWith('.md')) continue;
    doc.setIn(['entities', entityName, 'outputFile'], `.schema-only/${entityName}.md`);
    changed = true;
  }
  return changed;
}

/** Every config-shape upgrade, applied in order. Add future ones here. */
const UPGRADES: ((doc: ReturnType<typeof parseDocument>) => boolean)[] = [
  upgradeRefShorthand,
  upgradeLegacyRootOutputFile,
];

/**
 * Silently upgrade an on-disk config to the current shape, preserving comments
 * and formatting. Idempotent: a config already in the current shape is left
 * untouched and NOT rewritten. Returns true iff the file was rewritten.
 *
 * Best-effort migrate-forward: the open does not depend on it (the parser tolerates
 * the old shape). The caller wraps it so a write failure is surfaced, not silently
 * swallowed, while the open still proceeds.
 */
export function upgradeConfigShape(configPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return false; // no readable config → nothing to upgrade
  }
  const doc = parseDocument(raw);
  let changed = false;
  for (const upgrade of UPGRADES) {
    if (upgrade(doc)) changed = true;
  }
  if (!changed) return false;
  writeFileSync(configPath, doc.toString(), 'utf8');
  return true;
}
