/**
 * `lattice workspace` — the two forms a human actually types.
 *
 * The documented shapes are `workspace create <name>` and `workspace use <name>`:
 * a person reads a display name out of `workspace list` and types it back. Both
 * were rejected — `create` demanded `--name` and swallowed the positional, and
 * `use` compared its argument against the registry ids only, so the name printed
 * one line earlier resolved to nothing. A UUID stays valid for `use` (it survives
 * renames, so it is what a script should pass), but it must not be the ONLY
 * accepted form.
 *
 * These tests drive the subcommand directly rather than the process, which is why
 * the logic lives in its own module: the CLI entrypoint runs `main()` at import
 * time and cannot be imported.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkspaceCommand, resolveWorkspaceRef } from '../../src/cli-workspace.js';
import {
  addWorkspace,
  getActiveWorkspace,
  listWorkspaces,
  resolveWorkspacePaths,
} from '../../src/framework/workspace.js';
import { ensureRootAt } from '../../src/framework/lattice-root.js';

let scratch: string;
const prev: Record<string, string | undefined> = {};
let rootSeq = 0;

/** A fresh, empty `.lattice` root per test — no shared registry state. */
function newRoot(): string {
  rootSeq++;
  const root = join(scratch, `root-${String(rootSeq)}`);
  return ensureRootAt(root);
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lattice-cli-ws-'));
  for (const key of ['LATTICE_CONFIG_DIR', 'LATTICE_ROOT', 'LATTICE_ENCRYPTION_KEY']) {
    prev[key] = process.env[key];
  }
  // Key + registry resolution stay inside the scratch dir — never the machine's
  // own config dir or home root.
  process.env.LATTICE_CONFIG_DIR = join(scratch, 'config');
  mkdirSync(process.env.LATTICE_CONFIG_DIR, { recursive: true });
  process.env.LATTICE_ROOT = join(scratch, 'unused-root');
  process.env.LATTICE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});

afterAll(() => {
  for (const [key, value] of Object.entries(prev)) {
    // Restore the ambient environment: a var that was absent goes back to
    // absent, not to an empty string.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe('workspace create', () => {
  it('accepts the display name as a positional argument', async () => {
    const root = newRoot();
    const lines = await runWorkspaceCommand({ root, subcommand: 'create', action: 'Research' });

    const all = listWorkspaces(root);
    expect(all.map((w) => w.displayName)).toEqual(['Research']);
    expect(lines.join('\n')).toContain('Research');
    // Scaffolded for real, not just registered.
    expect(existsSync(resolveWorkspacePaths(root, all[0]!).configPath)).toBe(true);
  });

  it('still accepts the explicit --name flag', async () => {
    const root = newRoot();
    await runWorkspaceCommand({ root, subcommand: 'create', displayName: 'Field Notes' });
    expect(listWorkspaces(root).map((w) => w.displayName)).toEqual(['Field Notes']);
  });

  it('prefers --name when both a flag and a positional are given', async () => {
    const root = newRoot();
    await runWorkspaceCommand({
      root,
      subcommand: 'create',
      action: 'Positional',
      displayName: 'Flag',
    });
    expect(listWorkspaces(root).map((w) => w.displayName)).toEqual(['Flag']);
  });

  it('refuses with a usage message when no name is given at all', async () => {
    const root = newRoot();
    await expect(runWorkspaceCommand({ root, subcommand: 'create' })).rejects.toThrow(
      /lattice workspace create <name>/,
    );
    expect(listWorkspaces(root)).toEqual([]);
  });
});

describe('workspace use', () => {
  it('accepts the display name printed by `workspace list`', async () => {
    const root = newRoot();
    const first = addWorkspace(root, { displayName: 'First' });
    const second = addWorkspace(root, { displayName: 'Second' });
    expect(getActiveWorkspace(root)?.id).toBe(first.id);

    const lines = await runWorkspaceCommand({ root, subcommand: 'use', action: 'Second' });

    expect(getActiveWorkspace(root)?.id).toBe(second.id);
    expect(lines.join('\n')).toContain('Second');
  });

  it('still accepts the workspace id', async () => {
    const root = newRoot();
    addWorkspace(root, { displayName: 'First' });
    const second = addWorkspace(root, { displayName: 'Second' });

    await runWorkspaceCommand({ root, subcommand: 'use', action: second.id });

    expect(getActiveWorkspace(root)?.id).toBe(second.id);
  });

  it('matches a display name case-insensitively', async () => {
    const root = newRoot();
    addWorkspace(root, { displayName: 'First' });
    const second = addWorkspace(root, { displayName: 'Second' });

    await runWorkspaceCommand({ root, subcommand: 'use', action: 'sEcOnD' });

    expect(getActiveWorkspace(root)?.id).toBe(second.id);
  });

  it('names the workspaces when a display name is ambiguous, and changes nothing', async () => {
    const root = newRoot();
    const first = addWorkspace(root, { displayName: 'Twin' });
    addWorkspace(root, { displayName: 'Twin' });

    await expect(runWorkspaceCommand({ root, subcommand: 'use', action: 'Twin' })).rejects.toThrow(
      /matches 2 workspaces/,
    );
    expect(getActiveWorkspace(root)?.id).toBe(first.id);
  });

  it('refuses an unknown workspace instead of silently doing nothing', async () => {
    const root = newRoot();
    const first = addWorkspace(root, { displayName: 'First' });

    await expect(runWorkspaceCommand({ root, subcommand: 'use', action: 'Nope' })).rejects.toThrow(
      /No workspace named "Nope"/,
    );
    expect(getActiveWorkspace(root)?.id).toBe(first.id);
  });

  it('refuses with a usage message when no workspace is named', async () => {
    const root = newRoot();
    await expect(runWorkspaceCommand({ root, subcommand: 'use' })).rejects.toThrow(
      /lattice workspace use <name-or-id>/,
    );
  });
});

describe('resolveWorkspaceRef', () => {
  it('prefers an exact id over a display name that collides with it', () => {
    const root = newRoot();
    const target = addWorkspace(root, { displayName: 'Target' });
    // A second workspace deliberately DISPLAY-named after the first one's id.
    addWorkspace(root, { displayName: target.id });

    expect(resolveWorkspaceRef(root, target.id).id).toBe(target.id);
  });

  it('prefers an exact display name over a case-insensitive one', () => {
    const root = newRoot();
    addWorkspace(root, { displayName: 'notes' });
    const exact = addWorkspace(root, { displayName: 'Notes' });

    expect(resolveWorkspaceRef(root, 'Notes').id).toBe(exact.id);
  });

  it('resolves the on-disk folder name', () => {
    const root = newRoot();
    const ws = addWorkspace(root, { displayName: 'My Notes' });

    expect(resolveWorkspaceRef(root, ws.dir).id).toBe(ws.id);
  });
});

describe('workspace list', () => {
  it('marks the active workspace and reports an empty registry', async () => {
    const root = newRoot();
    expect((await runWorkspaceCommand({ root })).join('\n')).toMatch(/No workspaces/);

    const first = addWorkspace(root, { displayName: 'First' });
    addWorkspace(root, { displayName: 'Second' });
    const lines = await runWorkspaceCommand({ root, subcommand: 'list' });

    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith('* ')).toBe(true);
    expect(lines[0]).toContain(first.id);
    expect(lines[1]?.startsWith('  ')).toBe(true);
  });
});

describe('unknown subcommand', () => {
  it('lists the ones that exist', async () => {
    const root = newRoot();
    await expect(runWorkspaceCommand({ root, subcommand: 'delete' })).rejects.toThrow(
      /expected: list \| create \| use/,
    );
  });
});
