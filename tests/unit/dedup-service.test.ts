import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import {
  aggressivenessToThreshold,
  findTableDuplicates,
  findExactFileDupesOf,
  mergeDuplicates,
  DEDUP_MAX_SCAN_ROWS,
  type DedupServiceCtx,
} from '../../src/gui/dedup-service.js';
import { DEFAULT_NEAR_THRESHOLD } from '../../src/dedup/match.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';

describe('aggressivenessToThreshold', () => {
  it('maps aggressiveness 0 → near-exact and 1 → the 0.82 floor', () => {
    expect(aggressivenessToThreshold(0)).toBeCloseTo(0.98, 5);
    expect(aggressivenessToThreshold(1)).toBeCloseTo(DEFAULT_NEAR_THRESHOLD, 5); // 0.82
  });
  it('is monotonic and clamps out-of-range input', () => {
    expect(aggressivenessToThreshold(0.5)).toBeGreaterThan(aggressivenessToThreshold(1));
    expect(aggressivenessToThreshold(0.5)).toBeLessThan(aggressivenessToThreshold(0));
    expect(aggressivenessToThreshold(-5)).toBeCloseTo(0.98, 5);
    expect(aggressivenessToThreshold(99)).toBeCloseTo(DEFAULT_NEAR_THRESHOLD, 5);
  });
});

