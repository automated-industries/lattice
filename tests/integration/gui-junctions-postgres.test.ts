/**
 * Postgres integration test for the Data Model schema-edit routes — the
 * data-loss guard + per-link delete on the Postgres adapter.
 *
 * Why this exists:
 *   The destroy-link and delete-table routes emit raw `ALTER TABLE … DROP
 *   COLUMN` / `DROP TABLE` SQL through execSql → runAsync with no dialect
 *   translation. The SQLite coverage in gui-junctions.test.ts proves the
 *   behavior on SQLite; this proves the SAME guards hold on Postgres:
 *     • a 2-FK entity with data columns is never droppable as a "relationship",
 *     • deleting a link drops only the FK column (Postgres DROP COLUMN),
 *     • deleting a table is refused while another table links to it.
 *
 * How to run locally (matches CI creds):
 *   docker run -d --name lattice-pg -e POSTGRES_USER=lattice \
 *     -e POSTGRES_PASSWORD=lattice -e POSTGRES_DB=lattice_test \
 *     -p 5432:5432 postgres:16
 *   LATTICE_TEST_PG_URL=postgres://lattice:lattice@localhost:5432/lattice_test \
 *     npx vitest run tests/integration/gui-junctions-postgres.test.ts
 *
 * Without the env var the suite skips. CI provides a postgres:16 service.
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

/**
 * Boot a Postgres-backed GUI with run-unique table names (the shared CI/dev
 * database has no per-test isolation, so each run gets its own `tasks_<id>`,
 * `people_<id>`, `articles_<id>`). Returns the server + the resolved names.
 */
async function bootPg(): Promise<{
  s: GuiServerHandle;
  tasks: string;
  people: string;
  articles: string;
}> {
  const runId = randomBytes(4).toString('hex');
  const tasks = `tasks_${runId}`;
  const people = `people_${runId}`;
  const articles = `articles_${runId}`;
  const root = mkdtempSync(join(tmpdir(), `gui-junc-pg-${runId}-`));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      `db: ${PG_URL!}`,
      '',
      'entities:',
      `  ${articles}:`,
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      `    outputFile: ${articles}.md`,
      `  ${people}:`,
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      `    outputFile: ${people}.md`,
      `  ${tasks}:`,
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      status: { type: text }',
      `      assignee_id: { type: uuid, ref: ${people} }`,
      `      articles_id: { type: uuid, ref: ${articles} }`,
      '      updated_at: { type: datetime }',
      `    outputFile: ${tasks}.md`,
      '',
    ].join('\n'),
  );
  const outputDir = join(root, 'context');
  mkdirSync(outputDir, { recursive: true });
  const s = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
  servers.push(s);
  return { s, tasks, people, articles };
}

async function entityNames(s: GuiServerHandle): Promise<string[]> {
  const e = (await (await fetch(`${s.url}/api/entities`)).json()) as { tables: { name: string }[] };
  return e.tables.map((t) => t.name);
}

describe.skipIf(!PG_URL)('Data Model schema edits (Postgres) — data-loss guards', () => {
  it('never drops a 2-FK entity with data columns as a "relationship"', async () => {
    const { s, tasks } = await bootPg();
    expect(await entityNames(s)).toContain(tasks);

    // The removed wholesale junction-drop route must not exist / not drop it.
    const legacy = await fetch(`${s.url}/api/schema/junctions/${tasks}`, { method: 'DELETE' });
    expect(legacy.status).not.toBe(200);
    expect(await entityNames(s)).toContain(tasks);
  });

  it('per-link delete drops only the FK column on Postgres (ALTER TABLE DROP COLUMN)', async () => {
    const { s, tasks } = await bootPg();
    const del = await fetch(`${s.url}/api/schema/entities/${tasks}/links/assignee_id`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);

    const e = (await (await fetch(`${s.url}/api/entities`)).json()) as {
      tables: { name: string; columns: string[] }[];
    };
    const t = e.tables.find((x) => x.name === tasks);
    expect(t).toBeTruthy(); // table intact
    expect(t!.columns).not.toContain('assignee_id'); // dropped
    expect(t!.columns).toContain('articles_id'); // other link intact
    expect(t!.columns).toContain('title'); // data column intact
  });

  it('refuses to delete a table while another links to it, then succeeds', async () => {
    const { s, tasks, people } = await bootPg();
    const refused = await fetch(`${s.url}/api/schema/entities/${people}`, { method: 'DELETE' });
    expect(refused.status).toBe(400);
    expect(await entityNames(s)).toContain(people);

    const unlink = await fetch(`${s.url}/api/schema/entities/${tasks}/links/assignee_id`, {
      method: 'DELETE',
    });
    expect(unlink.status).toBe(200);
    const ok = await fetch(`${s.url}/api/schema/entities/${people}`, { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect(await entityNames(s)).not.toContain(people);
    expect(await entityNames(s)).toContain(tasks);
  });

  it('surfaces canonical fieldTypes on /api/entities', async () => {
    const { s, tasks } = await bootPg();
    const e = (await (await fetch(`${s.url}/api/entities`)).json()) as {
      tables: { name: string; fieldTypes?: Record<string, string> }[];
    };
    const t = e.tables.find((x) => x.name === tasks);
    expect(t?.fieldTypes?.id).toBe('uuid');
    expect(t?.fieldTypes?.title).toBe('text');
    expect(t?.fieldTypes?.updated_at).toBe('datetime');
  });
});
