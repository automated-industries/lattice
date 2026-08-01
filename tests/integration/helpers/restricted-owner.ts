import pg from 'pg';
import { generateMemberPassword } from '../../../src/cloud/members.js';

// A safe Postgres identifier for the role / database this mints, since both are
// interpolated into DDL (which cannot bind a parameter for a name). Callers pass
// test-generated names; a malformed one fails here rather than inside Postgres.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Provision a RESTRICTED cloud owner — a `LOGIN CREATEROLE NOSUPERUSER
 * NOBYPASSRLS` role plus a database it owns — and return that role's connection
 * URL.
 *
 * Every other Postgres suite connects as the cluster's bootstrap superuser
 * (locally the embedded cluster's `postgres`; in CI the container's
 * `POSTGRES_USER`). A superuser reads THROUGH every row-security policy, so a
 * defect that makes rows invisible to an ordinary owner is invisible to a test
 * written against that connection — the rows come back either way and the
 * assertion passes. Owner-side row security is effectively untested there. This
 * helper closes that gap; a member connection (provisionMemberRole) already
 * covers the other side.
 *
 * `CREATEROLE NOSUPERUSER NOBYPASSRLS` is the combination that matters:
 *   - CREATEROLE is what the owner gate reads (`pg_roles.rolcreaterole`), so this
 *     role takes the same code path a real owner does — it can install the RLS
 *     layer and mint members, rather than being classed as a scoped member.
 *   - NOSUPERUSER + NOBYPASSRLS mean every policy the product installs actually
 *     applies to the connection, which is the position a deployment that did not
 *     hand out superuser is in.
 *
 * Owning the database is what lets the role create and own its own tables: from
 * PG 15 the `public` schema belongs to `pg_database_owner`, so the database owner
 * owns it implicitly — no extra grant needed, and no superuser step beyond the
 * `CREATE DATABASE` itself.
 *
 * The password is generated here and only ever travels inside the returned URL.
 * Teardown is the caller's, alongside the databases/roles it already tracks —
 * drop the DATABASE first, because Postgres refuses to drop a role that still
 * owns one. Securing a cloud also creates the per-cloud member group role
 * (memberGroupFor), which outlives the database and needs dropping too.
 */
export async function provisionRestrictedOwner(
  clusterUrl: string,
  dbname: string,
  role: string,
): Promise<string> {
  for (const name of [dbname, role]) {
    if (!IDENT_RE.test(name)) throw new Error(`restricted owner: unsafe identifier "${name}"`);
  }
  const password = generateMemberPassword(); // hex — always safe to interpolate
  const admin = new pg.Pool({ connectionString: clusterUrl, max: 1 });
  try {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`,
    );
    await admin.query(`CREATE DATABASE "${dbname}" OWNER "${role}"`);
  } finally {
    await admin.end();
  }
  const u = new URL(clusterUrl);
  u.pathname = `/${dbname}`;
  u.username = role;
  u.password = password;
  return u.toString();
}
