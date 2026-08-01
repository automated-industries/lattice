/**
 * There is exactly ONE door to "this column is secret", and it installs the mask.
 *
 * Marking a column secret is two writes, not one. The flag in
 * `_lattice_gui_column_meta` is what hides the column from the assistant and the
 * interface. The database column mask is what stops a member's own connection
 * from selecting it. Only both together mean anything; the flag alone produces
 * the worst state available — the column reads as protected everywhere a person
 * looks, and every member still gets the real value.
 *
 * `setColumnMeta` has always done both, mask first, failing the whole call if the
 * mask fails. The gap was the package surface: `upsertColumnMeta` — exported for
 * writing what a column MEANS — accepted a `secret` flag as well, and wrote it
 * straight to the row. An embedder, a script, or a future caller inside the
 * codebase reaching for the obvious-looking function got the flag with no mask
 * and no warning: a way around the column masking, reachable in one line.
 *
 * These drive that surface on a real secured cloud and read the result as a real
 * scoped member — the only vantage point from which the leak is visible at all,
 * since the owner is allowed to see the value either way. The first asserts the
 * state that must be unreachable (marked secret, member still selects it); the
 * second, that the narrowed writer still does its own job; the third, that the
 * door which installs the mask still marks a column secret for real.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { openConfig, disposeActive } from '../../src/gui/server.js';
import type { ActiveDb } from '../../src/gui/server.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { setColumnMeta } from '../../src/gui/schema-ops.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
// Imported from the package entry point on purpose: this is the surface an
// embedder has, and the surface the gap was in.
import { upsertColumnMeta } from '../../src/index.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const dirs: string[] = [];
const actives: ActiveDb[] = [];
const pools: pg.Pool[] = [];
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
  for (const a of actives.splice(0)) await disposeActive(a);
  for (const p of pools.splice(0)) await p.end();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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

function writeOwnerConfig(url: string): string {
  const root = mkdtempSync(join(tmpdir(), 'lattice-secdoor-'));
  dirs.push(root);
  mkdirSync(join(root, 'context'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      `db: "${url}"`,
      '',
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      body: { type: text }',
      '      salary: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: notes.md',
      '',
    ].join('\n'),
    'utf8',
  );
  return configPath;
}

async function openSecuredOwner(): Promise<{ owner: ActiveDb; dbname: string }> {
  const dbname = `lattice_secdoor_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();

  const cfg = writeOwnerConfig(dbUrl(dbname));
  const owner = await openConfig(cfg, join(cfg, '..', 'context'), false);
  actives.push(owner);
  await owner.converged;
  await secureCloud(owner.db);
  return { owner, dbname };
}

async function memberPoolFor(owner: ActiveDb, dbname: string): Promise<pg.Pool> {
  const role = `lm_secdoor_${randomBytes(3).toString('hex')}`;
  roles.push(role);
  const pw = generateMemberPassword();
  await provisionMemberRole(owner.db, role, pw);
  const pool = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
  pools.push(pool);
  return pool;
}

/** The stored flag, straight off the row. */
async function storedSecretFlag(owner: ActiveDb): Promise<number | undefined> {
  const rows = (await owner.db.query('_lattice_gui_column_meta', {
    filters: [
      { col: 'table_name', op: 'eq', val: 'notes' },
      { col: 'column_name', op: 'eq', val: 'salary' },
    ],
  })) as { secret?: number }[];
  return rows[0]?.secret;
}

describe.skipIf(!PG_URL)('the secret flag cannot be written without its mask', () => {
  it('leaves no column reading as secret that a member can still select', async () => {
    const { owner, dbname } = await openSecuredOwner();
    await owner.db.insertForcingVisibility(
      'notes',
      { body: 'shared note', salary: '250000' },
      'everyone',
    );
    const member = await memberPoolFor(owner, dbname);

    // What an embedder would reasonably write, through the package entry point.
    // The cast is only the type barrier an untyped caller does not have, so what
    // has to hold is the runtime behaviour. How it answers is captured rather
    // than asserted here — the state it leaves behind is the point.
    const answer = await upsertColumnMeta(owner.db, 'notes', 'salary', {
      secret: 1,
    } as unknown as { description?: string | null }).then(
      () => 'accepted',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );

    const markedSecret = (await storedSecretFlag(owner)) === 1;
    const memberReads =
      (await member.query<{ salary: string | null }>(`SELECT salary FROM "notes_v"`)).rows[0]
        ?.salary ?? null;

    // The unreachable state, in one assertion: the column reads as protected
    // AND the member's own connection still returns the value. Reading the real
    // value here is also what proves the probe is live — a mask that was never
    // installed would show up on exactly this select.
    expect(
      { markedSecret, memberReads },
      'a column that reads as secret while a member still selects the value',
    ).toEqual({ markedSecret: false, memberReads: '250000' });

    // And the caller is told which door installs the mask, rather than having
    // the flag quietly dropped.
    expect(answer).toMatch(/setColumnMeta/);
  });

  it('still writes what the column MEANS, and touches neither the flag nor the mask', async () => {
    const { owner, dbname } = await openSecuredOwner();
    await owner.db.insertForcingVisibility(
      'notes',
      { body: 'shared note', salary: '250000' },
      'everyone',
    );
    const member = await memberPoolFor(owner, dbname);

    await upsertColumnMeta(owner.db, 'notes', 'salary', { description: 'Annual pay, in dollars.' });

    const rows = (await owner.db.query('_lattice_gui_column_meta', {
      filters: [
        { col: 'table_name', op: 'eq', val: 'notes' },
        { col: 'column_name', op: 'eq', val: 'salary' },
      ],
    })) as { description?: string | null; secret?: number }[];
    expect(rows[0]?.description).toBe('Annual pay, in dollars.');
    expect(rows[0]?.secret, 'a definition is not secrecy').toBe(0);
    const seen = await member.query<{ salary: string | null }>(`SELECT salary FROM "notes_v"`);
    expect(seen.rows).toEqual([{ salary: '250000' }]);
  });

  it('the gated door still marks it secret — mask AND flag together', async () => {
    const { owner, dbname } = await openSecuredOwner();
    await owner.db.insertForcingVisibility(
      'notes',
      { body: 'shared note', salary: '250000' },
      'everyone',
    );
    const member = await memberPoolFor(owner, dbname);

    const outcome = await setColumnMeta(owner, 'notes', 'salary', { secret: true });
    expect(outcome).toEqual({ ok: true });

    expect(await storedSecretFlag(owner), 'the flag is stored').toBe(1);
    // …and the mask is real: the member reads the row but not the column.
    const seen = await member.query<{ body: string; salary: string | null }>(
      `SELECT body, salary FROM "notes_v"`,
    );
    expect(seen.rows).toEqual([{ body: 'shared note', salary: null }]);
    await expect(member.query(`SELECT salary FROM "notes"`)).rejects.toThrow(/permission denied/i);
  });
});
