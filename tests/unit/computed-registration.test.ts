import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { allAsyncOrSync } from '../../src/db/adapter.js';
import { COMPUTED_STATE_TABLE } from '../../src/schema/computed-fill.js';

const CONFIG_YAML = `
db: ./data.db
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text }
      priority: { type: integer }
      assignee_id: { type: uuid }
      deleted_at: { type: datetime }
    relations:
      assignee: { type: belongsTo, table: user, foreignKey: assignee_id }
    outputFile: tickets.md
  user:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text }
    outputFile: users.md
  ticket_tags:
    fields:
      id: { type: uuid, primaryKey: true }
      ticket_id: { type: uuid }
      tag_id: { type: uuid }
    relations:
      ticket: { type: belongsTo, table: ticket, foreignKey: ticket_id }
      tag: { type: belongsTo, table: tag, foreignKey: tag_id }
    outputFile: ticket_tags.md
  tag:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text }
    outputFile: tags.md
computed:
  # Declared BEFORE its base — registration must topo-sort computed→computed.
  urgent_board:
    base: ticket_summary
    fields:
      headline: { kind: alias, source: title }
      is_hot: { kind: calc, expr: "urgent = 1 AND tag_count > 0", type: boolean }
  ticket_summary:
    base: ticket
    description: Live ticket projection.
    fields:
      title: { kind: alias, source: title }
      who: { kind: alias, source: assignee.name }
      urgent: { kind: calc, expr: "priority >= 3", type: boolean }
      category: { kind: ai_classify, input: title, prompt: Categorize., labels: [bug, feature] }
      tag_count: { kind: aggregate, via: ticket_tags.tag, fn: count }
`;

describe('computed tables — SQLite registration end-to-end', () => {
  let dir: string;
  let configPath: string;
  let db: Lattice;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-computed-reg-'));
    configPath = join(dir, 'lattice.config.yml');
    writeFileSync(configPath, CONFIG_YAML);
    db = new Lattice({ config: configPath });
    await db.init();
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers the computed tables in topological order', async () => {
    expect(db.getRegisteredTableNames()).toContain('ticket_summary');
    expect(db.isComputedTable('ticket_summary')).toBe(true);
    expect(db.isComputedTable('ticket')).toBe(false);
    const reg = db.getComputedRegistration();
    // urgent_board is declared first but based on ticket_summary — its base
    // must compile and register before it.
    expect(reg?.registered).toEqual(['ticket_summary', 'urgent_board']);
    expect(reg?.errors).toEqual([]);
    expect(db.getComputedTableNames()).toEqual(['ticket_summary', 'urgent_board']);
    expect(await db.query('ticket_summary')).toEqual([]);
  });

  it('serves a computed table built on another computed table', async () => {
    const userId = await db.insert('user', { name: 'Lin' });
    const hotId = await db.insert('ticket', {
      title: 'Prod is down',
      priority: 5,
      assignee_id: userId,
    });
    const tagId = await db.insert('tag', { name: 'outage' });
    await db.insert('ticket_tags', { ticket_id: hotId, tag_id: tagId });
    const coldId = await db.insert('ticket', { title: 'Typo in docs', priority: 1 });

    expect(await db.get('urgent_board', hotId)).toMatchObject({
      headline: 'Prod is down',
      is_hot: 1,
    });
    expect(await db.get('urgent_board', coldId)).toMatchObject({
      headline: 'Typo in docs',
      is_hot: 0,
    });

    await db.delete('ticket_tags', (await db.query('ticket_tags'))[0]?.id as string);
    expect((await db.get('urgent_board', hotId))?.is_hot).toBe(0);
    await db.delete('ticket', hotId);
    await db.delete('ticket', coldId);
  });

  it('reflects base inserts and updates live through the normal query path', async () => {
    const userId = await db.insert('user', { name: 'Ada' });
    const ticketId = await db.insert('ticket', {
      title: 'Broken build',
      priority: 4,
      assignee_id: userId,
    });
    const tagId = await db.insert('tag', { name: 'ci' });
    await db.insert('ticket_tags', { ticket_id: ticketId, tag_id: tagId });

    let row = await db.get('ticket_summary', ticketId);
    expect(row).toMatchObject({
      id: ticketId,
      title: 'Broken build',
      who: 'Ada',
      urgent: 1,
      category: null, // AI field unfilled → NULL, never a model call at read time
      tag_count: 1,
    });

    await db.update('ticket', ticketId, { priority: 1 });
    row = await db.get('ticket_summary', ticketId);
    expect(row?.urgent).toBe(0);

    // Soft-deleting the base row removes it from the projection.
    await db.update('ticket', ticketId, { deleted_at: new Date().toISOString() });
    expect(await db.get('ticket_summary', ticketId)).toBeNull();
    await db.update('ticket', ticketId, { deleted_at: null });
    expect(await db.get('ticket_summary', ticketId)).not.toBeNull();
  });

  it('refuses every direct write with a clear error', async () => {
    const refusal = /read-only projection/;
    await expect(db.insert('ticket_summary', { title: 'x' })).rejects.toThrow(refusal);
    await expect(db.update('ticket_summary', 'any', { title: 'x' })).rejects.toThrow(refusal);
    await expect(db.delete('ticket_summary', 'any')).rejects.toThrow(refusal);
    await expect(db.upsert('ticket_summary', { id: 'x' })).rejects.toThrow(refusal);
    await expect(db.upsertBy('ticket_summary', 'title', 'x', {})).rejects.toThrow(refusal);
    await expect(db.upsertByNaturalKey('ticket_summary', 'title', 'x', {})).rejects.toThrow(
      refusal,
    );
    await expect(db.insertReturning('ticket_summary', { title: 'x' })).rejects.toThrow(refusal);
  });

  it('re-registers on re-open (drop + recreate is idempotent)', async () => {
    const before = await db.query('ticket_summary');
    db.close();
    db = new Lattice({ config: configPath });
    await db.init();
    expect(db.isComputedTable('ticket_summary')).toBe(true);
    const after = await db.query('ticket_summary');
    expect(after).toEqual(before);
  });

  it('records display metadata for the registered view', () => {
    const types = db.getRegisteredFieldTypes('ticket_summary');
    expect(types).toMatchObject({ id: 'uuid', urgent: 'boolean', tag_count: 'integer' });
    expect(db.getPrimaryKey('ticket_summary')).toEqual(['id']);
  });
});

