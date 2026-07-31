/**
 * A rolled-back migration must put ITS OWN workspace back — and nothing else.
 *
 * The workspace registry is shared machine state. It is one file listing every
 * workspace on the machine, and any Lattice process — a second window, a
 * `lattice open`, a workspace switch — rewrites it whenever somebody registers
 * or switches. A migration is the longest single operation holding a claim on
 * it: copy the rows, secure the target, publish the layout, and only then cut
 * the workspace over.
 *
 * The cutover's rollback used to restore the registry by writing back the WHOLE
 * FILE as it looked when the cutover began. That undoes this workspace's record
 * correctly and, in the same stroke, deletes every record anybody else wrote
 * while the migration was running. Those workspaces' configs, databases and
 * rendered trees all survive on disk — nothing lists them any more, so nothing
 * opens them, and the operator finds out by noticing a workspace has vanished
 * from the switcher. Meanwhile the error says the workspace is "unchanged".
 *
 * So this file drives the exported cutover — the same function `lattice cloud
 * migrate` and the GUI's migrate route both call — with a genuinely independent
 * writer landing a registration in the middle of it, and forces the last step to
 * fail. Two things have to hold afterwards: the migrated workspace is back to
 * local, and whatever the other writer did is still there.
 *
 * How the interleave is produced, said out loud: the cutover is entirely
 * synchronous, so nothing in this process can run between two of its statements.
 * The archive step is therefore replaced with a stand-in that runs the other
 * writer and then throws the same error the real archive throws when its source
 * is missing. For the registration case the other writer is a REAL child
 * process, writing the real registry file the way the registry writer does
 * (temp file, then rename). The registry mutation is not simulated, and the code
 * under test — the unwind — is the real one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { cutOverWorkspaceToCloud } from '../../src/cloud/migrate.js';
import { readDbLine } from '../../src/framework/db-pointer.js';
import { getDbCredential } from '../../src/framework/user-config.js';
import { ensureRootAt, registryPath } from '../../src/framework/lattice-root.js';
import {
  addWorkspace,
  findWorkspaceByConfigPath,
  listWorkspaces,
  readRegistry,
  resolveWorkspacePaths,
  setActiveWorkspace,
} from '../../src/framework/workspace.js';

/** Runs at the moment the archive step would, just before it fails. */
let duringArchive: (() => void) | null = null;

vi.mock('../../src/framework/cloud-migration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/framework/cloud-migration.js')>();
  return {
    ...actual,
    archiveLocalSqlite: (dbPath: string): string => {
      duringArchive?.();
      // The real failure this stands in for: the archive rename cannot happen.
      throw new Error(`archiveLocalSqlite: source file does not exist: ${dbPath}`);
    },
  };
});

/**
 * Register a workspace from a SEPARATE OS process, the way the registry writer
 * does it — build the new list, write a temp file, rename it onto the registry.
 * Nothing here borrows the module instance under test.
 */
function registerFromAnotherProcess(root: string, displayName: string): void {
  const path = registryPath(root);
  const script = `
    const { readFileSync, writeFileSync, renameSync } = require('node:fs');
    const path = ${JSON.stringify(path)};
    const reg = JSON.parse(readFileSync(path, 'utf-8'));
    reg.workspaces.push({
      id: ${JSON.stringify(`other-${displayName.toLowerCase()}`)},
      displayName: ${JSON.stringify(displayName)},
      dir: ${JSON.stringify(displayName)},
      db: './Data/database.db',
      kind: 'local',
      createdAt: new Date().toISOString(),
    });
    const tmp = path + '.tmp-' + process.pid;
    writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\\n', 'utf-8');
    renameSync(tmp, path);
  `;
  execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' });
}

const KEY = Buffer.alloc(32, 7).toString('base64');
const TARGET_URL = 'postgres://someone:secret@shared.example.test:5432/field_notes';

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};

