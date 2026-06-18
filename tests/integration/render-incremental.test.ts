/**
 * Per-entity incremental render.
 *
 * A render used to re-render the ENTIRE context tree on every change — ~60s on a
 * large cloud for a one-row edit. `render(dir, { changedTables })` now re-renders
 * only the entity contexts a change actually affects: the changed table itself
 * plus any context that SOURCES from it (cross-table dependents). Everything else
 * keeps its files + manifest entry untouched.
 *
 * We prove scoping by TAMPERING a rendered file on disk and confirming an
 * incremental render scoped to an unrelated table does NOT overwrite it (it was
 * never rendered), while a render that DOES include it (directly or as a
 * dependent) restores it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifest } from '../../src/lifecycle/manifest.js';

describe('per-entity incremental render', () => {
  let db: Lattice;
  let dir: string;
  const dirs: string[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-incr-'));
    dirs.push(dir);
    db = new Lattice(':memory:');
    db.define('agents', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', slug: 'TEXT' },
      render: () => '',
      outputFile: '_agents.md',
    });
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', agent_id: 'TEXT', title: 'TEXT', slug: 'TEXT' },
      render: () => '',
      outputFile: '_tasks.md',
    });
    // agents' context sources hasMany tasks → agents DEPENDS ON tasks.
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'AGENT.md': {
          source: { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id' },
          render: (tasks) => `AGENT tasks=${tasks.length}`,
        },
      },
    });
    // tasks' context is self-only → depends on nothing else.
    db.defineEntityContext('tasks', {
      slug: (r) => r.slug as string,
      files: {
        'TASK.md': { source: { type: 'self' }, render: ([t]) => `TASK ${t?.title as string}` },
      },
    });
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('tasks', { id: 't1', agent_id: 'a1', title: 'Task One', slug: 'task-one' });
    await db.render(dir); // initial full render
  });

  afterEach(() => {
    db.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  const agentFile = (): string => join(dir, 'agents/alpha/AGENT.md');
  const taskFile = (): string => join(dir, 'tasks/task-one/TASK.md');

  it('renders ONLY the changed table (an unrelated table is not touched)', async () => {
    writeFileSync(agentFile(), 'TAMPERED-AGENT');
    writeFileSync(taskFile(), 'TAMPERED-TASK');

    // A change to `agents`. tasks does NOT source from agents, so it must be skipped.
    await db.render(dir, { changedTables: new Set(['agents']) });

    expect(readFileSync(agentFile(), 'utf8')).toContain('AGENT tasks='); // agents re-rendered
    expect(readFileSync(taskFile(), 'utf8')).toBe('TAMPERED-TASK'); // tasks untouched
  });

  it('re-renders a cross-table DEPENDENT (agents sources from tasks)', async () => {
    writeFileSync(agentFile(), 'TAMPERED-AGENT');
    writeFileSync(taskFile(), 'TAMPERED-TASK');

    // A change to `tasks` must re-render tasks AND agents (which lists its tasks).
    await db.render(dir, { changedTables: new Set(['tasks']) });

    expect(readFileSync(taskFile(), 'utf8')).toContain('Task One'); // tasks re-rendered
    expect(readFileSync(agentFile(), 'utf8')).toContain('AGENT tasks='); // dependent re-rendered
  });

  it('preserves the manifest entry for tables not in the incremental scope', async () => {
    await db.render(dir, { changedTables: new Set(['tasks']) });
    const m = readManifest(dir);
    // Both tables remain in the manifest (the merge keeps untouched entries), so
    // orphan-cleanup never prunes a table just because it wasn't re-rendered.
    expect(Object.keys(m?.entityContexts ?? {}).sort()).toEqual(['agents', 'tasks']);
  });
});
