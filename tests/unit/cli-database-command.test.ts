/**
 * `lattice database` — the shapes a human actually types, and the safeguard.
 *
 * The group exists because the databases inside a workspace could only be added
 * and removed from a browser. A command has to accept what a person has in front
 * of them (the label printed by `database list`) as well as what a script has (a
 * path), and it has to refuse the irreversible verb unless somebody said so.
 *
 * The confirmation is a FLAG, deliberately, and this file pins that: a prompt is
 * the usual answer and it is the wrong one here, because the whole point of the
 * command is that it runs with nobody watching, and a prompt in that setting is a
 * hang rather than a safeguard.
 *
 * These tests drive the subcommand directly rather than the process, which is why
 * the logic lives in its own module: the CLI entrypoint runs `main()` at import
 * time and cannot be imported.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runDatabaseCommand, resolveDatabaseRef } from '../../src/cli-database.js';
import { createDatabase } from '../../src/ops/databases.js';

let scratch: string;
let seq = 0;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lattice-cli-db-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A workspace directory holding one starter database config. */
function workspace(): string {
  seq++;
  const dir = join(scratch, `ws-${String(seq)}`);
  mkdirSync(join(dir, 'data'), { recursive: true });
  const configPath = join(dir, 'workspace.yml');
  writeFileSync(configPath, 'db: ./data/workspace.db\n\nentities: {}\n', 'utf8');
  return configPath;
}

describe('database list', () => {
  it('marks the workspace this command was pointed at', async () => {
    const configPath = workspace();
    createDatabase({ configPath, name: 'Ledger' });

    const lines = await runDatabaseCommand({ configPath });

    expect(lines).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith('* '))).toHaveLength(1);
    expect(lines.join('\n')).toContain('ledger.config');
  });
});

describe('database create', () => {
  it('accepts the name as a positional argument', async () => {
    const configPath = workspace();

    const lines = await runDatabaseCommand({ configPath, subcommand: 'create', action: 'Ledger' });

    expect(existsSync(join(dirname(configPath), 'ledger.config.yml'))).toBe(true);
    expect(lines.join('\n')).toContain('ledger.config');
  });

  it('still accepts the explicit --name flag, and prefers it', async () => {
    const configPath = workspace();

    await runDatabaseCommand({
      configPath,
      subcommand: 'create',
      action: 'Positional',
      displayName: 'Flag',
    });

    expect(existsSync(join(dirname(configPath), 'flag.config.yml'))).toBe(true);
    expect(existsSync(join(dirname(configPath), 'positional.config.yml'))).toBe(false);
  });

  it('refuses with a usage message when no name is given at all', async () => {
    const configPath = workspace();
    await expect(runDatabaseCommand({ configPath, subcommand: 'create' })).rejects.toThrow(
      /lattice database create <name>/,
    );
  });
});

