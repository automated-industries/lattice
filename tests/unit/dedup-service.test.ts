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
