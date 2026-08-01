/**
 * A scoped cloud member's render must not read owner-only bookkeeping.
 *
 * The cleanup backstop asks, before every sweep, which tables a connected
 * external source owns — so that a process whose schema is missing those tables
 * cannot read their rendered trees as removed and delete them. That question is
 * answered from the connector registry, which on a cloud is owner-only: a member
 * holds no grant on it at all (see `cloud/member-access.ts`
 * OWNER_ONLY_BOOKKEEPING), and securing a table creates the registry
 * unconditionally, so the "does it exist?" guard that spares a workspace which
 * never connected anything can never be false here.
 *
 * Asked from a member session the read is therefore refused every time the
 * backstop is consulted, for the life of the session. Nothing raises — the
 * refusal is turned into an unresolved connected source, which is a claim about
 * the workspace made out of a permission error, and it tells the operator to
 * reconnect a source that may not exist.
 *
 * A member never registers a connected-source table in the first place (the
 * replay is on the far side of the introspect-only return in `init()`), so the
 * answer for a member is empty whatever the registry says. These tests pin that
 * the member SESSION never issues the read, that its render still completes, and
 * that the member still cannot read that table — the fix must come from not
 * asking, never from widening the grant.
 *
 * Postgres-gated (real per-test cloud database + a real member login role).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { memberGroupFor } from '../../src/cloud/rls.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { CONNECTORS_TABLE } from '../../src/connectors/registry.js';
import { getAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const databases: string[] = [];
const roles: string[] = [];
const opened: Lattice[] = [];
const scratches: string[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/** Two ordinary workspace tables, each rendering one file. Deliberately NOT named
 *  after a native entity: the backstop filters those out of both sides of its
 *  comparison, which would route the test into a different branch than the one
 *  under test. */
function defineTables(db: Lattice): void {
  for (const name of ['alpha', 'beta']) {
    db.define(name, {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: (rows) => rows.map((r) => `- ${String(r.id)}`).join('\n'),
      outputFile: `${name}.md`,
    });
  }
}

/**
 * Record every statement a Lattice's connection issues, by wrapping the adapter's
 * own query surface. Both the sync and async halves, because the read under test
 * runs through the async one on Postgres and a wrapper over half of them would
 * report an absence it never checked.
 */
function recordStatements(db: Lattice): string[] {
  const seen: string[] = [];
  const adapter = db.adapter as unknown as Record<string, unknown>;
  for (const method of ['get', 'all', 'run', 'getAsync', 'allAsync', 'runAsync']) {
    const original = adapter[method];
    if (typeof original !== 'function') continue;
    const fn = original as (...args: unknown[]) => unknown;
    adapter[method] = function wrapped(this: unknown, ...args: unknown[]): unknown {
      if (typeof args[0] === 'string') seen.push(args[0]);
      return fn.apply(this, args);
    };
  }
  return seen;
}

