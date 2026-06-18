/**
 * Regression — a file ingested in "Private mode" on a CLOUD must NOT leak to
 * members, and NEITHER may its enrichment-derived rows + junction links.
 *
 * Two defects this pins (both visible to a member before the fix, gone after):
 *
 *   1. The ingest routes created the `files` row with NO forced visibility, so a
 *      private-toggle upload inherited the files-table default — which, once the
 *      owner has shared the files table ('everyone'), means the "private" file is
 *      visible to the whole workspace.
 *   2. enrichWithLlm wrote its derived rows (extracted-object entity rows, the
 *      fallback note) and junction links in SEPARATE transactions with no forced
 *      visibility. The forced-visibility GUC is transaction-local, so each derived
 *      write fell back to its own table default — leaking the private file's
 *      extracted contents + its relationships even when the file row itself was
 *      forced private.
 *
 * The condition that surfaces the bug is the realistic one: the files table AND
 * the junction are PRE-SHARED ('everyone' default). A fresh junction would default
 * to private, so the junction assertion would pass vacuously without pre-sharing.
 *
 * Drives the REAL /api/ingest/text route (not a tool), with enrichment stubbed to
 * run deterministically: one extracted entity row reusing an existing (shared)
 * entity + one files↔entity junction link for the private file.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { FeedBus } from '../../src/gui/feed.js';
import type { FileJunction } from '../../src/gui/data.js';

// Enrichment runs against a fake Anthropic client; the summarize leaf is stubbed
// so the run is deterministic: no real network, one reused entity, one link.
const PEOPLE = 'people';
const JUNCTION = `files_${PEOPLE}`;

vi.mock('../../src/gui/ai/chat.js', async (orig) => {
  const actual = await orig();
  return { ...actual, createAnthropicClient: () => ({}) };
});
vi.mock('../../src/gui/ai/summarize.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    summarizeText: () => Promise.resolve('a deterministic summary'),
    // No classify-link junction — keep exactly ONE junction row (the extracted
    // object's link) so the junction assertion is unambiguous.
    classifyLinks: () => Promise.resolve([]),
    // Reuse the EXISTING (pre-shared) `people` entity, but materialize a NEW row
    // (no fixed id — enrich assigns the uuid). The derived row AND the junction
    // linking it to the private file must both be forced private, even though the
    // entity TABLE defaults to 'everyone'.
    extractObjects: () =>
      Promise.resolve([
        {
          entity: PEOPLE,
          isNew: false,
          columns: [],
          values: { name: 'Dana Doe' },
          label: 'Dana Doe',
        },
      ]),
  };
});

// Import AFTER the mocks so enrich.ts binds the stubbed summarize leaf.
const { dispatchIngestRoute } = await import('../../src/gui/ingest-routes.js');

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const pools: pg.Pool[] = [];
const dbs: Lattice[] = [];
const schemas: string[] = [];
const roles: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}
function memberPool(schema: string, role: string, password: string): pg.Pool {
  const u = new URL(PG_URL!);
  u.username = role;
  u.password = password;
  u.searchParams.set('options', `-c search_path=${schema}`);
  const p = new pg.Pool({ connectionString: u.toString(), max: 1 });
  pools.push(p);
  return p;
}

/** A fake IncomingMessage: headers + a JSON body it emits as one data chunk. */
function fakeReq(headers: Record<string, string>, jsonBody: unknown): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = headers;
  req.setEncoding = (() => req) as IncomingMessage['setEncoding'];
  queueMicrotask(() => {
    req.emit('data', JSON.stringify(jsonBody));
    req.emit('end');
  });
  return req;
}

