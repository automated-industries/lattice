/**
 * Postgres integration test for `Lattice.render()` — full render walk going
 * through the async adapter surface end-to-end.
 *
 * Why this exists:
 *   The render path was the heaviest hot-path consumer of the sync adapter
 *   surface in PR 1's analysis. Render walks every defined table, every
 *   multi-table render, and every entity context source. PR 2 makes all of
 *   those use `allAsyncOrSync`/`getAsyncOrSync`. This test confirms the
 *   render output is identical when the underlying queries are routed
 *   through the async pool — not just that the queries return rows, but
 *   that the manifest, per-entity files, and combined files are all
 *   produced as expected.
 *
 * How to run locally:
 *   LATTICE_TEST_PG_URL=postgres://... npm test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('Lattice.render (Postgres async integration)', () => {
  let db: Lattice;
  let outputDir: string;
  const runId = randomBytes(4).toString('hex');
  const teamTable = `__lattice_test_${runId}_team`;
  const memberTable = `__lattice_test_${runId}_member`;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    db.define(teamTable, {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT NOT NULL',
        slug: 'TEXT NOT NULL',
      },
      render: (rows) => `# Teams\n\n${rows.map((r) => `- ${String(r.name)}`).join('\n')}\n`,
      outputFile: `${runId}-teams.md`,
    });
    db.define(memberTable, {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT NOT NULL',
        team_id: 'TEXT',
      },
      render: () => '',
      outputFile: `.schema-only/${runId}-members.md`,
    });
    db.defineEntityContext(teamTable, {
      slug: (row) => String(row.slug),
      directoryRoot: `${runId}-teams`,
      files: {
        'TEAM.md': {
          source: { type: 'self' },
          render: (rows) => `# Team: ${String(rows[0]?.name ?? '')}\n`,
        },
        'MEMBERS.md': {
          source: { type: 'hasMany', table: memberTable, foreignKey: 'team_id' },
          render: (rows) =>
            rows.length === 0
              ? 'No members.'
              : rows.map((r) => `- ${String(r.name)}`).join('\n') + '\n',
        },
      },
    });
    await db.init();

    const t1 = await db.insert(teamTable, { name: 'Alpha Squad', slug: `${runId}-alpha` });
    const t2 = await db.insert(teamTable, { name: 'Beta Squad', slug: `${runId}-beta` });
    await db.insert(memberTable, { name: 'Alice', team_id: t1 });
    await db.insert(memberTable, { name: 'Bob', team_id: t1 });
    await db.insert(memberTable, { name: 'Charlie', team_id: t2 });

    outputDir = mkdtempSync(join(tmpdir(), `lattice-render-pg-${runId}-`));
  });

  afterAll(async () => {
    if (db) {
      const adapter = db.adapter;
      for (const t of [memberTable, teamTable]) {
        try {
          if (adapter.runAsync) await adapter.runAsync(`DROP TABLE IF EXISTS "${t}"`);
          else adapter.run(`DROP TABLE IF EXISTS "${t}"`);
        } catch {
          /* swallow */
        }
      }
      db.close();
    }
    if (outputDir && existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('produces the table-level rendered file', async () => {
    const result = await db.render(outputDir);
    expect(result.filesWritten.length).toBeGreaterThan(0);
    const teamsFile = join(outputDir, `${runId}-teams.md`);
    expect(existsSync(teamsFile)).toBe(true);
    const content = readFileSync(teamsFile, 'utf8');
    expect(content).toContain('# Teams');
    expect(content).toContain('Alpha Squad');
    expect(content).toContain('Beta Squad');
  });

  it('produces per-entity files in the entity context directory', async () => {
    await db.render(outputDir);
    const alphaDir = join(outputDir, `${runId}-teams`, `${runId}-alpha`);
    const betaDir = join(outputDir, `${runId}-teams`, `${runId}-beta`);
    expect(existsSync(join(alphaDir, 'TEAM.md'))).toBe(true);
    expect(existsSync(join(alphaDir, 'MEMBERS.md'))).toBe(true);
    expect(existsSync(join(betaDir, 'TEAM.md'))).toBe(true);

    const alphaTeam = readFileSync(join(alphaDir, 'TEAM.md'), 'utf8');
    expect(alphaTeam).toContain('Alpha Squad');

    const alphaMembers = readFileSync(join(alphaDir, 'MEMBERS.md'), 'utf8');
    expect(alphaMembers).toContain('Alice');
    expect(alphaMembers).toContain('Bob');
    expect(alphaMembers).not.toContain('Charlie');
  });

  it('produces a combined file (default: first declared file becomes combined)', async () => {
    await db.render(outputDir);
    const alphaCombined = join(outputDir, `${runId}-teams`, `${runId}-alpha`, 'TEAM.md');
    const content = readFileSync(alphaCombined, 'utf8');
    // The combined file = TEAM.md content + separator + MEMBERS.md content.
    expect(content).toContain('Team: Alpha Squad');
    expect(content).toContain('Alice');
    expect(content).toContain('Bob');
  });

  it('writes a manifest covering both entities', async () => {
    await db.render(outputDir);
    const manifestPath = join(outputDir, '.lattice', 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      entityContexts: Record<string, { entities: Record<string, unknown> }>;
    };
    expect(manifest.entityContexts[teamTable]).toBeDefined();
    const slugs = Object.keys(manifest.entityContexts[teamTable]!.entities);
    expect(slugs.sort()).toEqual([`${runId}-alpha`, `${runId}-beta`]);
  });
});
