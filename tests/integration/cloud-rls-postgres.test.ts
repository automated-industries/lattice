/**
 * Cloud RLS acceptance test: a shared Postgres cloud where each member connects
 * DIRECTLY as their own scoped, non-superuser role, and the DATABASE (not an app
 * layer, not a server) prevents one member from seeing or mutating another's rows.
 *
 * Drives the real installer (`installCloudRls` / `enableRlsForTable`) through
 * lattice, then attacks it over raw member connections. This is the security
 * keystone of the cloud redesign — if it passes, the leak class is closed at the DB.
 *
 * Postgres-gated: runs in CI's postgres job, skipped locally without
 * LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls, enableRlsForTable } from '../../src/cloud/rls.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const SEP = '\t'; // canonical composite-pk separator (chr(9)), matches Lattice._PK_SEP

const pools: pg.Pool[] = [];
const schemas: string[] = [];
const roles: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

/** A pool authenticating as a specific member role, scoped to the test schema.
 *  The role must be swapped INTO the connection string — an embedded user in the
 *  string wins over a separate `user` field, so we'd otherwise stay `postgres`
 *  (a superuser, which bypasses RLS entirely). */
function memberPool(schema: string, role: string, password: string): pg.Pool {
  const u = new URL(PG_URL!);
  u.username = role;
  u.password = password;
  u.searchParams.set('options', `-c search_path=${schema}`);
  const p = new pg.Pool({ connectionString: u.toString(), max: 1 });
  pools.push(p);
  return p;
}

afterEach(async () => {
  for (const p of pools.splice(0)) await p.end();
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)(
  'cloud RLS — direct scoped-role isolation (no server, no app filter)',
  () => {
    it("a member cannot read, mutate, or re-share another member's rows", async () => {
      const tag = randomBytes(4).toString('hex');
      const schema = `rls_${tag}`;
      const alice = `rls_a_${tag}`;
      const bob = `rls_b_${tag}`;
      schemas.push(schema);
      roles.push(alice, bob);

      const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
      pools.push(admin);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const url = schemaUrl(schema);

      // 1) Build the cloud schema via lattice: two user tables (single + composite pk),
      //    then install the RLS bootstrap + per-table policies/triggers.
      const db = new Lattice(url);
      db.define('notes', {
        columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
        render: () => '',
        outputFile: 'notes.md',
      });
      db.define('memo', {
        columns: { a: 'TEXT', b: 'TEXT', body: 'TEXT' },
        primaryKey: ['a', 'b'],
        render: () => '',
        outputFile: 'memo.md',
      });
      await db.init();
      await installCloudRls(db);
      await enableRlsForTable(db, 'notes', db.getPrimaryKey('notes'));
      await enableRlsForTable(db, 'memo', db.getPrimaryKey('memo'));
      // 2) Provision two scoped members through the real API (run as the owner
      //    connection). installCloudRls created the member group with schema +
      //    connect privileges, and enableRlsForTable granted table DML to that group
      //    — so a provisioned member uses the shared tables with NO manual grants and
      //    NO bookkeeping access, while RLS confines it to its own rows.
      const alicePw = generateMemberPassword();
      const bobPw = generateMemberPassword();
      await provisionMemberRole(db, alice, alicePw);
      await provisionMemberRole(db, bob, bobPw);
      db.close();

      const A = memberPool(schema, alice, alicePw);
      const B = memberPool(schema, bob, bobPw);

      // 3) Alice writes and shares some rows via the owner-only helpers.
      await A.query(
        `INSERT INTO notes (id, body) VALUES ('n1','priv'),('n2','shared-all'),('n3','shared-bob')`,
      );
      await A.query(`SELECT lattice_set_row_visibility('notes','n2','everyone')`);
      await A.query(`SELECT lattice_grant_row('notes','n3',$1)`, [bob]);
      await A.query(`INSERT INTO memo (a,b,body) VALUES ('x','1','priv'),('x','2','shared-all')`);
      await A.query(`SELECT lattice_set_row_visibility('memo',$1,'everyone')`, [`x${SEP}2`]);

      // 4) Bob sees ONLY the rows shared to him — never alice's private rows.
      const bobNotes = (await B.query<{ id: string }>(`SELECT id FROM notes ORDER BY id`)).rows.map(
        (r) => r.id,
      );
      expect(bobNotes).toEqual(['n2', 'n3']);
      const bobMemo = (await B.query<{ a: string; b: string }>(`SELECT a,b FROM memo ORDER BY a,b`))
        .rows;
      expect(bobMemo).toEqual([{ a: 'x', b: '2' }]);

      // Alice sees all of her own.
      const aliceNotes = (
        await A.query<{ id: string }>(`SELECT id FROM notes ORDER BY id`)
      ).rows.map((r) => r.id);
      expect(aliceNotes).toEqual(['n1', 'n2', 'n3']);

      // 5) Bob cannot mutate alice's invisible private row (0 rows affected).
      expect((await B.query(`UPDATE notes SET body='hacked' WHERE id='n1'`)).rowCount).toBe(0);
      expect((await B.query(`DELETE FROM notes WHERE id='n1'`)).rowCount).toBe(0);

      // 6) Bob cannot re-share a row he doesn't own.
      await expect(
        B.query(`SELECT lattice_set_row_visibility('notes','n1','everyone')`),
      ).rejects.toThrow(/only the row owner/i);

      // 7) Bob cannot read the bookkeeping directly, nor disable RLS.
      await expect(B.query(`SELECT count(*) FROM "__lattice_owners"`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(B.query(`ALTER TABLE notes DISABLE ROW LEVEL SECURITY`)).rejects.toThrow(
        /must be owner/i,
      );

      // 8) Alice's private row survived every attack, still private.
      const n1 = (await A.query<{ body: string }>(`SELECT body FROM notes WHERE id='n1'`)).rows;
      expect(n1).toEqual([{ body: 'priv' }]);
    });
  },
);
