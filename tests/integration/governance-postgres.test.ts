/**
 * Postgres dialect-parity for p4a governance: provenance columns + immutability
 * and the trust verification workflow on a real Postgres cluster.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';
import { ProvenanceImmutableError } from '../../src/schema/governance.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('p4a governance (Postgres)', () => {
  let db: Lattice;
  const runId = randomBytes(4).toString('hex');
  const docs = `__lattice_test_${runId}_docs`;
  const items = `__lattice_test_${runId}_items`;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    db.define(docs, {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      provenance: true,
      render: () => '',
      outputFile: '/dev/null',
    });
    db.define(items, {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      trust: true,
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
  });

  afterAll(async () => {
    for (const t of [docs, items]) {
      try {
        await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${t}" CASCADE`);
      } catch {
        /* best effort */
      }
    }
    db.close();
  });

  it('stamps provenance and freezes it on Postgres', async () => {
    await db.insert(docs, {
      id: 'd1',
      body: 'x',
      ingested_via: 'crawler',
      source_uri: 'https://e.com',
    });
    const row = await db.get(docs, 'd1');
    expect(row!.ingested_via).toBe('crawler');
    expect(typeof row!.ingested_at).toBe('string');
    await expect(db.update(docs, 'd1', { source_uri: 'changed' })).rejects.toBeInstanceOf(
      ProvenanceImmutableError,
    );
  });

  it('runs the trust workflow on Postgres', async () => {
    await db.insert(items, { id: 'i1', name: 'a' });
    expect((await db.get(items, 'i1'))!._trust_state).toBe('unverified');
    await db.markRowForReview(items, 'i1', 'check');
    expect((await db.rowsNeedingReview(items)).map((r) => r.id)).toEqual(['i1']);
    await db.verifyRow(items, 'i1', 'alice');
    const row = await db.get(items, 'i1');
    expect(row!._trust_state).toBe('verified');
    expect(row!._verified_by).toBe('alice');
    expect((await db.verifiedRows(items)).map((r) => r.id)).toEqual(['i1']);
  });
});
