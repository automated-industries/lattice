import type { Lattice } from '../lattice.js';
import { allAsyncOrSync } from '../db/adapter.js';
import { cloudRlsInstalled, canManageRoles } from '../framework/cloud-connect.js';
import { currentDatabaseRole } from './member-directory.js';

/**
 * "What is the state of this cloud, and where do I stand on it?" — as a
 * capability.
 *
 * This is the question every other cloud operation depends on the answer to. Am
 * I the owner or a member? Is row security actually installed, or is this a
 * plain Postgres somebody assumed was a cloud? Is a table sitting there
 * unprotected? Until now the only thing that could answer it was the browser
 * app's settings panel — which is exactly the thing that stops working when the
 * answer is bad. Diagnosing a broken workspace required the client the breakage
 * had already taken away, and on a machine with no display the workaround was to
 * publish that client on a network address it calls unauthenticated.
 *
 * STRICTLY READ-ONLY, and that is a design constraint rather than an
 * implementation detail. The convergence pass that repairs this drift
 * (`reconcileCloudMemberAccess`) issues grants and alters tables; running it to
 * produce a report would mean you could not look at a damaged cloud without
 * also changing it. So the drift is read straight out of the system catalog
 * instead, and the report names the command that repairs what it found.
 *
 * Authority is not re-invented: standing is read from the connected Postgres
 * role's own privileges, the same source every owner-gated operation uses.
 */

/** Where the connected role stands on the database it is looking at. */
export type CloudStanding =
  /** A secured cloud, and this role may create roles — it owns the cloud. */
  | 'owner'
  /** A secured cloud, and this role is scoped — it is a member of it. */
  | 'member'
  /** Row security is not installed, so there is no cloud to stand on. */
  | 'not-a-cloud';

/** One piece of drift between what the workspace declares and what the database has. */
export interface CloudStatusWarning {
  /** The table the warning is about. */
  table: string;
  /** What is wrong, and — where there is one — the exact repair. */
  reason: string;
}

export interface CloudStatus {
  /** Which engine the workspace is on. Only Postgres can be a cloud. */
  dialect: 'sqlite' | 'postgres';
  /** True when the row-security bookkeeping is installed on this database. */
  secured: boolean;
  /** The database role this connection is authenticated as; empty off Postgres. */
  role: string;
  /** Owner, member, or not a cloud at all. */
  standing: CloudStanding;
  /**
   * Drift a convergence pass would repair: the registered tables in the order
   * they are registered, then anything else the database turns out to hold.
   * Empty on a healthy cloud.
   */
  warnings: CloudStatusWarning[];
}

/** One relation as the catalog knows it. */
interface CatalogRelation {
  name: string;
  owner: string;
  kind: string;
  forced: boolean;
}

/**
 * A relation that stores rows of its own, and can therefore carry row security.
 * A view holds none — Postgres rejects `ALTER … FORCE ROW LEVEL SECURITY` on one
 * — so an unforced view is not drift, and reporting it as such would be noise
 * that never goes away however many times the repair is run.
 */
function ownsRows(kind: string): boolean {
  return kind === 'r' || kind === 'p' || kind === 'f';
}

/** Double-quote a Postgres identifier for an instruction a human will paste. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * What the catalog holds, keyed by name: the workspace's declared `tables`, AND
 * every ordinary relation physically present in the schema.
 *
 * Both halves are load-bearing. Declared-only cannot see a table nobody
 * declared, which is the one most likely to be unprotected — see
 * {@link driftWarnings}. Physical-only cannot see a declared table that is
 * missing. One query answers both, and it stays ONE query: the four columns
 * here are the four the warnings are built from, so nothing needs a per-table
 * follow-up round trip — which matters on a database billed for what it reads
 * out.
 *
 * Bookkeeping is excluded by the leading underscore every internal table
 * carries: it is the mechanism, the installer secures it rather than the
 * per-table pass, and listing it would bury the real answer under rows nobody
 * can act on. A declared name matches whatever it looks like, so a workspace
 * that declares a view still gets the ownership check on it.
 */
async function catalogRelations(
  db: Lattice,
  tables: readonly string[],
): Promise<Map<string, CatalogRelation>> {
  const rows = (await allAsyncOrSync(
    db.adapter,
    `SELECT c.relname AS name,
            pg_get_userbyid(c.relowner) AS owner,
            c.relkind AS kind,
            c.relforcerowsecurity AS forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND (c.relname = ANY(?::text[])
             OR (c.relkind IN ('r','p','f') AND c.relname NOT LIKE '\\_%' ESCAPE '\\'))`,
    [[...tables]],
  )) as { name: string; owner: string | null; kind: string | null; forced: boolean | null }[];
  return new Map(
    rows.map((r) => [
      r.name,
      { name: r.name, owner: r.owner ?? '', kind: r.kind ?? '', forced: r.forced === true },
    ]),
  );
}

