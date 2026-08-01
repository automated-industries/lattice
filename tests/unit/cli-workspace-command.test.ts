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
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
import { Lattice } from '../../src/lattice.js';

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

describe('workspace delete', () => {
  it('refuses without the explicit confirmation, and changes nothing', async () => {
    // The safeguard has to be a FLAG rather than a prompt: this command exists so
    // the operation can run unattended, and a prompt in a script is a hang.
    const root = newRoot();
    const ws = addWorkspace(root, { displayName: 'Scratch' });
    addWorkspace(root, { displayName: 'Keep' });

    await expect(
      runWorkspaceCommand({ root, subcommand: 'delete', action: 'Scratch' }),
    ).rejects.toThrow(/without --yes/);

    expect(listWorkspaces(root).map((w) => w.id)).toContain(ws.id);
    expect(existsSync(resolveWorkspacePaths(root, ws).configPath)).toBe(true);
  });

  it('removes the registry record and the folder it scaffolded', async () => {
    const root = newRoot();
    const ws = addWorkspace(root, { displayName: 'Scratch' });
    const keep = addWorkspace(root, { displayName: 'Keep' });
    const scratchDir = resolveWorkspacePaths(root, ws).dir;

    const lines = await runWorkspaceCommand({
      root,
      subcommand: 'delete',
      action: 'Scratch',
      assumeYes: true,
    });

    expect(listWorkspaces(root).map((w) => w.id)).toEqual([keep.id]);
    expect(existsSync(scratchDir)).toBe(false);
    expect(lines.join('\n')).toContain('Scratch');
    // The sibling is untouched — a delete that took the neighbour's files with it
    // would still print exactly this.
    expect(existsSync(resolveWorkspacePaths(root, keep).configPath)).toBe(true);
  });

  it('resolves the display name a person read out of `workspace list`', async () => {
    const root = newRoot();
    addWorkspace(root, { displayName: 'Keep' });
    const ws = addWorkspace(root, { displayName: 'Second' });

    await runWorkspaceCommand({ root, subcommand: 'delete', action: 'sEcOnD', assumeYes: true });

    expect(listWorkspaces(root).map((w) => w.id)).not.toContain(ws.id);
  });

  it('refuses an unknown workspace before it asks about confirmation', async () => {
    // Reporting "you need --yes" for a name that does not exist would send the
    // reader off to re-run an irreversible command with the safeguard removed.
    const root = newRoot();
    addWorkspace(root, { displayName: 'Only' });

    await expect(
      runWorkspaceCommand({ root, subcommand: 'delete', action: 'Nope' }),
    ).rejects.toThrow(/No workspace named "Nope"/);
    expect(listWorkspaces(root)).toHaveLength(1);
  });

  it('refuses with a usage message when no workspace is named', async () => {
    const root = newRoot();
    await expect(runWorkspaceCommand({ root, subcommand: 'delete' })).rejects.toThrow(
      /lattice workspace delete <name-or-id> --yes/,
    );
  });
});

describe('rename', () => {
  it('renames the registry record a person reads out of `workspace list`', async () => {
    const root = newRoot();
    const ws = addWorkspace(root, { displayName: 'Before' });
    // Scaffold the config the registry points at — rename writes the file too.
    const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
    db.close();

    const lines = await runWorkspaceCommand({
      root,
      subcommand: 'rename',
      action: 'Before',
      displayName: 'After',
    });

    expect(listWorkspaces(root).map((w) => w.displayName)).toEqual(['After']);
    expect(lines.join('\n')).toContain('After');
    // Both writes, so the file agrees with the registry. A rename that only
    // touched one would still print exactly the line above.
    const configText = readFileSync(resolveWorkspacePaths(root, ws).configPath, 'utf8');
    expect(configText).toContain('After');
  });

  it('refuses a rename with no new name rather than writing an empty one', async () => {
    const root = newRoot();
    addWorkspace(root, { displayName: 'Only' });

    await expect(
      runWorkspaceCommand({ root, subcommand: 'rename', action: 'Only' }),
    ).rejects.toThrow(/--name/);
    expect(listWorkspaces(root).map((w) => w.displayName)).toEqual(['Only']);
  });

  it('refuses an unknown workspace', async () => {
    const root = newRoot();
    addWorkspace(root, { displayName: 'Only' });

    await expect(
      runWorkspaceCommand({ root, subcommand: 'rename', action: 'Nope', displayName: 'x' }),
    ).rejects.toThrow(/No workspace named "Nope"/);
  });
});

describe('unknown subcommand', () => {
  it('lists the ones that exist', async () => {
    const root = newRoot();
    await expect(runWorkspaceCommand({ root, subcommand: 'archive' })).rejects.toThrow(
      /expected: list \| create \| use \| rename \| delete/,
    );
  });
});
