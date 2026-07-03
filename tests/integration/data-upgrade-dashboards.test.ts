/**
 * 5.0 open-time data upgrade: legacy assistant-authored HTML artifacts (`files`
 * rows with artifact_type='html') move into the native `dashboards` table —
 * same id, title from the display name minus its extension, page body from
 * extracted_text — and the source files rows are HARD-deleted in the same
 * migration pass. Markdown artifacts stay where they are. Sentinel-gated via
 * `internal:upgrade:html-artifacts-to-dashboards:v1`; skipped without a
 * sentinel while the dashboards table doesn't exist yet (retries next open).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { upgradeLegacyData } from '../../src/framework/data-upgrade.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { runAsyncOrSync, allAsyncOrSync } from '../../src/db/adapter.js';

const dirs: string[] = [];
const dbs: Lattice[] = [];

function freshDb(): { db: Lattice; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-dashmigrate-'));
  dirs.push(dir);
  const db = new Lattice(join(dir, 'app.db'), { encryptionKey: 'dash-migrate-test-key' });
  dbs.push(db);
  return { db, dir };
}

afterEach(() => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function seedArtifacts(db: Lattice): Promise<void> {
  // Raw SQL inserts to reproduce the pre-5.0 on-disk shape exactly.
  await runAsyncOrSync(
    db.adapter,
    `INSERT INTO files (id, original_name, mime, extracted_text, extraction_status, artifact_type, description)
     VALUES ('h1', 'Revenue Overview.html', 'text/html', '<!doctype html><html><body>rev</body></html>', 'extracted', 'html', 'quarterly'),
            ('h2', 'metrics.HTM', 'text/html', '<!doctype html><html><body>m</body></html>', 'extracted', 'html', NULL),
            ('m1', 'Notes.md', 'text/markdown', '# hello', 'extracted', 'markdown', NULL),
            ('f1', 'plain.pdf', 'application/pdf', NULL, 'pending', NULL, NULL)`,
  );
}

describe('html artifacts → dashboards migration', () => {
  it('moves html artifacts to dashboards (same id, derived title) and hard-deletes the sources', async () => {
    const { db } = freshDb();
    registerNativeEntities(db);
    await db.init();
    await seedArtifacts(db);

    await upgradeLegacyData(db);

    const dashboards = (await db.query('dashboards')) as Record<string, unknown>[];
    expect(dashboards.map((d) => d.id).sort()).toEqual(['h1', 'h2']);
    const h1 = dashboards.find((d) => d.id === 'h1');
    expect(h1?.title).toBe('Revenue Overview');
    expect(String(h1?.html)).toContain('rev');
    expect(h1?.description).toBe('quarterly');
    const h2 = dashboards.find((d) => d.id === 'h2');
    expect(h2?.title).toBe('metrics'); // .HTM stripped case-insensitively

    // Sources are HARD-deleted (not soft): gone even from a deleted-inclusive read.
    const remaining = (await allAsyncOrSync(db.adapter, 'SELECT id, artifact_type FROM files')) as {
      id: string;
      artifact_type: string | null;
    }[];
    expect(remaining.map((r) => r.id).sort()).toEqual(['f1', 'm1']);
    // Markdown artifact + ordinary file are untouched.
    expect(remaining.find((r) => r.id === 'm1')?.artifact_type).toBe('markdown');

    // Sentinel stamped (both SQLite step entries).
    const applied = (await allAsyncOrSync(
      db.adapter,
      `SELECT version FROM __lattice_migrations WHERE version LIKE 'internal:upgrade:html-artifacts-to-dashboards%'`,
    )) as { version: string }[];
    expect(applied.length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent — a re-run neither duplicates dashboards nor errors', async () => {
    const { db } = freshDb();
    registerNativeEntities(db);
    await db.init();
    await seedArtifacts(db);

    await upgradeLegacyData(db);
    await upgradeLegacyData(db);

    const dashboards = (await db.query('dashboards')) as Record<string, unknown>[];
    expect(dashboards).toHaveLength(2);
  });

  it('copies BEFORE deleting — the migration runner must order the two steps', async () => {
    // The batch runner re-sorts migrations by version string; if the delete
    // ever sorted ahead of the copy, every html artifact would be destroyed
    // inside a committed transaction. Pin the numeric step prefixes that
    // guarantee the order.
    const { db } = freshDb();
    registerNativeEntities(db);
    await db.init();
    await seedArtifacts(db);
    await upgradeLegacyData(db);

    const applied = (await allAsyncOrSync(
      db.adapter,
      `SELECT version FROM __lattice_migrations WHERE version LIKE 'internal:upgrade:html-artifacts-to-dashboards%' ORDER BY version`,
    )) as { version: string }[];
    const versions = applied.map((a) => a.version);
    expect(versions).toEqual([
      'internal:upgrade:html-artifacts-to-dashboards:v1:1-copy',
      'internal:upgrade:html-artifacts-to-dashboards:v1:2-delete',
    ]);
    // localeCompare(numeric) — the exact comparator the runner uses — must
    // order copy before delete.
    expect('1-copy'.localeCompare('2-delete', undefined, { numeric: true })).toBeLessThan(0);
    // And the data proves it: content survived into dashboards.
    expect(((await db.query('dashboards')) as unknown[]).length).toBe(2);
  });

  it('skips without stamping when the dashboards table does not exist yet', async () => {
    const { db } = freshDb();
    // Register ONLY a legacy-style files table (no dashboards) — simulates an
    // open path that hasn't applied the 5.0 native schema yet.
    db.define('files', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        original_name: 'TEXT',
        mime: 'TEXT',
        extracted_text: 'TEXT',
        extraction_status: 'TEXT',
        artifact_type: 'TEXT',
        description: 'TEXT',
        created_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
        updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: 'files.md',
    });
    await db.init();
    await seedArtifacts(db);

    await upgradeLegacyData(db);

    // Nothing migrated, nothing stamped — the step retries on a later open.
    const applied = (await allAsyncOrSync(
      db.adapter,
      `SELECT version FROM __lattice_migrations WHERE version LIKE 'internal:upgrade:html-artifacts-to-dashboards%'`,
    )) as { version: string }[];
    expect(applied).toHaveLength(0);
    const files = (await allAsyncOrSync(db.adapter, 'SELECT id FROM files')) as { id: string }[];
    expect(files).toHaveLength(4);
  });

  it('titles a nameless html artifact "Dashboard"', async () => {
    const { db } = freshDb();
    registerNativeEntities(db);
    await db.init();
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO files (id, mime, extracted_text, artifact_type)
       VALUES ('h3', 'text/html', '<html></html>', 'html')`,
    );
    await upgradeLegacyData(db);
    const dashboards = (await db.query('dashboards')) as Record<string, unknown>[];
    expect(dashboards.find((d) => d.id === 'h3')?.title).toBe('Dashboard');
  });
});
