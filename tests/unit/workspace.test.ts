import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLatticeRoot } from '../../src/framework/lattice-root.js';
import {
  addWorkspace,
  listWorkspaces,
  getActiveWorkspace,
  setActiveWorkspace,
  resolveWorkspacePaths,
  toSafeDirName,
} from '../../src/framework/workspace.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.LATTICE_ROOT;
});

function freshRoot(): string {
  const base = mkdtempSync(join(tmpdir(), 'lattice-ws-'));
  dirs.push(base);
  process.env.LATTICE_ROOT = join(base, '.lattice');
  return ensureLatticeRoot(base);
}

describe('workspace', () => {
  it('toSafeDirName keeps legible names, strips illegal chars', () => {
    expect(toSafeDirName("Owner's Workspace")).toBe("Owner's Workspace");
    expect(toSafeDirName('a/b:c*?')).toBe('abc');
    expect(toSafeDirName('   ')).toBe('Workspace');
  });

  it('addWorkspace scaffolds Data/Context + workspace.yml and registers as active', () => {
    const root = freshRoot();
    const ws = addWorkspace(root, { displayName: "Owner's Workspace" });
    const p = resolveWorkspacePaths(root, ws);
    expect(existsSync(p.dataDir)).toBe(true);
    expect(existsSync(p.contextDir)).toBe(true);
    expect(existsSync(p.configPath)).toBe(true);
    const yml = readFileSync(p.configPath, 'utf-8');
    expect(yml).toContain('db: ./Data/database.db');
    expect(yml).toContain('entities: {}');
    expect(getActiveWorkspace(root)?.id).toBe(ws.id);
    expect(ws.kind).toBe('local');
    expect(ws.dir).toBe("Owner's Workspace");
  });

  it('disambiguates duplicate display names', () => {
    const root = freshRoot();
    const a = addWorkspace(root, { displayName: 'Notes' });
    const b = addWorkspace(root, { displayName: 'Notes' });
    expect(a.dir).toBe('Notes');
    expect(b.dir).toBe('Notes (2)');
    expect(listWorkspaces(root).length).toBe(2);
  });

  it('detects a cloud db kind and supports setActive', () => {
    const root = freshRoot();
    addWorkspace(root, { displayName: 'Local' });
    const cloud = addWorkspace(root, { displayName: 'Cloud', db: 'postgres://u:p@h:5432/db' });
    expect(cloud.kind).toBe('cloud');
    setActiveWorkspace(root, cloud.id);
    expect(getActiveWorkspace(root)?.id).toBe(cloud.id);
  });
});
