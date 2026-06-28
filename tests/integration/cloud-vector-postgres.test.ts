/**
 * Cloud vector-search visibility: a scoped cloud member runs semantic + hybrid
 * search and the DATABASE confines it to the rows it may see — never another
 * member's private rows — even though the member has no grant on the internal
 * embeddings store or the native index. The vector arm reaches the store ONLY
 * through the `lattice_visible_embeddings` SECURITY DEFINER function, which filters
 * by `lattice_row_visible` keyed on the member's own role.
 *
 * The member path is a visibility-filtered in-process scan (no pgvector), so this
 * runs on the local embedded-postgres cluster too — it needs scoped roles + RLS,
 * not the vector extension. Postgres-gated only (skipped without LATTICE_TEST_PG_URL).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import type { EmbeddingsConfig } from '../../src/types.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const pools: pg.Pool[] = [];
const schemas: string[] = [];
const roles: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

/** Connection string for a member Lattice: its own scoped role embedded in the URL
 *  (an embedded user wins over a separate field, so we don't stay the superuser). */
function memberUrlFor(schema: string, role: string, password: string): string {
  const u = new URL(PG_URL!);
  u.username = role;
  u.password = password;
  u.searchParams.set('options', `-c search_path=${schema}`);
  return u.toString();
}

// Deterministic token embedder (no model dependency): an 8-d vector keyed off the
// tokens present, so rows sharing the query's tokens all score > 0 — leaving row
// visibility, not similarity, as the only thing that can filter a row out.
function tokenEmbed(dim = 8) {
  return (text: string): Promise<number[]> => {
    const v = new Array<number>(dim).fill(0);
    for (const tok of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      let h = 0;
      for (const ch of tok) h = (h + ch.charCodeAt(0)) % dim;
      v[h] = (v[h] ?? 0) + 1;
    }
    return Promise.resolve(v);
  };
}

function embConfig(): EmbeddingsConfig {
  return { fields: ['body'], embed: tokenEmbed(8), modelId: 'test-v1' };
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

describe.skipIf(!PG_URL)('cloud vector search — per-member row visibility', () => {
  it('a member semantic/hybrid-searches only the rows it may see', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `vec_${tag}`;
    const bob = `vec_b_${tag}`;
    schemas.push(schema);
    roles.push(bob);

    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = schemaUrl(schema);

    // Owner builds a cloud table WITH embeddings, inserts three rows that all share
    // the query's tokens, and materializes their vectors — then secures the cloud
    // (RLS + ownership backfill: every row becomes the owner's, private by default).
    const owner = new Lattice(url);
    owner.define('docs', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      embeddings: embConfig(),
      render: () => '',
      outputFile: 'docs.md',
    });
    await owner.init();
    await owner.upsert('docs', { id: 'd1', body: 'budget finance alpha private' });
    await owner.upsert('docs', { id: 'd2', body: 'budget finance beta shared' });
    await owner.upsert('docs', { id: 'd3', body: 'budget finance gamma granted' });
    await owner.refreshEmbeddings('docs');
    await secureCloud(owner);
    const bobPw = generateMemberPassword();
    await provisionMemberRole(owner, bob, bobPw);
    owner.close();

    // Owner shares d2 with everyone and grants d3 to bob specifically; d1 stays private.
    const ownerPool = new pg.Pool({ connectionString: url, max: 1 });
    pools.push(ownerPool);
    await ownerPool.query(`SELECT lattice_set_row_visibility('docs','d2','everyone')`);
    await ownerPool.query(`SELECT lattice_grant_row('docs','d3',$1)`, [bob]);

    // Member opens (auto introspect-only) and searches through Lattice.
    const member = new Lattice(memberUrlFor(schema, bob, bobPw));
    member.define('docs', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      embeddings: embConfig(),
      render: () => '',
      outputFile: 'docs.md',
    });
    await member.init();
    // The member path is what we're testing — confirm we're actually on it.
    expect(member.isCloudMemberOpen()).toBe(true);

    // Semantic search: every row matches by similarity, so the ONLY filter is
    // visibility — bob sees d2 (everyone) + d3 (granted), never d1 (private).
    const sem = await member.search('docs', 'budget finance', { topK: 10 });
    expect(sem.map((h) => String(h.row.id)).sort()).toEqual(['d2', 'd3']);
    // topK is correctly filled from the visible set (no phantom slot for d1).
    expect(sem.length).toBe(2);
    // The private row's body never leaks through a result.
    expect(sem.some((h) => String(h.row.id) === 'd1')).toBe(false);

    // Hybrid (vector + full-text) is filtered the same way.
    const hyb = await member.hybridSearch('docs', 'budget finance', { topK: 10 });
    expect(hyb.map((h) => String(h.row.id)).sort()).toEqual(['d2', 'd3']);
    member.close();

    // Negative control: the member reaches the store ONLY through the SECURITY
    // DEFINER function. A direct read of the internal embeddings table is denied
    // (no grant) — so the visibility filter cannot be bypassed.
    const bobRaw = new pg.Pool({ connectionString: memberUrlFor(schema, bob, bobPw), max: 1 });
    pools.push(bobRaw);
    await expect(bobRaw.query(`SELECT count(*) FROM "_lattice_embeddings"`)).rejects.toThrow(
      /permission denied/i,
    );

    // Control: the owner connection (no RLS confinement) sees all three rows, so
    // the data really is present — only the member is filtered, at the database.
    const ownerView = new Lattice(url);
    ownerView.define('docs', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      embeddings: embConfig(),
      render: () => '',
      outputFile: 'docs.md',
    });
    await ownerView.init();
    expect(ownerView.isCloudMemberOpen()).toBe(false);
    const ownerHits = await ownerView.search('docs', 'budget finance', { topK: 10 });
    expect(ownerHits.map((h) => String(h.row.id)).sort()).toEqual(['d1', 'd2', 'd3']);
    ownerView.close();
  });
});
