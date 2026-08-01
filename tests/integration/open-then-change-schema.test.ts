/**
 * Opening a workspace and immediately changing its shape.
 *
 * `openConfig` returns before the work it started in the background has
 * finished. That is deliberate — the owner's own reads and writes never depend
 * on it — and it is invisible from the outside: the promise it leaves behind is
 * described as something a test may await, not as a step a caller has to take.
 * So the ordinary script does the ordinary thing, opens a workspace and creates
 * a table in the next line, and the two pieces of work meet on one connection.
 *
 * On SQLite that connection can hold exactly one transaction, so the second BEGIN
 * used to be refused outright and the script died on a line that looked correct.
 * The fix is on the connection, not on the caller: overlapping transactions queue
 * instead of colliding. This pins that, because the shape it protects — open,
 * then act — is the first thing anybody writes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig, disposeActive, createUserEntity, type ActiveDb } from '../../src/index.js';

const dirs: string[] = [];
let live: ActiveDb | null = null;
let savedConfigDir: string | undefined;

afterEach(async () => {
  if (live) {
    await disposeActive(live);
    live = null;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedConfigDir;
  savedConfigDir = undefined;
});

/** A throwaway workspace + machine-config dir, so nothing here reads a real one. */
function workspace(): string {
  savedConfigDir = process.env.LATTICE_CONFIG_DIR;
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-openact-cfg-'));
  dirs.push(cfgDir);
  process.env.LATTICE_CONFIG_DIR = cfgDir;

  const root = mkdtempSync(join(tmpdir(), 'lattice-openact-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  note:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: note.md',
      '',
    ].join('\n'),
    'utf8',
  );
  return configPath;
}

describe('open, then change the schema, without waiting for anything', () => {
  it('creates a table on the line after the open', async () => {
    const configPath = workspace();
    const root = join(configPath, '..');

    // The documented open — and NOTHING else. No `converged`, no settle, no
    // sleep. A caller reading the published surface has no reason to add one,
    // so a workspace that only works when they do is broken for everybody who
    // reads the documentation instead of this repository.
    const active = await openConfig(configPath, join(root, 'context'), false);
    live = active;

    const created = await createUserEntity(active, 'vendors', ['name', 'contact'], 'open-then-act');
    expect(created).toBe('vendors');
    expect(active.validTables.has('vendors')).toBe(true);

    // And the background work still finished — serializing the two did not drop
    // either of them.
    await active.converged;
    expect(active.convergeWarnings).toEqual([]);
  });
});
