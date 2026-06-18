import { undoLast, redoLast, revertEntry, parseAudit } from '../../mutations.js';
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
      return { ok: true, result: entries };
    }
    case 'undo': {
      const entry = await undoLast(mctx);
      return entry ? { ok: true, result: entry } : { ok: false, error: 'Nothing to undo' };
    }
    case 'redo': {
      const entry = await redoLast(mctx);
      return entry ? { ok: true, result: entry } : { ok: false, error: 'Nothing to redo' };
    }
    case 'revert': {
      const auditId = requireString(args.auditId, 'auditId');
      const result = await revertEntry(mctx, auditId);
      return result.ok
        ? { ok: true, result: result.entry }
        : {
            ok: false,
            error: result.reason === 'not_found' ? 'Audit entry not found' : 'Entry already undone',
          };
    }
    default:
      return NOT_HANDLED;
  }
}
