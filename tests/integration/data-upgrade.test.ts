/**
 * Silent on-open DATA upgrades (src/framework/data-upgrade.ts): a 3.x DB's existing
 * rows are migrated forward to the 4.0 shape so they keep behaving correctly —
 * (1) legacy `deleted_at = ''` normalized to NULL (else a live row reads as deleted
 * and a natural-key upsert could duplicate it), and (2) a legacy `files.path`-only
 * row backfilled into the reference model (`ref_kind='local_ref'`, `ref_uri=path`)
 * so its bytes stay resolvable. Both gated once-per-DB via `internal:upgrade:*`
 * sentinels in `__lattice_migrations`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { upgradeLegacyData } from '../../src/framework/data-upgrade.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { runAsyncOrSync, getAsyncOrSync, allAsyncOrSync } from '../../src/db/adapter.js';

const dirs: string[] = [];
const dbs: Lattice[] = [];

function freshDb(): { db: Lattice; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-dataupgrade-'));
  dirs.push(dir);
  // Native files/secrets carry encrypted columns, so a key is required at init.
  const db = new Lattice(join(dir, 'app.db'), { encryptionKey: 'data-upgrade-test-key' });
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

describe('silent data upgrade on open', () => {
  it("normalizes legacy deleted_at='' to NULL across every table that has the column", async () => {
    const { db } = freshDb();
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'tasks.md',
    });
    await db.init();

    // Insert legacy rows with the empty-string sentinel (the normal API writes NULL,
    // so go through raw SQL to reproduce the 3.x on-disk shape).
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "notes" (id, body, deleted_at) VALUES ('n1','a','')`,
    );
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "tasks" (id, title, deleted_at) VALUES ('t1','x','')`,
    );
    // A genuinely-deleted row (real timestamp) must be left alone.
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "notes" (id, body, deleted_at) VALUES ('n2','b','2026-01-01T00:00:00Z')`,
    );

    await upgradeLegacyData(db);

    const n1 = (await getAsyncOrSync(
      db.adapter,
      `SELECT deleted_at FROM "notes" WHERE id='n1'`,
    )) as {
      deleted_at: string | null;
    };
    const t1 = (await getAsyncOrSync(
      db.adapter,
      `SELECT deleted_at FROM "tasks" WHERE id='t1'`,
    )) as {
      deleted_at: string | null;
    };
    const n2 = (await getAsyncOrSync(
      db.adapter,
      `SELECT deleted_at FROM "notes" WHERE id='n2'`,
    )) as {
      deleted_at: string | null;
    };
    expect(n1.deleted_at).toBeNull(); // '' → NULL
    expect(t1.deleted_at).toBeNull(); // every table with the column
    expect(n2.deleted_at).toBe('2026-01-01T00:00:00Z'); // real delete untouched

    // Gated: a per-table sentinel was recorded for each table that had the column.
    const stamped = (await allAsyncOrSync(
      db.adapter,
      `SELECT version FROM "__lattice_migrations" WHERE version LIKE 'internal:upgrade:deleted-at-empty-to-null:v1:%'`,
    )) as unknown[];
    expect(stamped.length).toBe(2); // notes + tasks

    // Idempotent: a second run is a no-op and does not throw. A '' inserted AFTER the
    // one-time migration is intentionally NOT re-normalized (the gate fired once) —
    // 4.0 itself never writes '', so this can only be a manual artifact.
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "notes" (id, body, deleted_at) VALUES ('n3','c','')`,
    );
    await upgradeLegacyData(db);
    const n3 = (await getAsyncOrSync(
      db.adapter,
      `SELECT deleted_at FROM "notes" WHERE id='n3'`,
    )) as {
      deleted_at: string | null;
    };
    expect(n3.deleted_at).toBe(''); // gate already fired → untouched
  });

  it('backfills a legacy files.path-only row into a local_ref', async () => {
    const { db } = freshDb();
    registerNativeEntities(db); // declares the native `files` table (4.0 shape: no path column)
    await db.init();

    // Simulate a 3.x files table: add the legacy `path` column back, then insert a
    // row whose ONLY pointer is `path` (no ref_kind, no blob_path) — the shape that
    // no longer resolves under 4.0.
    await runAsyncOrSync(db.adapter, `ALTER TABLE "files" ADD COLUMN "path" TEXT`);
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "files" (id, path) VALUES ('f1', '/abs/legacy/report.pdf')`,
    );
    // A row already on the reference model must be left untouched.
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "files" (id, path, ref_kind, ref_uri) VALUES ('f2', '/x', 'cloud_ref', 's3://b/k')`,
    );

    await upgradeLegacyData(db);

    const f1 = (await getAsyncOrSync(
      db.adapter,
      `SELECT ref_kind, ref_uri, ref_provider FROM "files" WHERE id='f1'`,
    )) as { ref_kind: string | null; ref_uri: string | null; ref_provider: string | null };
    expect(f1.ref_kind).toBe('local_ref');
    expect(f1.ref_uri).toBe('/abs/legacy/report.pdf');
    expect(f1.ref_provider).toBe('fs');

    const f2 = (await getAsyncOrSync(
      db.adapter,
      `SELECT ref_kind, ref_uri FROM "files" WHERE id='f2'`,
    )) as { ref_kind: string | null; ref_uri: string | null };
    expect(f2.ref_kind).toBe('cloud_ref'); // already on the reference model — untouched
    expect(f2.ref_uri).toBe('s3://b/k');
  });

  it('backfills a deleted_at column on any user table missing it (universal soft-delete)', async () => {
    const { db } = freshDb();
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    await db.init();

    // A table created WITHOUT the soft-delete envelope — the shape that made
    // merge/delete refuse ("no deleted_at column to reversibly remove").
    await runAsyncOrSync(
      db.adapter,
      `CREATE TABLE "canonical_types" (id TEXT PRIMARY KEY, name TEXT)`,
    );
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "canonical_types" (id, name) VALUES ('c1', 'Person')`,
    );
    const before = (await allAsyncOrSync(
      db.adapter,
      `SELECT name FROM pragma_table_info('canonical_types')`,
    )) as { name: string }[];
    expect(before.map((c) => c.name)).not.toContain('deleted_at');

    await upgradeLegacyData(db);

    // The column now exists, the existing row reads as live (NULL), data intact.
    const after = (await allAsyncOrSync(
      db.adapter,
      `SELECT name FROM pragma_table_info('canonical_types')`,
    )) as { name: string }[];
    expect(after.map((c) => c.name)).toContain('deleted_at');
    const row = (await getAsyncOrSync(
      db.adapter,
      `SELECT name, deleted_at FROM "canonical_types" WHERE id='c1'`,
    )) as { name: string; deleted_at: string | null };
    expect(row.name).toBe('Person'); // no data lost
    expect(row.deleted_at).toBeNull(); // existing rows are live

    // Internal bookkeeping tables are NOT given a soft-delete column.
    const migCols = (await allAsyncOrSync(
      db.adapter,
      `SELECT name FROM pragma_table_info('__lattice_migrations')`,
    )) as { name: string }[];
    expect(migCols.map((c) => c.name)).not.toContain('deleted_at');

    // Idempotent: a second open doesn't throw or double the column.
    await upgradeLegacyData(db);
    const after2 = (await allAsyncOrSync(
      db.adapter,
      `SELECT name FROM pragma_table_info('canonical_types')`,
    )) as { name: string }[];
    expect(after2.filter((c) => c.name === 'deleted_at').length).toBe(1);
  });

  it('is a no-op on a 4.0-native DB (no path column, no empty deleted_at)', async () => {
    const { db } = freshDb();
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    await db.init();
    // Should not throw; files has no path column so the backfill is skipped entirely.
    await upgradeLegacyData(db);
    const filesPathSentinel = (await allAsyncOrSync(
      db.adapter,
      `SELECT version FROM "__lattice_migrations" WHERE version = 'internal:upgrade:files-path-to-local-ref:v1'`,
    )) as unknown[];
    expect(filesPathSentinel.length).toBe(0); // never stamped — there was no path column
  });
});
