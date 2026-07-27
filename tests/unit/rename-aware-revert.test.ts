import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig, applySchemaConfig } from '../../src/gui/lifecycle.js';
import { parseAudit, type AuditEntry } from '../../src/gui/mutations.js';
import { addUserColumn } from '../../src/gui/schema-ops.js';
import { applyRenameTable } from '../../src/gui/planner/appliers.js';
import type { ActiveDb } from '../../src/gui/active-db.js';

/**
 * Reverting a schema entry OUT OF ORDER, after the table it names has been
 * renamed.
 *
 * History is a stack, and the entries below a rename describe the table under
 * its OLD name. Reverting one of them directly cannot work — the change no
 * longer matches the workspace — and refusing is the right answer. What was
 * wrong is HOW it refused: the config edit was attempted anyway and the
 * document parser's own complaint ("Expected YAML collection at orders.
 * Remaining path: fields,notes") travelled all the way to the user, who is left
 * with an internal message that names neither the change they clicked nor the
 * rename that is actually in the way.
 *
 * These specs pin the explanation: the entry, the table, the rename it was
 * renamed to, and what to do about it.
 */

const dirs: string[] = [];
const actives: ActiveDb[] = [];

afterEach(() => {
  for (const a of actives.splice(0)) {
    try {
      a.db.close();
    } catch {
      // already disposed by a revert-driven reopen in the test body
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<ActiveDb> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-rename-revert-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  orders:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      code: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: orders.md',
      '  people:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: people.md',
      '',
    ].join('\n'),
    'utf8',
  );
  const active = await openConfig(configPath, join(root, 'context'), false);
  actives.push(active);
  return active;
}

/** Newest audit entry for an operation — the handle a revert needs. */
async function auditEntry(active: ActiveDb, operation: string): Promise<AuditEntry> {
  const rows = (await active.db.query('_lattice_gui_audit', {
    filters: [{ col: 'operation', op: 'eq', val: operation }],
    orderBy: 'ts',
    orderDir: 'desc',
    limit: 1,
  })) as Record<string, unknown>[];
  const row = rows[0];
  if (!row) throw new Error(`no audit entry recorded for ${operation}`);
  return parseAudit(row);
}

/** The error a revert of `entry` fails with, or null when it went through. */
async function revertError(active: ActiveDb, entry: AuditEntry): Promise<string | null> {
  try {
    const next = await applySchemaConfig(active, entry, 'inverse', false);
    const idx = actives.indexOf(active);
    if (idx >= 0) actives.splice(idx, 1, next);
    else actives.push(next);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe('reverting a schema entry whose table was since renamed', () => {
  it('explains the rename instead of surfacing a document-parser error', async () => {
    const active = await boot();
    expect(await addUserColumn(active, 'orders', 'notes', 'sess')).toMatchObject({ ok: true });
    const added = await auditEntry(active, 'schema.add_column');
    expect(await applyRenameTable(active, 'orders', 'purchase_orders', 'sess')).toEqual({
      ok: true,
    });

    const error = await revertError(active, added);
    expect(error).not.toBeNull();
    if (error === null) throw new Error('expected the out-of-order revert to be refused');

    // The internal parser message never reaches the user.
    expect(error).not.toMatch(/Expected YAML collection/i);
    expect(error).not.toMatch(/Remaining path/i);
    // What it says instead: which change, which table, what it is now called,
    // and the way out.
    expect(error).toContain('notes');
    expect(error).toContain('orders');
    expect(error).toContain('purchase_orders');
    expect(error).toMatch(/renamed/i);
    expect(error).toMatch(/undo the rename/i);
  });

  it('refuses without touching the workspace', async () => {
    const active = await boot();
    expect(await addUserColumn(active, 'orders', 'notes', 'sess')).toMatchObject({ ok: true });
    const added = await auditEntry(active, 'schema.add_column');
    expect(await applyRenameTable(active, 'orders', 'purchase_orders', 'sess')).toEqual({
      ok: true,
    });

    expect(await revertError(active, added)).not.toBeNull();
    // The refusal is a refusal: the renamed table, and the column the entry is
    // about, are exactly as they were.
    expect(active.db.getRegisteredTableNames()).toContain('purchase_orders');
    expect(Object.keys(active.db.getRegisteredColumns('purchase_orders') ?? {})).toContain('notes');
  });

  it('follows a chain of renames to the name the table has now', async () => {
    const active = await boot();
    expect(await addUserColumn(active, 'orders', 'notes', 'sess')).toMatchObject({ ok: true });
    const added = await auditEntry(active, 'schema.add_column');
    expect(await applyRenameTable(active, 'orders', 'purchase_orders', 'sess')).toEqual({
      ok: true,
    });
    expect(await applyRenameTable(active, 'purchase_orders', 'sales_orders', 'sess')).toEqual({
      ok: true,
    });

    const error = await revertError(active, added);
    if (error === null) throw new Error('expected the out-of-order revert to be refused');
    // The name it carries NOW, not the intermediate one it passed through.
    expect(error).toContain('sales_orders');
  });

  it('explains the redo direction the same way', async () => {
    const active = await boot();
    expect(await addUserColumn(active, 'orders', 'notes', 'sess')).toMatchObject({ ok: true });
    const added = await auditEntry(active, 'schema.add_column');
    expect(await applyRenameTable(active, 'orders', 'purchase_orders', 'sess')).toEqual({
      ok: true,
    });

    // Redo (forward) of the same entry hits the same wall and explains it too.
    let error: string | null = null;
    try {
      await applySchemaConfig(active, added, 'forward', false);
    } catch (e) {
      error = (e as Error).message;
    }
    expect(error).not.toBeNull();
    expect(error).not.toMatch(/Expected YAML collection/i);
    expect(error).toContain('purchase_orders');
  });

  it('still refuses clearly when the table is simply gone', async () => {
    const active = await boot();
    expect(await addUserColumn(active, 'orders', 'notes', 'sess')).toMatchObject({ ok: true });
    const added = await auditEntry(active, 'schema.add_column');
    // No rename this time — the table was removed from the configuration.
    const cfgIo = await import('../../src/gui/config-io.js');
    const cfg = cfgIo.loadConfigDoc(active.configPath);
    cfg.deleteIn(['entities', 'orders']);
    cfgIo.saveConfigDoc(active.configPath, cfg);

    const error = await revertError(active, added);
    if (error === null) throw new Error('expected the revert to be refused');
    expect(error).not.toMatch(/Expected YAML collection/i);
    expect(error).toContain('orders');
    expect(error).toContain('notes');
  });
});
