/**
 * `lattice schema` — the shapes a human actually types.
 *
 * The group exists because nesting one table inside another, and saying what a
 * column means, could only be done by clicking. The command has to be usable by
 * somebody who does not already know the answer, which is why `links` prints the
 * exact `<table>.<column>` reference `unlink` takes: a link you cannot name is a
 * link you cannot remove.
 *
 * These drive the subcommand directly rather than the process, which is why the
 * logic lives in its own module: the CLI entrypoint runs `main()` at import time
 * and cannot be imported.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSchemaCommand } from '../../src/cli-schema.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A workspace with two tables and nothing nested inside anything. */
function workspace(): { configPath: string; contextDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-cli-schema-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  customers:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: customers.md',
      '  orders:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      code: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: orders.md',
      '',
    ].join('\n'),
    'utf8',
  );
  return { configPath, contextDir: join(root, 'context') };
}

describe('schema link + unlink', () => {
  it('nests a table, prints the reference to undo it with, and un-nests it', async () => {
    const ws = workspace();

    const linked = await runSchemaCommand({
      ...ws,
      subcommand: 'link',
      action: 'orders',
      to: 'customers',
    });
    expect(linked[0]).toContain('orders → customers');
    // The line a person needs next, spelled exactly as `unlink` takes it.
    expect(linked.join('\n')).toContain('lattice schema unlink orders.customers_id');

    const listed = await runSchemaCommand({ ...ws, subcommand: 'links' });
    expect(listed).toEqual(['orders.customers_id → customers']);

    const unlinked = await runSchemaCommand({
      ...ws,
      subcommand: 'unlink',
      action: 'orders.customers_id',
    });
    expect(unlinked[0]).toContain('Unlinked orders → customers');
    expect(unlinked.join('\n')).toMatch(/reverts/);

    expect(await runSchemaCommand({ ...ws, subcommand: 'links' })).toEqual([
      'Nothing is nested inside anything yet. Add one with `lattice schema link <table> --to <parent>`.',
    ]);
  });

  it('refuses rather than reporting a link it did not make', async () => {
    const ws = workspace();

    await expect(
      runSchemaCommand({ ...ws, subcommand: 'link', action: 'orders', to: 'nope' }),
    ).rejects.toThrow(/Target entity must exist/);
    await expect(runSchemaCommand({ ...ws, subcommand: 'link', action: 'orders' })).rejects.toThrow(
      /--to <parent>/,
    );
  });

  it('tells a table reference apart from a link reference when unlinking', async () => {
    const ws = workspace();

    await expect(
      runSchemaCommand({ ...ws, subcommand: 'unlink', action: 'orders' }),
    ).rejects.toThrow(/names a table, not a link/);
  });
});

describe('schema describe', () => {
  it('writes a definition for a column and for a table', async () => {
    const ws = workspace();

    const col = await runSchemaCommand({
      ...ws,
      subcommand: 'describe',
      action: 'orders.code',
      text: 'The order number.',
    });
    expect(col).toEqual(['Described orders.code.']);

    const table = await runSchemaCommand({
      ...ws,
      subcommand: 'describe',
      action: 'orders',
      text: 'Things people bought.',
    });
    expect(table).toEqual(['Described orders.']);
  });

  it('clears a definition with an empty --text, and refuses when none was given', async () => {
    const ws = workspace();
    await runSchemaCommand({
      ...ws,
      subcommand: 'describe',
      action: 'orders.code',
      text: 'The order number.',
    });

    expect(
      await runSchemaCommand({ ...ws, subcommand: 'describe', action: 'orders.code', text: '' }),
    ).toEqual(['Cleared the description of orders.code.']);

    // Omitting --text entirely is a usage error, NOT an accidental clear.
    await expect(
      runSchemaCommand({ ...ws, subcommand: 'describe', action: 'orders.code' }),
    ).rejects.toThrow(/Pass the definition/);
  });

  it('refuses a table this workspace does not have', async () => {
    const ws = workspace();

    await expect(
      runSchemaCommand({ ...ws, subcommand: 'describe', action: 'nope.code', text: 'x' }),
    ).rejects.toThrow(/Unknown table: nope/);
  });
});

describe('schema usage', () => {
  it('names the subcommands it has when given one it does not', async () => {
    const ws = workspace();

    await expect(runSchemaCommand({ ...ws, subcommand: 'wat' })).rejects.toThrow(
      /Unknown schema subcommand: wat/,
    );
  });

  it('refuses a table it cannot list rather than printing nothing', async () => {
    const ws = workspace();

    await expect(runSchemaCommand({ ...ws, subcommand: 'links', action: 'nope' })).rejects.toThrow(
      /Unknown table: nope/,
    );
  });
});
