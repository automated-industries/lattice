import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importLegacyUserConfig } from '../../src/framework/migrate-to-root.js';
import { rootConfigDir } from '../../src/framework/lattice-root.js';

const dirs: string[] = [];
let savedCfg: string | undefined;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedCfg === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedCfg;
});

describe('importLegacyUserConfig', () => {
  it('copies legacy config into <root>/.config non-destructively + idempotently', () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-mig-'));
    dirs.push(base);
    const legacy = join(base, 'legacy');
    mkdirSync(join(legacy, 'keys'), { recursive: true });
    writeFileSync(join(legacy, 'master.key'), 'KEY');
    writeFileSync(join(legacy, 'identity.json'), '{"display_name":"x"}');
    writeFileSync(join(legacy, 'keys', 'team.token'), 'tok');

    savedCfg = process.env.LATTICE_CONFIG_DIR;
    process.env.LATTICE_CONFIG_DIR = legacy;

    const root = join(base, '.lattice');
    const res = importLegacyUserConfig(root);
    expect(res.migrated).toBe(true);
    expect(res.copied).toEqual(expect.arrayContaining(['master.key', 'identity.json', 'keys']));
    expect(readFileSync(join(rootConfigDir(root), 'master.key'), 'utf-8')).toBe('KEY');
    expect(existsSync(join(rootConfigDir(root), 'keys', 'team.token'))).toBe(true);

    // originals left intact
    expect(existsSync(join(legacy, 'master.key'))).toBe(true);
    // idempotent: a second run is a no-op because the dest already has a key
    expect(importLegacyUserConfig(root).migrated).toBe(false);
  });

  it('does nothing when the legacy store has no master.key', () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-mig-'));
    dirs.push(base);
    const legacy = join(base, 'legacy');
    mkdirSync(legacy, { recursive: true });
    savedCfg = process.env.LATTICE_CONFIG_DIR;
    process.env.LATTICE_CONFIG_DIR = legacy;
    expect(importLegacyUserConfig(join(base, '.lattice')).migrated).toBe(false);
  });
});
