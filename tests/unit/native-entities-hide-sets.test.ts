import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import {
  NATIVE_ENTITY_NAMES,
  NATIVE_NAV_HIDDEN_NAMES,
  NATIVE_LEGACY_NAMES,
  isNavHiddenNativeEntity,
  isLegacyNativeEntity,
  isNativeEntity,
  isInternalNativeEntity,
  isAnalyticsNativeEntity,
  registerNativeEntities,
} from '../../src/framework/native-entities.js';

/**
 * The two display-only hide sets that sit alongside the internal (chat) and
 * analytics (dashboards) sets.
 *
 *  - NAV-HIDDEN (`files`) is a SOFT hide: the table leaves the left-hand table
 *    nav — it has its own sidebar section — but stays in the entities payload so
 *    the Data Model panel and the brain graph can still show file → data lineage.
 *  - LEGACY (`notes`) is a HARD drop: gone from the entities payload entirely.
 *
 * Both are display-surface decisions ONLY. Neither may unregister a table,
 * change its queryability, or turn it into an internal / analytics native (those
 * sets carry never-share + feed-hidden semantics these must not inherit).
 */
describe('native-entity hide sets: nav-hidden (files) and legacy (notes)', () => {
  let tmpDir: string;
  let db: Lattice;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-hide-sets-'));
    db = new Lattice(join(tmpDir, 'test.db'), { encryptionKey: 'hide-set-test-key' });
    registerNativeEntities(db);
    await db.init();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('nav-hides exactly `files` and nothing else', () => {
    expect([...NATIVE_NAV_HIDDEN_NAMES]).toEqual(['files']);
    expect(isNavHiddenNativeEntity('files')).toBe(true);
    for (const t of ['notes', 'secrets', 'dashboards', 'chat_threads', 'projects']) {
      expect(isNavHiddenNativeEntity(t)).toBe(false);
    }
  });

  it('marks exactly `notes` legacy and nothing else', () => {
    expect([...NATIVE_LEGACY_NAMES]).toEqual(['notes']);
    expect(isLegacyNativeEntity('notes')).toBe(true);
    for (const t of ['files', 'secrets', 'dashboards', 'chat_threads', 'projects']) {
      expect(isLegacyNativeEntity(t)).toBe(false);
    }
  });

  it('leaves both tables REGISTERED and fully queryable', async () => {
    // Hiding is a display decision — the physical tables, the valid-table list,
    // the row routes and soft-delete all keep working exactly as before.
    const registered = db.getRegisteredTableNames();
    expect(registered).toContain('files');
    expect(registered).toContain('notes');
    expect(NATIVE_ENTITY_NAMES.has('files')).toBe(true);
    expect(NATIVE_ENTITY_NAMES.has('notes')).toBe(true);
    expect(isNativeEntity('files')).toBe(true);
    expect(isNativeEntity('notes')).toBe(true);

    const fileId = await db.insert('files', {
      original_name: 'contract.pdf',
      ref_kind: 'local_ref',
      ref_uri: '/tmp/contract.pdf',
      ref_provider: 'fs',
    });
    // The files back-reference from a note must keep resolving.
    const noteId = await db.insert('notes', {
      title: 'Contract summary',
      body: 'Two-year term.',
      source_file_id: fileId,
    });
    expect((await db.get('files', fileId))!.original_name).toBe('contract.pdf');
    const note = await db.get('notes', noteId);
    expect(note!.source_file_id).toBe(fileId);
    expect(await db.count('notes')).toBe(1);
  });

  it('does NOT reclassify either table as an internal or analytics native', () => {
    // Internal natives are forced never-share + feed-hidden, and analytics
    // natives are excluded from workspace search. Neither semantic belongs to a
    // display-only hide, so both tables must stay outside those two sets.
    for (const t of ['files', 'notes']) {
      expect(isInternalNativeEntity(t)).toBe(false);
      expect(isAnalyticsNativeEntity(t)).toBe(false);
    }
  });

  it('keeps the two hide sets disjoint (a table is soft-hidden OR hard-dropped, never both)', () => {
    for (const name of NATIVE_NAV_HIDDEN_NAMES) {
      expect(NATIVE_LEGACY_NAMES.has(name)).toBe(false);
    }
  });
});
