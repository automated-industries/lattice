import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  openConfig,
  disposeActive,
  createRow,
  updateRow,
  deleteRow,
  undoGroup,
  previewRowChanges,
  type ActiveDb,
  type MutationCtx,
} from '../../src/index.js';

/**
 * The write path must be usable from the published package alone.
 *
 * Every audited mutation the browser client performs goes through the same small
 * set of primitives; the HTTP routes are one caller of them, not the owner. This
 * spec exercises the whole cycle — open a workspace, create rows, update one,
 * preview a change, undo the whole group — using ONLY named exports from the
 * package entrypoint, with no server listening anywhere. If any of these stops
 * being reachable from `latticesql`, a program that automates its own workspace
 * has to shell out to a browser session to do what a click does, which is the
 * gap this pins shut.
 */

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

/**
 * A throwaway workspace on disk plus a throwaway machine-config dir, so opening
 * it never reads or creates the encryption key belonging to whoever runs this.
 */
async function boot(): Promise<ActiveDb> {
  savedConfigDir = process.env.LATTICE_CONFIG_DIR;
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-headless-cfg-'));
  dirs.push(cfgDir);
  process.env.LATTICE_CONFIG_DIR = cfgDir;

  const root = mkdtempSync(join(tmpdir(), 'lattice-headless-'));
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
      '      body: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: note.md',
      '',
    ].join('\n'),
    'utf8',
  );
  const active = await openConfig(configPath, join(root, 'context'), false);
  await active.converged;
  live = active;
  return active;
}

describe('headless mutating surface', () => {
  it('runs create → update → group undo from the package entrypoint, no server', async () => {
    const active = await boot();
    const ctx: MutationCtx = {
      db: active.db,
      feed: active.feed,
      softDeletable: active.softDeletable,
      source: 'cli',
      sessionId: 'headless-session',
      opGroup: 'headless-group',
    };

    const first = await createRow(ctx, 'note', { title: 'Budget', body: 'Q3 draft' });
    const second = await createRow(ctx, 'note', { title: 'Roadmap', body: '5.7' });
    expect(first.row?.title).toBe('Budget');
    expect(second.row?.title).toBe('Roadmap');

    // The same preview the client shows before committing an edit.
    const preview = await previewRowChanges(
      active.db,
      'note',
      'note',
      active.softDeletable,
      { body: 'Q3 final' },
      { ids: [first.id] },
    );
    expect(preview.total).toBe(1);
    expect(preview.rows[0]?.wouldChange).toBe(true);
    expect(preview.rows[0]?.fields.map((f) => f.column)).toContain('body');

    const updated = await updateRow(ctx, 'note', first.id, { body: 'Q3 final' });
    expect(updated.row?.body).toBe('Q3 final');

    // All three writes carry the same operation group, so one undo reverses the
    // whole thing — the bulk-undo action, driven headlessly.
    const undone = await undoGroup(ctx, 'headless-group');
    expect(undone.ok).toBe(true);
    if (undone.ok) {
      expect(undone.undone).toBe(3);
      expect(undone.tables).toEqual(['note']);
    }

    const remaining = await active.db.query('note', {
      filters: [{ col: 'deleted_at', op: 'isNull' }],
      limit: 10,
    });
    expect(remaining).toHaveLength(0);

    // deleteRow is reachable too (the delete half of the CRUD set).
    const third = await createRow(ctx, 'note', { title: 'Scratch' });
    await deleteRow(ctx, 'note', third.id, true);
    expect(await active.db.get('note', third.id)).toBeNull();
  });

  it('reaches the mutating primitives without loading the HTTP layer', () => {
    // The claim above is only true if these modules can run with no server
    // module in the graph. Walk their runtime imports (type-only imports are
    // erased by the compiler, so they carry no runtime dependency) and assert
    // none of them pulls in Node's HTTP server.
    const srcRoot = resolve(__dirname, '..', '..', 'src');
    const entries = [
      'gui/mutations.ts',
      'gui/change-preview.ts',
      'gui/schema-ops.ts',
      'gui/computed-ops.ts',
      'gui/lifecycle.ts',
      'gui/planner/apply.ts',
      'gui/planner/run.ts',
    ].map((p) => join(srcRoot, p));

    const resolveSpec = (spec: string, fromFile: string): string | null => {
      if (!spec.startsWith('.')) return null;
      const base = resolve(dirname(fromFile), spec);
      const asTs = base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : base;
      if (existsSync(asTs)) return asTs;
      if (existsSync(`${asTs}.ts`)) return `${asTs}.ts`;
      if (existsSync(join(asTs, 'index.ts'))) return join(asTs, 'index.ts');
      return null;
    };

    const seen = new Set<string>();
    const offenders: string[] = [];
    const stack = [...entries];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (!existsSync(file)) continue;
      const src = readFileSync(file, 'utf8');
      const re =
        /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const spec = m[1] ?? m[2] ?? m[3];
        if (!spec) continue;
        if (spec.startsWith('node:http')) {
          offenders.push(`${file.slice(srcRoot.length + 1)} imports ${spec}`);
          continue;
        }
        const next = resolveSpec(spec, file);
        if (next) stack.push(next);
      }
    }
    expect(seen.size).toBeGreaterThan(50); // the walk actually traversed
    expect(offenders).toEqual([]);
  });
});