/** A secured cloud, a member login role, and a rendered tree the OWNER wrote. */
async function setup(tag: string): Promise<{
  owner: Lattice;
  member: Lattice;
  memberRole: string;
  memberPassword: string;
  dbname: string;
  outputDir: string;
}> {
  const dbname = `lattice_${tag}_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();

  const owner = new Lattice(dbUrl(dbname));
  opened.push(owner);
  defineTables(owner);
  await owner.init();
  await secureCloud(owner);
  // The per-cloud member group is cluster-level and survives dropping the
  // database, so it is tracked for teardown alongside the member itself.
  roles.push(await memberGroupFor(owner));

  const memberRole = `lm_${tag}_${randomBytes(3).toString('hex')}`;
  const memberPassword = generateMemberPassword();
  roles.push(memberRole);
  await provisionMemberRole(owner, memberRole, memberPassword);

  await owner.insert('alpha', { id: 'a1', body: 'one' });
  await owner.insert('beta', { id: 'b1', body: 'two' });

  const outputDir = mkdtempSync(join(tmpdir(), `lattice-${tag}-`));
  scratches.push(outputDir);
  await owner.render(outputDir);

  const member = new Lattice(dbUrl(dbname, memberRole, memberPassword));
  opened.push(member);
  defineTables(member);
  await member.init();
  return { owner, member, memberRole, memberPassword, dbname, outputDir };
}

afterEach(async () => {
  for (const d of opened.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
  for (const s of scratches.splice(0)) rmSync(s, { recursive: true, force: true });
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const db of databases.splice(0)) {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      )
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => undefined);
  }
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)(
  'a scoped cloud member renders without reading the connector registry',
  () => {
    it('issues no read of the registry across a render and a reconciliation', async () => {
      const { owner, member, memberRole, memberPassword, dbname, outputDir } = await setup('mrc');

      // Guard 1 — this really is a scoped member open. Against an owner connection
      // the read under test is permitted, so every assertion below would hold for
      // the wrong reason.
      expect(member.isCloudMemberOpen()).toBe(true);

      // Guard 2 — the registry really is there. It is created unconditionally while
      // securing, so the existence check that spares a workspace which never
      // connected anything cannot be what keeps the member away from it.
      const reg = (await getAsyncOrSync(
        owner.adapter,
        `SELECT to_regclass('${CONNECTORS_TABLE}') AS reg`,
      )) as { reg?: unknown } | undefined;
      expect(reg?.reg).not.toBeNull();
      expect(reg?.reg).toBeDefined();

      // Guard 3 — the member holds nothing on it, and that is the state the fix must
      // preserve. Asked on the member's OWN login, not through the library.
      const asMember = new pg.Pool({
        connectionString: dbUrl(dbname, memberRole, memberPassword),
        max: 1,
      });
      try {
        await expect(asMember.query(`SELECT * FROM "${CONNECTORS_TABLE}"`)).rejects.toThrow(
          /permission denied/i,
        );
      } finally {
        await asMember.end();
      }

      const statements = recordStatements(member);

      // The member's own render still produces its files — the point of the fix is
      // that the session works, not that the failing read is merely quieter.
      const rendered = await member.render(outputDir);
      expect(rendered.filesWritten.length).toBeGreaterThan(0);

      const reconciled = await member.reconcile(outputDir);

      // The read is never issued. This is the finding itself: it fired once per
      // cleanup pass, and a caught permission error leaves no other trace.
      expect(statements.filter((s) => s.includes(CONNECTORS_TABLE))).toEqual([]);

      // Nothing downstream reports the workspace in terms of that failure, and the
      // pass is clean rather than merely quiet.
      expect(reconciled.cleanup.warnings).toEqual([]);
      expect(existsSync(join(outputDir, 'alpha.md'))).toBe(true);
      expect(existsSync(join(outputDir, 'beta.md'))).toBe(true);
    });

    it('does not describe the workspace as having a source it cannot account for', async () => {
      // The same session, but with a narrower declared layout than the tree the
      // owner rendered — the shape that makes the backstop consult the connected
      // sources at all, and so the shape where the permission error was turned into
      // an operator-facing claim about the workspace.
      const { owner, dbname, memberRole, memberPassword, outputDir } = await setup('mrn');
      void owner;

      const narrow = new Lattice(dbUrl(dbname, memberRole, memberPassword));
      opened.push(narrow);
      narrow.define('alpha', {
        columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
        render: (rows) => rows.map((r) => `- ${String(r.id)}`).join('\n'),
        outputFile: 'alpha.md',
      });
      await narrow.init();
      expect(narrow.isCloudMemberOpen()).toBe(true);

      const statements = recordStatements(narrow);
      const reconciled = await narrow.reconcile(outputDir);

      expect(statements.filter((s) => s.includes(CONNECTORS_TABLE))).toEqual([]);
      expect(reconciled.cleanup.warnings.join('\n')).not.toMatch(
        /connector registry|permission denied|Reconnect the source/i,
      );
    });
  },
);
