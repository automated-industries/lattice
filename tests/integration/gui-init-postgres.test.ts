/**
 * Postgres integration test for the GUI server's openConfig() path.
 *
 * Why this exists:
 *   v1.13.2 and earlier defined `__lattice_user_identity` with
 *   `DEFAULT ""` — SQLite leniently accepts double-quoted "" as an
 *   empty-string literal, but Postgres treats it as a zero-length
 *   delimited identifier and throws at CREATE TABLE time:
 *
 *     zero-length delimited identifier at or near """""
 *
 *   This crashed every cloud-DB switch (and every fresh GUI open against
 *   a Postgres URL) until the column defaults were changed to single
 *   quotes. This test guards against the regression: open a Postgres
 *   Lattice via `startGuiServer`, hit /api/entities, and verify the
 *   `__lattice_user_identity` table created cleanly.
 *
 * How to run locally:
 *   LATTICE_TEST_PG_URL=postgres://... npm test
 *
 * Without the env var the suite skips. CI provides a postgres:16
 * service container so this always runs there.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!PG_URL)(
  'GUI openConfig() — Postgres init survives DEFAULT-quote translation',
  () => {
    it('opens a Postgres-backed lattice + serves /api/entities (regression for DEFAULT "" → DEFAULT \'\')', async () => {
      // Use a unique schema-name suffix so parallel CI runs against the
      // same database don't collide.
      const runId = randomBytes(4).toString('hex');
      const root = mkdtempSync(join(tmpdir(), `gui-pg-init-${runId}-`));
      dirs.push(root);

      // Minimal YAML pointing at a Postgres URL. The actual database
      // doesn't need any user-defined tables — the bug fires when the
      // GUI server defines the __lattice_user_identity internal table
      // during openConfig().
      const configPath = join(root, 'lattice.config.yml');
      writeFileSync(
        configPath,
        [
          `db: ${PG_URL!}`,
          '',
          'entities:',
          '  items:',
          '    fields:',
          '      id: { type: uuid, primaryKey: true }',
          '      name: { type: text }',
          '    render: default-list',
          '    outputFile: items.md',
        ].join('\n'),
      );

      const outputDir = join(root, 'context');
      mkdirSync(outputDir, { recursive: true });

      // Pre-v1.13.3, this `startGuiServer` call would throw the
      // zero-length-delimited-identifier error mid-startup. If we get here
      // with a live handle, the DEFAULT-quote fix is in place.
      const server = await startGuiServer({
        configPath,
        outputDir,
        port: 0,
        openBrowser: false,
      });
      servers.push(server);

      const entities = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
        tables: { name: string }[];
      };
      expect(entities.tables.map((t) => t.name)).toContain('items');
    });

    it('lists Lattice system tables on /api/system-tables (regression for sqlite_master + PRAGMA on Postgres)', async () => {
      // The pre-1.13.4 implementation queried sqlite_master and ran
      // PRAGMA table_info — both throw on Postgres. The bug surfaced as
      // an empty System sidebar on every Postgres-backed Lattice. This
      // test exercises the dialect-portable replacement: pg_tables for
      // the listing on Postgres, Lattice.introspectColumns() for cols.
      const runId = randomBytes(4).toString('hex');
      const root = mkdtempSync(join(tmpdir(), `gui-pg-systables-${runId}-`));
      dirs.push(root);

      const configPath = join(root, 'lattice.config.yml');
      writeFileSync(
        configPath,
        [
          `db: ${PG_URL!}`,
          '',
          'entities:',
          '  items:',
          '    fields:',
          '      id: { type: uuid, primaryKey: true }',
          '      name: { type: text }',
          '    render: default-list',
          '    outputFile: items.md',
        ].join('\n'),
      );

      const outputDir = join(root, 'context');
      mkdirSync(outputDir, { recursive: true });

      const server = await startGuiServer({
        configPath,
        outputDir,
        port: 0,
        openBrowser: false,
      });
      servers.push(server);

      const payload = (await fetch(`${server.url}/api/system-tables`).then((r) => r.json())) as {
        tables: { name: string; columns: string[]; rowCount: number }[];
      };
      // Every fresh GUI-opened Lattice registers these four system tables
      // during openConfig() init. The new dialect-portable listing
      // surfaces all four; pre-1.13.4 returned an empty list with no
      // error visible to the user.
      const tableNames = payload.tables.map((t) => t.name);
      expect(tableNames).toContain('_lattice_gui_meta');
      expect(tableNames).toContain('_lattice_gui_column_meta');
      expect(tableNames).toContain('_lattice_gui_audit');
      expect(tableNames).toContain('__lattice_user_identity');
      // Column-introspection lane survived too (replaced PRAGMA with
      // information_schema.columns via Lattice.introspectColumns).
      const userIdentity = payload.tables.find((t) => t.name === '__lattice_user_identity')!;
      expect(userIdentity.columns).toContain('display_name');
      expect(userIdentity.columns).toContain('email');
    });
  },
);
