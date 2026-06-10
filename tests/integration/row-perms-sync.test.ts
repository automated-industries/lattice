import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import {
  CLOUD_INTERNAL_TABLE_DEFS,
  installRowPermsSchema,
} from '../../src/teams/internal-tables.js';
import { recordRowAcl, addRowGrant } from '../../src/teams/row-access.js';
import { appendChangeEnvelope } from '../../src/teams/team-core.js';

const TEAM = 'team-1';
const ALICE = 'u-alice';
const BOB = 'u-bob';
const CAROL = 'u-carol';

const dbs: Lattice[] = [];
const dirs: string[] = [];

async function makeCloud(): Promise<Lattice> {
  const dir = mkdtempSync(join(tmpdir(), 'row-sync-'));
  dirs.push(dir);
  const db = new Lattice(join(dir, 'cloud.db'));
  await db.init();
  for (const [t, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
    await db.defineLate(t, def);
  }
  await installRowPermsSchema(db);
  const now = new Date().toISOString();
  await db.upsert('__lattice_shared_objects', {
    team_id: TEAM,
    table_name: 'tasks',
    schema_spec_json: '{}',
    schema_version: 1,
    created_by_user_id: ALICE,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    default_row_visibility: 'everyone',
  });
  await db.upsert('__lattice_object_owners', {
    team_id: TEAM,
    table_name: 'tasks',
    owner_user_id: ALICE,
    created_at: now,
  });
  dbs.push(db);
  return db;
}

async function tags(db: Lattice, userId: string): Promise<string[]> {
  const rows = (await db.listChangesForRecipient(TEAM, 0, userId, 1000)) as {
    pk: string | null;
    op: string;
  }[];
  return rows.map((r) => `${r.pk ?? 'TABLE'}:${r.op}`);
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('per-recipient change-log filter (hosted sync enforcement)', () => {
  it('delivers each envelope only to the members permitted to see its row', async () => {
    const db = await makeCloud();
    await recordRowAcl(db, TEAM, 'tasks', 'priv', ALICE, 'private');
    await recordRowAcl(db, TEAM, 'tasks', 'evry', ALICE, 'everyone');
    await recordRowAcl(db, TEAM, 'tasks', 'cust', ALICE, 'private');
    await addRowGrant(db, TEAM, 'tasks', 'cust', BOB, ALICE); // cust → custom + grant Bob

    const env = (pk: string | null, op: string, recipient?: string): Promise<number> =>
      appendChangeEnvelope(db, {
        team_id: TEAM,
        table_name: 'tasks',
        pk,
        op: op as 'upsert' | 'unlink' | 'schema',
        payload_json: op === 'unlink' ? null : '{}',
        owner_user_id: op === 'schema' ? null : ALICE,
        ...(recipient ? { recipient_user_id: recipient } : {}),
      });

    await env('priv', 'upsert'); // owner-only
    await env('evry', 'upsert'); // all
    await env('cust', 'upsert'); // owner + Bob
    await env('noacl', 'upsert'); // no ACL entry → table default everyone → all
    await env(null, 'schema'); // table-level broadcast → all
    await env('cust', 'unlink', CAROL); // targeted revoke to Carol only

    const alice = await tags(db, ALICE);
    const bob = await tags(db, BOB);
    const carol = await tags(db, CAROL);

    // Owner sees all her rows + the table-level envelope.
    expect(alice).toEqual(
      expect.arrayContaining([
        'priv:upsert',
        'evry:upsert',
        'cust:upsert',
        'noacl:upsert',
        'TABLE:schema',
      ]),
    );

    // Bob: everyone + granted custom + no-ACL(default everyone) + schema; NOT the private row.
    expect(bob).toEqual(
      expect.arrayContaining(['evry:upsert', 'cust:upsert', 'noacl:upsert', 'TABLE:schema']),
    );
    expect(bob).not.toContain('priv:upsert');
    expect(bob).not.toContain('cust:unlink'); // targeted at Carol, not Bob

    // Carol: everyone + no-ACL + schema + her TARGETED unlink; NOT private, NOT the
    // ungranted custom upsert.
    expect(carol).toEqual(
      expect.arrayContaining(['evry:upsert', 'noacl:upsert', 'TABLE:schema', 'cust:unlink']),
    );
    expect(carol).not.toContain('priv:upsert');
    expect(carol).not.toContain('cust:upsert');
  });

  it('a revoke (everyone → private) stops future delivery to a non-owner', async () => {
    const db = await makeCloud();
    await recordRowAcl(db, TEAM, 'tasks', 'r1', ALICE, 'everyone');
    await appendChangeEnvelope(db, {
      team_id: TEAM,
      table_name: 'tasks',
      pk: 'r1',
      op: 'upsert',
      payload_json: '{}',
      owner_user_id: ALICE,
    });
    expect(await tags(db, BOB)).toContain('r1:upsert'); // visible while everyone

    // Owner narrows the row to private → Bob no longer pulls its envelope.
    await recordRowAcl(db, TEAM, 'tasks', 'r1', ALICE, 'private');
    expect(await tags(db, BOB)).not.toContain('r1:upsert');
    expect(await tags(db, ALICE)).toContain('r1:upsert'); // owner keeps it
  });
});