/**
 * The drift between what this workspace declares and what the database holds.
 *
 * Three things are worth saying, and each of them is a real failure somebody has
 * hit:
 *
 *  1. a declared table that is not in the database at all — the workspace will
 *     read and render nothing for it;
 *  2. a table owned by a DIFFERENT Postgres role than the one connecting, which
 *     is what makes a convergence pass skip it: the connecting role cannot alter
 *     or grant on a table it does not own, so that table silently stays outside
 *     the member model. Only reported to an owner, because it is neither
 *     surprising nor actionable for a member — a member never owns anything;
 *  3. row security not forced on a secured cloud, which means every member can
 *     read every row of that table. This one is reported to a member too: they
 *     cannot repair it, but they are entitled to know their rows are not private.
 *
 * The third is also what catches a table nobody declared. Securing walks the
 * REGISTERED tables, so a table restored from a dump, created by hand, or left
 * behind by a schema nobody opens any more is never walked — and a table
 * securing never reached is precisely a table with row security off. A keyless
 * one arrives at the same place from the other side, because per-row ownership
 * needs a key and securing skips what it cannot key. Both read `forced=false`
 * here, so both land in the third warning; neither needs one of its own.
 *
 * For an undeclared table that overstates things slightly on the day it is
 * reported: no member holds a grant on it, so no member can read it yet. It is
 * still the right thing to say — the table is outside the row ownership model,
 * and the grant is the easy half. Registering it, restoring over it, or one
 * GRANT is all it takes, and none of those produces a second warning.
 */
async function driftWarnings(
  db: Lattice,
  opts: { secured: boolean; isOwner: boolean; role: string },
): Promise<CloudStatusWarning[]> {
  const declared = db
    .getRegisteredTableNames()
    .filter((t) => !t.startsWith('__lattice_') && !t.startsWith('_lattice_'));
  const catalog = await catalogRelations(db, declared);
  const warnings: CloudStatusWarning[] = [];
  for (const table of new Set([...declared, ...catalog.keys()])) {
    const rel = catalog.get(table);
    if (!rel) {
      // Only a declared name can be missing from the catalog — every other name
      // in this loop came OUT of the catalog. Saying that out loud is what keeps
      // the wording below true if this set ever grows a third source.
      if (declared.includes(table)) {
        warnings.push({
          table,
          reason:
            'declared by this workspace but not present in the database — it was never created, ' +
            'or it was dropped outside Lattice',
        });
      }
      continue;
    }
    if (opts.isOwner && rel.owner !== opts.role) {
      warnings.push({
        table,
        reason:
          `owned by Postgres role "${rel.owner}", but this workspace connects as ` +
          `"${opts.role}" — securing skips it, so it stays outside the member model. ` +
          `Fix with: ALTER TABLE ${quoteIdent(table)} OWNER TO ${quoteIdent(opts.role)};`,
      });
    }
    if (opts.secured && ownsRows(rel.kind) && !rel.forced) {
      warnings.push({
        table,
        reason:
          'row security is not forced — every member can read every row of it. ' +
          'Run `lattice cloud secure` to converge it.',
      });
    }
  }
  return warnings;
}

/**
 * Report the state of the cloud behind an open workspace, without changing any
 * of it.
 *
 * A SQLite workspace is answered honestly rather than refused: it is a private
 * local store, so it is `not-a-cloud` with nothing to warn about. A Postgres
 * database that nobody has secured yet answers the same way, and its warnings
 * are still computed — an unreachable or unowned table is worth knowing about
 * before the cloud is made, not after.
 */
export async function cloudStatus(db: Lattice): Promise<CloudStatus> {
  const dialect = db.getDialect();
  if (dialect !== 'postgres') {
    return { dialect, secured: false, role: '', standing: 'not-a-cloud', warnings: [] };
  }
  const [secured, isOwner, role] = await Promise.all([
    cloudRlsInstalled(db),
    canManageRoles(db),
    currentDatabaseRole(db),
  ]);
  const standing: CloudStanding = !secured ? 'not-a-cloud' : isOwner ? 'owner' : 'member';
  const warnings = await driftWarnings(db, { secured, isOwner, role });
  return { dialect, secured, role, standing, warnings };
}
