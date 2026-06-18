/**
 * SECURITY/AVAILABILITY REGRESSION — SQLite-compat polyfills must not abort a
 * member's render.
 *
 * The polyfills (`json_extract` / `strftime`) were registered on EVERY connect
 * with `CREATE OR REPLACE FUNCTION`, which Postgres only allows the function's
 * OWNER to run. On a cloud the function ends up owned by whichever single role
 * created it first, so every OTHER member's per-connect registration raised
 * "must be owner of function" — and because that DDL shared the render
 * transaction, the error ABORTED it and the member's render produced ZERO files.
 *
 * The fix registers the polyfills create-if-absent (a `to_regprocedure`-guarded
 * `DO` block), so a present function is a clean no-op for ANY role. This test
 * runs the exact registration SQL as a non-owner member INSIDE a transaction and
 * asserts the transaction is NOT aborted (a following statement still succeeds)
 * and the polyfill is callable.
 *
 * Postgres-gated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { POSTGRES_POLYFILLS } from '../../src/db/postgres.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const databases: string[] = [];
const roles: string[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

afterEach(async () => {
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  for (const db of databases.splice(0)) {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      )
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('cloud polyfill ownership (availability regression)', () => {
  it('a non-owner member can run polyfill registration in a transaction without aborting it', async () => {
    const dbname = `lattice_poly_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();

    // Owner secures the cloud → creates the polyfills (owned by the group).
    const owner = new Lattice(dbUrl(dbname));
    owner.define('note', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'note.md',
    });
    await owner.init();
    await secureCloud(owner);
    owner.close();

    // Reproduce the exact failure condition: the polyfills are owned by a SINGLE
    // foreign role (as on a real affected cloud where one member created them
    // first). create-if-absent must make a present function a no-op for everyone
    // else regardless of this ownership; the old CREATE OR REPLACE raised "must be
    // owner of function" here and aborted the render.
    const creator = `lm_creator_${randomBytes(3).toString('hex')}`;
    roles.push(creator);
    const adm = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
    await adm.query(`CREATE ROLE "${creator}" NOLOGIN`);
    await adm.query(`ALTER FUNCTION json_extract(text, text) OWNER TO "${creator}"`);
    await adm.query(`ALTER FUNCTION strftime(text, text) OWNER TO "${creator}"`);
    await adm.end();

    // A different member role — NOT the role that owns the polyfills.
    const role = `lm_poly_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    const owner2 = new Lattice(dbUrl(dbname));
    owner2.define('note', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'note.md',
    });
    await owner2.init();
    await provisionMemberRole(owner2, role, pw);
    owner2.close();

    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    const client = await member.connect();
    try {
      // Mimic the render path: registration runs in the SAME transaction as work.
      await client.query('BEGIN');
      for (const { sql } of POSTGRES_POLYFILLS) {
        // create-if-absent → a present function is a no-op for this non-owner; it
        // must NOT raise "must be owner of function" and must NOT poison the tx.
        await client.query(sql);
      }
      // If the registration had aborted the tx, this would throw
      // "current transaction is aborted".
      const after = await client.query('SELECT 1 AS ok');
      expect(after.rows[0]?.ok).toBe(1);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // EXECUTE is granted to everyone, so the member can actually call them.
    const r = await member.query(`SELECT json_extract('{"a":"hi"}', '$.a') AS v`);
    expect(r.rows[0]?.v).toBe('hi');
    await member.end();
  });
});