describe('dedup service (real config, SQLite)', () => {
  let root: string;
  let db: Lattice;
  let feed: FeedBus;
  let ctx: DedupServiceCtx;
  let configPath: string;
  let outputDir: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lattice-dedup-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    configPath = join(root, 'lattice.config.yml');
    outputDir = join(root, 'context');
    writeFileSync(
      configPath,
      [
        'db: ./data/test.db',
        '',
        'entities:',
        '  things:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '      created_at: { type: timestamp }',
        '      deleted_at: { type: timestamp }',
        '    outputFile: things.md',
        '  tags:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '    outputFile: tags.md',
        '  thing_tags:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      thing_id: { type: uuid }',
        '      tag_id: { type: uuid }',
        '    relations:',
        '      thing: { type: belongsTo, table: things, foreignKey: thing_id }',
        '      tag: { type: belongsTo, table: tags, foreignKey: tag_id }',
        '    outputFile: thing-tags.md',
        '',
      ].join('\n'),
    );
    db = new Lattice({ config: configPath }, { encryptionKey: 'dedup-test-key' });
    // The native `files` entity (sha256 + extracted_text) for content-group tests.
    registerNativeEntities(db);
    // The audit chokepoint the mutation primitives write through.
    db.define('_lattice_gui_audit', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        ts: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        table_name: 'TEXT NOT NULL',
        row_id: 'TEXT',
        operation: 'TEXT NOT NULL',
        before_json: 'TEXT',
        after_json: 'TEXT',
        undone: 'INTEGER NOT NULL DEFAULT 0',
      },
      render: () => '',
      outputFile: '.lattice-gui/audit.md',
    });
    await db.init();
    feed = new FeedBus();
    ctx = { db, feed, softDeletable: new Set(['things', 'files']), configPath, outputDir };
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('findTableDuplicates groups a generic table by its key columns', async () => {
    await db.insert('things', { id: 't1', name: 'Acme', created_at: '2026-01-01T00:00:00Z' });
    await db.insert('things', { id: 't2', name: 'Acme', created_at: '2026-01-02T00:00:00Z' });
    await db.insert('things', { id: 't3', name: 'Other', created_at: '2026-01-03T00:00:00Z' });
    const groups = await findTableDuplicates(ctx, 'things', {});
    expect(groups).toHaveLength(1);
    // Oldest first → t1 is the survivor the caller keeps.
    expect(groups[0]?.ids[0]).toBe('t1');
    expect(groups[0]?.ids).toContain('t2');
    expect(groups[0]?.ids).not.toContain('t3');
  });

  it('under-cap result is byte-identical: the count guard + in-SQL deleted_at filter do not change the groups', async () => {
    // A tiny set well under DEDUP_MAX_SCAN_ROWS — the cap never trips and the
    // in-SQL `deleted_at IS NULL` read returns exactly what the prior JS
    // `.filter(!deleted_at)` did. The groups must be EXACTLY as before.
    await db.insert('things', { id: 't1', name: 'Acme', created_at: '2026-01-01T00:00:00Z' });
    await db.insert('things', { id: 't2', name: 'Acme', created_at: '2026-01-02T00:00:00Z' });
    await db.insert('things', { id: 't3', name: 'Acme', created_at: '2026-01-03T00:00:00Z' });
    await db.insert('things', { id: 't4', name: 'Other', created_at: '2026-01-04T00:00:00Z' });
    const groups = await findTableDuplicates(ctx, 'things', {});
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g?.ids[0]).toBe('t1'); // oldest survivor
    expect([...(g?.ids ?? [])].sort()).toEqual(['t1', 't2', 't3']);
    expect(g?.ids).not.toContain('t4');
  });

  it('over-cap LOUD refusal: throws and NEVER runs the unbounded read when active count exceeds the cap', async () => {
    // Stubbing `count` to report a count over the cap exercises the refusal
    // mechanism without inserting 50k rows. `query` is spied to PROVE the
    // unbounded full-table read never happens once the guard fires.
    await db.insert('things', { id: 't1', name: 'Acme' });
    const realCount = db.count.bind(db);
    const realQuery = db.query.bind(db);
    let countCalls = 0;
    let queryCalls = 0;
    db.count = (..._a: Parameters<typeof realCount>): Promise<number> => {
      countCalls++;
      return Promise.resolve(DEDUP_MAX_SCAN_ROWS + 1);
    };
    db.query = (...a: Parameters<typeof realQuery>): ReturnType<typeof realQuery> => {
      queryCalls++;
      return realQuery(...a);
    };
    try {
      await expect(findTableDuplicates(ctx, 'things', {})).rejects.toThrow(/exceeds|cap|dedup/i);
      // The COUNT gate ran; the unbounded read did not.
      expect(countCalls).toBeGreaterThan(0);
      expect(queryCalls).toBe(0);
    } finally {
      db.count = realCount;
      db.query = realQuery;
    }
  });

  it('excludes soft-deleted rows via the in-SQL filter (a soft-deleted dup is not grouped)', async () => {
    await db.insert('things', { id: 't1', name: 'Acme', created_at: '2026-01-01T00:00:00Z' });
    await db.insert('things', { id: 't2', name: 'Acme', created_at: '2026-01-02T00:00:00Z' });
    // Soft-delete the second member of what would otherwise be a dup pair.
    await db.update('things', 't2', { deleted_at: '2026-01-03T00:00:00Z' });
    const groups = await findTableDuplicates(ctx, 'things', {});
    // Only one live 'Acme' remains → no duplicate group.
    expect(groups).toHaveLength(0);
  });

  it('mergeDuplicates relinks junctions onto the survivor and soft-deletes the dup', async () => {
    await db.insert('things', { id: 't1', name: 'Acme', created_at: '2026-01-01T00:00:00Z' });
    await db.insert('things', { id: 't2', name: 'Acme', created_at: '2026-01-02T00:00:00Z' });
    await db.insert('tags', { id: 'g1', name: 'red' });
    // The DUP (t2) is linked to the tag; the survivor (t1) is not yet.
    await db.insert('thing_tags', { id: 'l1', thing_id: 't2', tag_id: 'g1' });

    const events: FeedEvent[] = [];
    feed.subscribe((e) => events.push(e));

    const res = await mergeDuplicates(ctx, 'things', 't1', ['t2']);
    expect(res.merged).toBe(1);
    expect(res.relinked).toBe(1);

    // The dup is soft-deleted (recoverable), the survivor remains.
    const dup = (await db.get('things', 't2')) as { deleted_at?: string | null } | null;
    expect(dup?.deleted_at).toBeTruthy();
    expect(await db.get('things', 't1')).not.toBeNull();

    // The link now points at the survivor (t1), not the dup (t2).
    const links = (await db.query('thing_tags', {})) as {
      thing_id: string;
      deleted_at?: string | null;
    }[];
    const live = links.filter((l) => !l.deleted_at);
    expect(live.some((l) => l.thing_id === 't1')).toBe(true);
    expect(live.some((l) => l.thing_id === 't2')).toBe(false);

    // Every merge mutation is attributed to the system ("Lattice").
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.source === 'system')).toBe(true);
  });

  it('mergeDuplicates is a no-op when there are no sources distinct from the survivor', async () => {
    await db.insert('things', { id: 't1', name: 'Solo' });
    const res = await mergeDuplicates(ctx, 'things', 't1', ['t1']);
    expect(res).toEqual({ merged: 0, relinked: 0 });
  });

  it('links survivor BEFORE removing any source edge (no half-merge on mid-merge failure)', async () => {
    // Survivor (t1) + two dups (t2, t3), each linked to a DISTINCT tag.
    await db.insert('things', { id: 't1', name: 'Acme', created_at: '2026-01-01T00:00:00Z' });
    await db.insert('things', { id: 't2', name: 'Acme', created_at: '2026-01-02T00:00:00Z' });
    await db.insert('things', { id: 't3', name: 'Acme', created_at: '2026-01-03T00:00:00Z' });
    await db.insert('tags', { id: 'g1', name: 'red' });
    await db.insert('tags', { id: 'g2', name: 'blue' });
    await db.insert('thing_tags', { id: 'l2', thing_id: 't2', tag_id: 'g1' });
    await db.insert('thing_tags', { id: 'l3', thing_id: 't3', tag_id: 'g2' });

    // Inject a fault that fires AFTER phase 1 (link-all) has completed — the next
    // mutation that touches the junction throws. We stub `unlink` (phase 2's tool)
    // so phase 1's links all land, then the very first unlink blows up.
    const realUnlink = db.unlink.bind(db);
    let unlinkCalls = 0;
    db.unlink = (..._args: Parameters<typeof realUnlink>): Promise<void> => {
      unlinkCalls++;
      return Promise.reject(new Error('injected unlink fault'));
    };

    await expect(mergeDuplicates(ctx, 'things', 't1', ['t2', 't3'])).rejects.toThrow(
      /mergeDuplicates failed mid-merge/,
    );
    // The fault hit during phase 2 (unlink), not phase 1.
    expect(unlinkCalls).toBe(1);

    db.unlink = realUnlink;

    const links = (await db.query('thing_tags', {})) as {
      thing_id: string;
      tag_id: string;
      deleted_at?: string | null;
    }[];
    const live = links.filter((l) => !l.deleted_at);
    const edge = (thing: string, tag: string): boolean =>
      live.some((l) => l.thing_id === thing && l.tag_id === tag);

    // PHASE 1 already wrote BOTH survivor edges before anything was removed.
    expect(edge('t1', 'g1')).toBe(true);
    expect(edge('t1', 'g2')).toBe(true);
    // No source edge was orphaned/half-removed — the originals are still present.
    // The state is an over-linked SUPERSET (consistent + re-runnable), never a
    // half-merge where a source edge is gone but the survivor's copy never landed.
    expect(edge('t2', 'g1')).toBe(true);
    expect(edge('t3', 'g2')).toBe(true);
    // The sources have NOT been soft-deleted yet (delete is the last phase).
    const t2 = (await db.get('things', 't2')) as { deleted_at?: string | null } | null;
    const t3 = (await db.get('things', 't3')) as { deleted_at?: string | null } | null;
    expect(t2?.deleted_at).toBeFalsy();
    expect(t3?.deleted_at).toBeFalsy();
  });

  it('re-running after a simulated partial completes idempotently to the same end state as an uninterrupted merge', async () => {
    // Scope the snapshot to ONE group's id-prefix so the reference run and the
    // interrupted run (both live in the same shared table) are measured in
    // isolation. The normalizer below maps the prefix away to compare the two.
    async function endState(prefix: string): Promise<{
      liveEdges: string[];
      deletedSources: string[];
    }> {
      const links = (await db.query('thing_tags', {})) as {
        thing_id: string;
        tag_id: string;
        deleted_at?: string | null;
      }[];
      const liveEdges = links
        .filter((l) => !l.deleted_at && l.thing_id.startsWith(prefix))
        .map((l) => `${l.thing_id}:${l.tag_id}`)
        .sort();
      const things = (await db.query('things', {})) as {
        id: string;
        deleted_at?: string | null;
      }[];
      const deletedSources = things
        .filter((t) => t.deleted_at && t.id.startsWith(prefix))
        .map((t) => t.id)
        .sort();
      return { liveEdges, deletedSources };
    }

    // --- Reference run: one clean, uninterrupted merge in a fresh group. ---
    await db.insert('things', { id: 'r1', name: 'Ref', created_at: '2026-01-01T00:00:00Z' });
    await db.insert('things', { id: 'r2', name: 'Ref', created_at: '2026-01-02T00:00:00Z' });
    await db.insert('things', { id: 'r3', name: 'Ref', created_at: '2026-01-03T00:00:00Z' });
    await db.insert('tags', { id: 'rg1', name: 'redref' });
    await db.insert('tags', { id: 'rg2', name: 'blueref' });
    await db.insert('thing_tags', { id: 'rl2', thing_id: 'r2', tag_id: 'rg1' });
    await db.insert('thing_tags', { id: 'rl3', thing_id: 'r3', tag_id: 'rg2' });
    await mergeDuplicates(ctx, 'things', 'r1', ['r2', 'r3']);
    const clean = await endState('r');

    // --- Interrupted run: identical shape, but phase 2 throws partway. ---
    await db.insert('things', { id: 's1', name: 'Sim', created_at: '2026-01-01T00:00:00Z' });
    await db.insert('things', { id: 's2', name: 'Sim', created_at: '2026-01-02T00:00:00Z' });
    await db.insert('things', { id: 's3', name: 'Sim', created_at: '2026-01-03T00:00:00Z' });
    await db.insert('tags', { id: 'sg1', name: 'redsim' });
    await db.insert('tags', { id: 'sg2', name: 'bluesim' });
    await db.insert('thing_tags', { id: 'sl2', thing_id: 's2', tag_id: 'sg1' });
    await db.insert('thing_tags', { id: 'sl3', thing_id: 's3', tag_id: 'sg2' });

    const realUnlink = db.unlink.bind(db);
    db.unlink = (): Promise<void> => Promise.reject(new Error('injected unlink fault'));
    await expect(mergeDuplicates(ctx, 'things', 's1', ['s2', 's3'])).rejects.toThrow(
      /mergeDuplicates failed mid-merge/,
    );
    db.unlink = realUnlink;

    // Re-run to completion — must finish idempotently.
    const res = await mergeDuplicates(ctx, 'things', 's1', ['s2', 's3']);
    expect(res.merged).toBe(2);

    const recovered = await endState('s');
    // Map each group's id-prefix away so the two end states are directly
    // comparable. Compare the live edges as a SET of logical (survivor,target)
    // pairs: the `thing_tags` junction has no UNIQUE(thing_id, tag_id) constraint,
    // so a phase-1 re-link of an edge already present can leave a second physical
    // row for the SAME logical edge — harmless (it points at the survivor), and
    // the survivor still carries every edge exactly as a clean merge does.
    const norm = (s: { liveEdges: string[]; deletedSources: string[] }) => ({
      liveEdges: [
        ...new Set(s.liveEdges.map((e) => e.replace(/^[rs]/, 'X').replace(/:[rs]g/, ':Xg'))),
      ].sort(),
      deletedSources: [...new Set(s.deletedSources.map((d) => d.replace(/^[rs]/, 'X')))].sort(),
    });
    expect(norm(recovered)).toEqual(norm(clean));
    // And the survivor carries BOTH targets, with both sources soft-deleted —
    // the same logical end state an uninterrupted merge produces.
    expect(norm(recovered).liveEdges).toEqual(['X1:Xg1', 'X1:Xg2']);
    expect(norm(recovered).deletedSources).toEqual(['X2', 'X3']);
  });

  describe('files content groups', () => {
    async function addFile(
      id: string,
      sha: string,
      text: string,
      createdAt: string,
    ): Promise<void> {
      await db.insert('files', {
        id,
        original_name: id + '.txt',
        mime: 'text/plain',
        sha256: sha,
        extracted_text: text,
        extraction_status: 'extracted',
        created_at: createdAt,
      });
    }

    it('findExactFileDupesOf returns byte-identical others oldest-first', async () => {
      await addFile('f1', 'AAA', 'hello', '2026-01-01T00:00:00Z');
      await addFile('f2', 'AAA', 'hello', '2026-01-02T00:00:00Z');
      await addFile('f3', 'BBB', 'world', '2026-01-03T00:00:00Z');
      const dupes = await findExactFileDupesOf(ctx, { id: 'f2', sha256: 'AAA' });
      expect(dupes).toEqual(['f1']);
      // No sha → no work (bounded query never runs).
      expect(await findExactFileDupesOf(ctx, { id: 'f9' })).toEqual([]);
    });

    it('groups files by sha256, then by identical extracted text', async () => {
      await addFile('f1', 'AAA', 'same bytes', '2026-01-01T00:00:00Z');
      await addFile('f2', 'AAA', 'same bytes', '2026-01-02T00:00:00Z');
      // Different bytes but identical extracted text → text group.
      await addFile('f3', 'CCC', 'identical text body', '2026-01-03T00:00:00Z');
      await addFile('f4', 'DDD', 'identical text body', '2026-01-04T00:00:00Z');
      const groups = await findTableDuplicates(ctx, 'files', {});
      // One sha group (f1,f2) + one text group (f3,f4); disjoint.
      expect(groups).toHaveLength(2);
      const flat = groups.map((g) => g.ids.slice().sort());
      expect(flat).toContainEqual(['f1', 'f2']);
      expect(flat).toContainEqual(['f3', 'f4']);
    });

    it('fuzzy mode at high aggressiveness merges near-identical extracted text', async () => {
      const base = 'The quarterly revenue report shows strong growth across all regions.';
      await addFile(
        'f1',
        createHash('sha256').update('a').digest('hex'),
        base,
        '2026-01-01T00:00:00Z',
      );
      await addFile(
        'f2',
        createHash('sha256').update('b').digest('hex'),
        base + ' Minor addendum at the end.',
        '2026-01-02T00:00:00Z',
      );
      const exact = await findTableDuplicates(ctx, 'files', { fuzzy: false });
      expect(exact).toHaveLength(0); // distinct bytes + distinct text
      const fuzzy = await findTableDuplicates(ctx, 'files', {
        fuzzy: true,
        threshold: aggressivenessToThreshold(1),
      });
      expect(fuzzy.length).toBeGreaterThanOrEqual(1);
    });
  });
});