/** A fake ServerResponse capturing the status + parsed JSON body. */
function fakeRes(): { res: ServerResponse; done: Promise<{ status: number; body: unknown }> } {
  let resolveDone!: (v: { status: number; body: unknown }) => void;
  const done = new Promise<{ status: number; body: unknown }>((r) => (resolveDone = r));
  let status = 200;
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end(payload?: string) {
      resolveDone({ status, body: payload ? JSON.parse(payload) : null });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

afterEach(async () => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
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

describe.skipIf(!PG_URL)('private ingest does not leak the file or its enrichment', () => {
  async function ownerCloud(schema: string): Promise<Lattice> {
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const o = new Lattice(schemaUrl(schema), { encryptionKey: 'ingest-privacy-key' });
    dbs.push(o);
    registerNativeEntities(o); // native `files`
    // A user entity the extractor reuses, and a files↔people junction.
    o.define(PEOPLE, {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: `${PEOPLE}.md`,
    });
    o.define(JUNCTION, {
      columns: {
        id: 'TEXT PRIMARY KEY',
        file_id: 'TEXT',
        [`${PEOPLE}_id`]: 'TEXT',
      },
      render: () => '',
      outputFile: `${JUNCTION}.md`,
    });
    o.define('_lattice_gui_audit', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        ts: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        table_name: 'TEXT NOT NULL',
        row_id: 'TEXT',
        operation: 'TEXT NOT NULL',
        before_json: 'TEXT',
        after_json: 'TEXT',
        undone: 'INTEGER NOT NULL DEFAULT 0',
        session_id: 'TEXT',
      },
      render: () => '',
      outputFile: '_audit.md',
    });
    await o.init();
    await secureCloud(o);
    return o;
  }

  it('forces the file + derived entity row + junction link private; control stays shared', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake';
    const tag = randomBytes(4).toString('hex');
    const schema = `ing_${tag}`;
    const member = `lm_ing_${tag}`;
    schemas.push(schema);
    roles.push(member);
    const o = await ownerCloud(schema);

    // The exact condition that surfaces the bug: both the files table AND the
    // junction default to SHARED ('everyone'). Without pre-sharing the junction,
    // a fresh junction row would default to private and the junction assertion
    // would pass vacuously.
    const ownerPool = new pg.Pool({ connectionString: schemaUrl(schema), max: 1 });
    pools.push(ownerPool);
    await ownerPool.query(`SELECT lattice_set_table_default_visibility('files', 'everyone')`);
    await ownerPool.query(`SELECT lattice_set_table_default_visibility('${JUNCTION}', 'everyone')`);
    await ownerPool.query(`SELECT lattice_set_table_default_visibility('${PEOPLE}', 'everyone')`);

    const fileJunctions: FileJunction[] = [
      { junction: JUNCTION, fileFk: 'file_id', otherTable: PEOPLE, otherFk: `${PEOPLE}_id` },
    ];
    const ingestCtx = {
      db: o,
      feed: new FeedBus(),
      softDeletable: new Set<string>(['files', PEOPLE]),
      fileJunctions,
      entityDescriptions: { [PEOPLE]: 'People' },
      // Object extraction is gated on a createEntity callback being present; our
      // extracted object REUSES the existing `people` entity, so this is never
      // actually invoked (returns null defensively).
      createEntity: () => Promise.resolve(null),
      // ≥ 0.4 runs object extraction; < 0.5 avoids new-entity creation (we reuse
      // an existing entity); < 0.66 keeps the fallback note off.
      aggressiveness: 0.45,
      method: 'POST',
    };

    // Private ingest (x-lattice-private: '1').
    const privReqHeaders = { 'content-type': 'application/json', 'x-lattice-private': '1' };
    const priv = fakeRes();
    await dispatchIngestRoute(
      fakeReq(privReqHeaders, { text: 'Private dossier about Dana Doe', title: 'secret-memo' }),
      priv.res,
      { ...ingestCtx, pathname: '/api/ingest/text' },
    );
    const privResult = (await priv.done).body as { id: string };
    const privFileId = privResult.id;
    expect(privFileId).toBeTruthy();

    // Control ingest (no private header) — must stay shared/visible.
    const ctrl = fakeRes();
    await dispatchIngestRoute(
      fakeReq(
        { 'content-type': 'application/json' },
        { text: 'Public note', title: 'public-memo' },
      ),
      ctrl.res,
      { ...ingestCtx, pathname: '/api/ingest/text' },
    );
    const ctrlFileId = (await ctrl.done).body as { id: string };

    // The private file's derived entity row + junction link (the rows that must
    // ALSO be private). Resolved via the OWNER connection, which sees everything.
    const privLink = (
      await ownerPool.query(`SELECT id, "${PEOPLE}_id" FROM "${JUNCTION}" WHERE file_id = $1`, [
        privFileId,
      ])
    ).rows[0] as { id: string; [k: string]: string } | undefined;
    expect(privLink).toBeTruthy();
    const junctionRowId = privLink!.id;
    const derivedPersonId = privLink![`${PEOPLE}_id`];
    expect(derivedPersonId).toBeTruthy();

    // Provision a member and open a member-scoped pool.
    const memberPw = generateMemberPassword();
    await provisionMemberRole(o, member, memberPw);
    const M = memberPool(schema, member, memberPw);

    // The member must NOT see the private file …
    const memberFiles = (await M.query('SELECT id FROM files')).rows.map((r) => r.id as string);
    expect(memberFiles).toContain(ctrlFileId.id); // control stays shared
    expect(memberFiles).not.toContain(privFileId);

    // … NOR the derived entity row …
    const memberPeople = (await M.query(`SELECT id FROM "${PEOPLE}"`)).rows.map(
      (r) => r.id as string,
    );
    expect(memberPeople).not.toContain(derivedPersonId);

    // … NOR the junction link row.
    const memberJunctionIds = (await M.query(`SELECT id FROM "${JUNCTION}"`)).rows.map(
      (r) => r.id as string,
    );
    expect(memberJunctionIds).not.toContain(junctionRowId);

    // The owner sees both files, the derived person, and the private junction.
    expect((await ownerPool.query('SELECT count(*)::int n FROM files')).rows[0].n).toBe(2);
    expect(
      (
        await ownerPool.query(`SELECT count(*)::int n FROM "${JUNCTION}" WHERE file_id = $1`, [
          privFileId,
        ])
      ).rows[0].n,
    ).toBe(1);
  });
});
