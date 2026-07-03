/**
 * Postgres dialect parity for computed tables: config-driven registration,
 * content-hash-guarded idempotent DDL (a converged open issues no view DDL),
 * CHR(31) input-key parity for the transform staleness contract, and the
 * read-only write refusal — all against a real Postgres cluster.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { allAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';
import { runComputedFill, AI_CELL_TABLE, AI_MAP_TABLE } from '../../src/schema/computed-fill.js';
import type { FillLlm } from '../../src/schema/computed-fill.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

class FakeLlm implements FillLlm {
  calls: { system: string; user: string; model: string }[] = [];
  constructor(private readonly handler: (opts: { user: string }) => string) {}
  async complete(opts: { system: string; user: string; model: string }): Promise<string> {
    this.calls.push(opts);
    return this.handler(opts);
  }
}

describe.skipIf(!PG_URL)('computed tables (Postgres)', () => {
  const runId = randomBytes(4).toString('hex');
  const ticket = `ct_${runId}_ticket`;
  const user = `ct_${runId}_user`;
  const summary = `ct_${runId}_summary`;
  let dir: string;
  let configPath: string;
  let db: Lattice;

  const configYaml = (urgentExpr: string) => `
db: "${PG_URL!}"
entities:
  ${ticket}:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text }
      status: { type: text }
      priority: { type: integer }
      assignee_id: { type: uuid }
      deleted_at: { type: datetime }
    relations:
      assignee: { type: belongsTo, table: ${user}, foreignKey: assignee_id }
    outputFile: tickets.md
  ${user}:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text }
    outputFile: users.md
computed:
  ${summary}:
    base: ${ticket}
    fields:
      title: { kind: alias, source: title }
      who: { kind: alias, source: assignee.name }
      urgent: { kind: calc, expr: "${urgentExpr}", type: boolean }
      brief: { kind: ai_transform, inputs: [title, status], prompt: Summarize. }
`;

  const migrationVersions = async (): Promise<string[]> => {
    const rows = await allAsyncOrSync(
      db.adapter,
      `SELECT version FROM __lattice_migrations WHERE version LIKE ? ORDER BY version`,
      [`internal:computed-table:${summary}:%`],
    );
    return rows.map((r) => String(r.version));
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-computed-pg-'));
    configPath = join(dir, 'lattice.config.yml');
    writeFileSync(configPath, configYaml('priority >= 3'));
    db = new Lattice({ config: configPath });
    await db.init();
  });

  afterAll(async () => {
    try {
      await runAsyncOrSync(db.adapter, `DROP VIEW IF EXISTS "${summary}"`);
      for (const t of [ticket, user]) {
        await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${t}" CASCADE`);
      }
      await runAsyncOrSync(db.adapter, `DELETE FROM __lattice_migrations WHERE version LIKE ?`, [
        `internal:computed-table:${summary}:%`,
      ]);
      await runAsyncOrSync(db.adapter, `DELETE FROM "${AI_CELL_TABLE}" WHERE field_key LIKE ?`, [
        `${summary}.%`,
      ]);
      await runAsyncOrSync(db.adapter, `DELETE FROM "${AI_MAP_TABLE}" WHERE field_key LIKE ?`, [
        `${summary}.%`,
      ]);
      await runAsyncOrSync(
        db.adapter,
        `DELETE FROM "__lattice_computed_state" WHERE table_name = ?`,
        [summary],
      );
    } catch {
      /* best effort */
    }
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers the view and serves live reads through the query path', async () => {
    expect(db.isComputedTable(summary)).toBe(true);
    expect(db.getComputedRegistration()?.errors).toEqual([]);

    const who = await db.insert(user, { name: 'Grace' });
    const id = await db.insert(ticket, {
      title: 'Segfault on boot',
      status: 'open',
      priority: 5,
      assignee_id: who,
    });
    const row = await db.get(summary, id);
    expect(row).toMatchObject({
      id,
      title: 'Segfault on boot',
      who: 'Grace',
      urgent: true,
      brief: null,
    });

    await db.update(ticket, id, { priority: 1 });
    expect((await db.get(summary, id))?.urgent).toBe(false);
  });

  it('guards the DDL behind a content-hash migration version (idempotent re-open)', async () => {
    const versions = await migrationVersions();
    expect(versions).toHaveLength(1);

    // A converged re-open must not issue new DDL — same single version row.
    db.close();
    db = new Lattice({ config: configPath });
    await db.init();
    expect(await migrationVersions()).toEqual(versions);
    expect(db.isComputedTable(summary)).toBe(true);

    // A CHANGED definition gets a new hash → the view is dropped + recreated.
    writeFileSync(configPath, configYaml('priority >= 2'));
    db.close();
    db = new Lattice({ config: configPath });
    await db.init();
    const after = await migrationVersions();
    expect(after).toHaveLength(2);
    expect(after).toContain(versions[0]!);

    const rows = await db.query(summary);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.urgent).toBe(false); // priority is 1 < 2
  });

  it('fills transforms with CHR(31) input-key parity and reads NULL on change', async () => {
    const compiled = db.getComputedRegistration()?.compiled.get(summary);
    expect(compiled).toBeDefined();
    if (!compiled) return;
    expect(compiled.selectSql).toContain('CHR(31)');

    const llm = new FakeLlm(({ user: u }) => `brief of ${u.split('\n')[2] ?? ''}`);
    const report = await runComputedFill(db.adapter, llm, compiled);
    const field = report.fields.find((f) => f.field === 'brief');
    expect(field?.status).toBe('idle');
    expect(field?.pending).toBe(0);
    expect(llm.calls.length).toBeGreaterThan(0);

    // The stored input_key was computed BY POSTGRES with the CHR(31)
    // separator — the same expression the view joins on.
    const cells = await allAsyncOrSync(
      db.adapter,
      `SELECT * FROM "${AI_CELL_TABLE}" WHERE field_key = ?`,
      [`${summary}.brief`],
    );
    expect(cells.length).toBeGreaterThan(0);
    expect(String(cells[0]?.input_key)).toContain('\u001f');

    const rows = await db.query(summary);
    for (const r of rows) expect(r.brief).not.toBeNull();

    // Staleness: changing a source column nulls the field until refill.
    const victim = rows[0]?.id as string;
    await db.update(ticket, victim, { status: 'closed' });
    expect((await db.get(summary, victim))?.brief).toBeNull();

    const llm2 = new FakeLlm(() => 'fresh brief');
    await runComputedFill(db.adapter, llm2, compiled);
    expect(llm2.calls).toHaveLength(1);
    expect((await db.get(summary, victim))?.brief).toBe('fresh brief');
  });

  it('refuses direct writes on Postgres too', async () => {
    await expect(db.insert(summary, { title: 'x' })).rejects.toThrow(/read-only projection/);
    await expect(db.delete(summary, 'any')).rejects.toThrow(/read-only projection/);
  });
});
