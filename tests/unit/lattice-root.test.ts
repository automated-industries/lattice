import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findLatticeRoot,
  resolveLatticeRoot,
  ensureLatticeRoot,
  rootConfigDir,
  ROOT_DIRNAME,
  CONFIG_SUBDIR,
} from '../../src/framework/lattice-root.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.LATTICE_ROOT;
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-root-'));
  dirs.push(d);
  return d;
}

describe('lattice-root', () => {
  it('finds a root by walking up to a .lattice/.config marker', () => {
    const base = tmp();
    const root = join(base, ROOT_DIRNAME);
    mkdirSync(join(root, CONFIG_SUBDIR), { recursive: true });
    const deep = join(base, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    expect(findLatticeRoot(deep)).toBe(root);
  });

  it('returns null when no root exists', () => {
    expect(findLatticeRoot(tmp())).toBeNull();
  });

  it('LATTICE_ROOT overrides discovery', () => {
    const base = tmp();
    process.env.LATTICE_ROOT = join(base, 'custom-root');
    expect(findLatticeRoot(base)).toBe(join(base, 'custom-root'));
  });

  it('does not mistake a render-output .lattice (manifest only, no .config) for a root', () => {
    const base = tmp();
    mkdirSync(join(base, ROOT_DIRNAME), { recursive: true }); // .lattice/ but NO .config marker
    expect(findLatticeRoot(base)).toBeNull();
  });

  it('resolveLatticeRoot falls back to <dir>/.lattice without writing', () => {
    const base = tmp();
    const root = resolveLatticeRoot(base);
    expect(root).toBe(join(base, ROOT_DIRNAME));
    expect(existsSync(root)).toBe(false);
  });

  it('ensureLatticeRoot creates root + .config + Workspaces', () => {
    const base = tmp();
    process.env.LATTICE_ROOT = join(base, ROOT_DIRNAME);
    const root = ensureLatticeRoot(base);
    expect(existsSync(rootConfigDir(root))).toBe(true);
    expect(existsSync(join(root, 'Workspaces'))).toBe(true);
  });
});