describe('computed tables — a failing definition never bricks the open', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-computed-fail-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips the failed table, records the error, and registers the rest', async () => {
    // First life: "blocked_view" exists as a PHYSICAL table in the database.
    const firstConfig = join(dir, 'first.config.yml');
    writeFileSync(
      firstConfig,
      `
db: ./data.db
entities:
  blocked_view:
    fields:
      id: { type: uuid, primaryKey: true }
    outputFile: blocked.md
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text }
    outputFile: tickets.md
`,
    );
    const first = new Lattice({ config: firstConfig });
    await first.init();
    first.close();

    // Second life: the config now declares "blocked_view" as a COMPUTED table.
    // CREATE VIEW collides with the leftover physical table and must fail —
    // without failing the open or the other computed table.
    const secondConfig = join(dir, 'second.config.yml');
    writeFileSync(
      secondConfig,
      `
db: ./data.db
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text }
    outputFile: tickets.md
computed:
  blocked_view:
    base: ticket
    fields:
      t: { kind: alias, source: title }
  ok_view:
    base: ticket
    fields:
      t: { kind: alias, source: title }
`,
    );
    const db = new Lattice({ config: secondConfig });
    await db.init(); // must not throw

    try {
      const reg = db.getComputedRegistration();
      expect(reg?.registered).toEqual(['ok_view']);
      expect(reg?.errors).toHaveLength(1);
      expect(reg?.errors[0]?.table).toBe('blocked_view');
      expect(db.isComputedTable('blocked_view')).toBe(false);
      expect(db.isComputedTable('ok_view')).toBe(true);

      // The failure is recorded under field '*' in the state table.
      const state = await allAsyncOrSync(
        db.adapter,
        `SELECT * FROM "${COMPUTED_STATE_TABLE}" WHERE "table_name" = 'blocked_view'`,
      );
      expect(state).toHaveLength(1);
      expect(state[0]).toMatchObject({ field: '*', status: 'error' });

      // The rest of the database is fully usable.
      const id = await db.insert('ticket', { title: 'still works' });
      expect((await db.get('ok_view', id))?.t).toBe('still works');
    } finally {
      db.close();
    }
  });
});