describe('database delete', () => {
  it('refuses without the explicit confirmation, and removes nothing', async () => {
    const configPath = workspace();
    const created = createDatabase({ configPath, name: 'Scratch' });

    await expect(
      runDatabaseCommand({ configPath, subcommand: 'delete', action: 'scratch.config' }),
    ).rejects.toThrow(/without --yes/);

    expect(existsSync(created.path)).toBe(true);
  });

  it('removes the database once confirmed, and says what went', async () => {
    const configPath = workspace();
    const created = createDatabase({ configPath, name: 'Scratch' });
    const store = join(dirname(configPath), 'data', 'scratch.db');
    writeFileSync(store, 'rows', 'utf8');

    const lines = await runDatabaseCommand({
      configPath,
      subcommand: 'delete',
      action: 'scratch.config',
      assumeYes: true,
    });

    expect(existsSync(created.path)).toBe(false);
    expect(existsSync(store)).toBe(false);
    expect(lines.join('\n')).toContain(store);
    expect(lines.join('\n')).toContain('1 left in this workspace');
    expect(existsSync(configPath)).toBe(true);
  });

  it('removes what create just made, named the same way both times', async () => {
    // Two commands a person types in a row. If `create <name>` and
    // `delete <name>` disagree about what `<name>` refers to, the pair does not
    // work at all — and it is the pair, not either command, that is the feature.
    const configPath = workspace();
    await runDatabaseCommand({ configPath, subcommand: 'create', action: 'Q3 Ledger' });

    const lines = await runDatabaseCommand({
      configPath,
      subcommand: 'delete',
      action: 'Q3 Ledger',
      assumeYes: true,
    });

    expect(lines[0]).toContain('Deleted database "Q3 Ledger"');
    expect(existsSync(join(dirname(configPath), 'q3-ledger.config.yml'))).toBe(false);
  });

  it('does not claim a local database lived somewhere shared', async () => {
    // A freshly created database has no store file yet — the store is written the
    // first time it is opened — so deleting one removes no file. That is NOT the
    // same fact as "the rows are in a shared database", and reporting it as one
    // tells somebody their data is safe elsewhere at the exact moment it is not
    // anywhere at all.
    const configPath = workspace();
    createDatabase({ configPath, name: 'Never Opened' });

    const lines = await runDatabaseCommand({
      configPath,
      subcommand: 'delete',
      action: 'Never Opened',
      assumeYes: true,
    });

    const text = lines.join('\n');
    expect(text).not.toContain('shared database');
    expect(text).toContain('no data file to remove');
    expect(text).toContain(join('data', 'never-opened.db'));
  });

  it('says a shared database was left alone, for one that really is shared', async () => {
    const configPath = workspace();
    const cloud = join(dirname(configPath), 'team.config.yml');
    writeFileSync(cloud, 'db: postgres://example/team\n\nentities: {}\n', 'utf8');

    const lines = await runDatabaseCommand({
      configPath,
      subcommand: 'delete',
      action: cloud,
      assumeYes: true,
    });

    expect(lines.join('\n')).toContain('its rows live in a shared database, which was not touched');
  });

  it('accepts a path, which is what a script has', async () => {
    const configPath = workspace();
    const created = createDatabase({ configPath, name: 'Scratch' });

    await runDatabaseCommand({
      configPath,
      subcommand: 'delete',
      action: created.path,
      assumeYes: true,
    });

    expect(existsSync(created.path)).toBe(false);
  });

  it('refuses an unknown database before it asks about confirmation', async () => {
    // Answering "you need --yes" for a name that does not exist would send the
    // reader off to re-run an irreversible command with the safeguard removed.
    const configPath = workspace();
    await expect(
      runDatabaseCommand({ configPath, subcommand: 'delete', action: 'nope' }),
    ).rejects.toThrow(/No database named "nope"/);
  });

  it('carries the last-database refusal through from the capability', async () => {
    const configPath = workspace();
    await expect(
      runDatabaseCommand({
        configPath,
        subcommand: 'delete',
        action: 'workspace',
        assumeYes: true,
      }),
    ).rejects.toThrow(/Cannot delete the only database/);
    expect(existsSync(configPath)).toBe(true);
  });

  it('refuses with a usage message when no database is named', async () => {
    const configPath = workspace();
    await expect(runDatabaseCommand({ configPath, subcommand: 'delete' })).rejects.toThrow(
      /lattice database delete <name-or-path> --yes/,
    );
  });
});

describe('resolveDatabaseRef', () => {
  it('matches the label case-insensitively', () => {
    const configPath = workspace();
    createDatabase({ configPath, name: 'Ledger' });

    expect(resolveDatabaseRef(configPath, 'LEDGER').label).toBe('Ledger');
  });

  it('finds a database by the name it was created with', () => {
    // The whole loop, because the two halves were written apart and did not
    // meet: `create` slugs the name into a filename, and `delete` was left
    // matching that filename, so the obvious pair of commands — create it, then
    // remove it, by the same name — reported that no such database existed.
    const configPath = workspace();
    const created = createDatabase({ configPath, name: 'Q3 Ledger' });

    expect(created.name).toBe('Q3 Ledger');
    expect(resolveDatabaseRef(configPath, 'Q3 Ledger').path).toBe(created.path);
  });

  it('prefers an exact path over a label that would also match', () => {
    const configPath = workspace();
    const created = createDatabase({ configPath, name: 'Ledger' });

    expect(resolveDatabaseRef(configPath, created.path).path).toBe(created.path);
  });
});

describe('unknown subcommand', () => {
  it('lists the ones that exist', async () => {
    const configPath = workspace();
    await expect(runDatabaseCommand({ configPath, subcommand: 'rename' })).rejects.toThrow(
      /expected: list \| create \| delete/,
    );
  });
});