function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `lattice-rollback-${prefix}-`));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  duringArchive = null;
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ROOT', 'LATTICE_ENCRYPTION_KEY']) {
    saved[k] = process.env[k];
  }
  const env = scratch('env');
  process.env.LATTICE_CONFIG_DIR = join(env, 'config');
  process.env.LATTICE_ROOT = join(env, 'unused');
  process.env.LATTICE_ENCRYPTION_KEY = KEY;
  mkdirSync(process.env.LATTICE_CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  duringArchive = null;
  for (const [k, v] of Object.entries(saved)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface LocalWorkspace {
  id: string;
  configPath: string;
  dbPath: string;
  originalDbLine: string;
}

/** A real local workspace with a real row in it, registered under `root`. */
async function localWorkspace(root: string, name: string): Promise<LocalWorkspace> {
  const record = addWorkspace(root, { displayName: name, makeActive: true });
  const paths = resolveWorkspacePaths(root, record);
  writeFileSync(
    paths.configPath,
    [
      `name: "${name}"`,
      'db: ./Data/database.db',
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: text, primaryKey: true }',
      '      body: { type: text }',
      '    outputFile: notes.md',
      '',
    ].join('\n'),
    'utf8',
  );
  const db = new Lattice({ config: paths.configPath }, { encryptionKey: KEY });
  await db.init();
  await db.insert('notes', { id: 'n-1', body: 'the row that must survive' });
  db.close();
  return {
    id: record.id,
    configPath: paths.configPath,
    dbPath: join(paths.dataDir, 'database.db'),
    originalDbLine: readDbLine(paths.configPath) ?? '',
  };
}

/** Run the cutover and hand back whatever it threw. */
function failingCutover(configPath: string, root: string, dbPath: string): Error {
  try {
    cutOverWorkspaceToCloud({
      configPath,
      label: 'field_notes',
      url: TARGET_URL,
      latticeRoot: root,
      sourceDbPath: dbPath,
    });
  } catch (e) {
    return e as Error;
  }
  throw new Error('the cutover was supposed to fail and did not');
}

describe('a rolled-back cutover leaves every OTHER workspace alone', () => {
  it('does not erase a workspace registered while the migration was running', async () => {
    const root = ensureRootAt(scratch('root'));
    const ws = await localWorkspace(root, 'Field-Notes');
    duringArchive = () => {
      registerFromAnotherProcess(root, 'Ledger');
    };

    const thrown = failingCutover(ws.configPath, root, ws.dbPath);
    expect(thrown.message, 'the cutover failed loudly').toContain('rolled back');

    // The point of the whole file: the other process's workspace is still listed.
    expect(
      listWorkspaces(root)
        .map((w) => w.displayName)
        .sort(),
      'the workspace another process registered mid-migration is still in the registry',
    ).toEqual(['Field-Notes', 'Ledger']);

    // And this workspace really did come back.
    const mine = findWorkspaceByConfigPath(root, ws.configPath);
    expect(mine?.kind, 'the migrated workspace is local again').toBe('local');
    expect(mine?.id, 'as the same record, not a replacement').toBe(ws.id);
    expect(readDbLine(ws.configPath), 'and its config names its own file again').toBe(
      ws.originalDbLine,
    );
    expect(getDbCredential('field_notes'), 'with no credential left behind').toBeNull();
    expect(existsSync(ws.dbPath), 'and nothing was archived').toBe(true);
  });

  it('does not undo a workspace switch another process made mid-migration', async () => {
    const root = ensureRootAt(scratch('root'));
    const ws = await localWorkspace(root, 'Field-Notes');
    const other = await localWorkspace(root, 'Ledger');
    // Field-Notes is the one being migrated, and the active one right now.
    setActiveWorkspace(root, ws.id);

    // Mid-migration, another process switches to Ledger. That choice is NEWER
    // than the migration's own "make this active", so the rollback must not
    // reach back and revert it.
    const registry = registryPath(root);
    duringArchive = () => {
      const reg = JSON.parse(readFileSync(registry, 'utf-8')) as { activeWorkspaceId: string };
      reg.activeWorkspaceId = other.id;
      writeFileSync(registry, `${JSON.stringify(reg, null, 2)}\n`, 'utf-8');
    };

    failingCutover(ws.configPath, root, ws.dbPath);

    expect(
      readRegistry(root).activeWorkspaceId,
      'the newer switch stands — the rollback did not undo it',
    ).toBe(other.id);
    expect(
      listWorkspaces(root)
        .map((w) => w.displayName)
        .sort(),
    ).toEqual(['Field-Notes', 'Ledger']);
  });
});

describe('the failure it reports says what it actually did', () => {
  it('does not call the workspace "unchanged", and does not claim it is still open', async () => {
    const root = ensureRootAt(scratch('root'));
    const ws = await localWorkspace(root, 'Field-Notes');

    const message = failingCutover(ws.configPath, root, ws.dbPath).message;

    // "unchanged" overstates a rollback that restored three named things and
    // left a full copy of the workspace sitting in the target database.
    expect(message, 'it does not assert the workspace is unchanged').not.toContain('unchanged');
    // The command path releases the source handle BEFORE the cutover runs, so
    // "still open on its local database" is false where it matters most.
    expect(message, 'and does not claim a handle it may not hold').not.toContain('still open');
    // What it says instead: exactly what came back, and what did not.
    expect(message).toContain('rolled back');
    expect(message).toContain('registry record');
    expect(message).toContain('shared.example.test');
    expect(message, 'without printing the password that reached it').not.toContain('secret@');
  });
});
