import {
  undoLast,
  redoLast,
  revertEntry,
  parseAudit,
  maskEncryptedJson,
  auditEntryWithoutImages,
} from '../../mutations.js';
import { requireString } from './helpers.js';
import { NOT_HANDLED, type HandlerDeps, type GroupResult } from './types.js';

export async function handleHistory(deps: HandlerDeps): Promise<GroupResult> {
  const { ctx, mctx, name, args } = deps;
  switch (name) {
    case 'get_history': {
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      const rows = (await ctx.db.query('_lattice_gui_audit', { limit })) as Record<
        string,
        unknown
      >[];
      let entries = rows.map(parseAudit);
      if (typeof args.table === 'string')
        entries = entries.filter((e) => e.table_name === args.table);
      // Same S4 credential mask the HTTP /api/history route applies — this tool result is
      // serialized verbatim into the model's tool_result. before_json/after_json are db.get
      // snapshots that DECRYPT encrypted columns, so drop `secrets` entries and mask every
      // framework-encrypted column, or an edit to an `encrypted:` column would stream cleartext
      // into model context.
      entries = entries
        .filter((e) => e.table_name !== 'secrets')
        .map((e) => {
          const enc = ctx.db.getEncryptedColumns(e.table_name);
          return {
            ...e,
            before_json: maskEncryptedJson(e.before_json, enc),
            after_json: maskEncryptedJson(e.after_json, enc),
          };
        });
      return { ok: true, result: entries };
    }
    case 'undo': {
      const entry = await undoLast(mctx);
      // Strip the decrypted before/after images from the echoed entry (they'd stream into model
      // context); the model only needs table_name/row_id/operation.
      return entry
        ? { ok: true, result: auditEntryWithoutImages(entry) }
        : { ok: false, error: 'Nothing to undo' };
    }
    case 'redo': {
      const entry = await redoLast(mctx);
      return entry
        ? { ok: true, result: auditEntryWithoutImages(entry) }
        : { ok: false, error: 'Nothing to redo' };
    }
    case 'revert': {
      const auditId = requireString(args.auditId, 'auditId');
      const result = await revertEntry(mctx, auditId);
      return result.ok
        ? { ok: true, result: auditEntryWithoutImages(result.entry) }
        : {
            ok: false,
            error: result.reason === 'not_found' ? 'Audit entry not found' : 'Entry already undone',
          };
    }
    default:
      return NOT_HANDLED;
  }
}
