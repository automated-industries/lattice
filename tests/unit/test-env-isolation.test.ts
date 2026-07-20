import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { findLatticeRoot } from '../../src/framework/lattice-root.js';

// Regression guard for the "junk workspaces in the switcher" bug.
//
// A lattice install exports LATTICE_ROOT (pointing at the real ~/.lattice) into
// the shell. findLatticeRoot() honors LATTICE_ROOT as an override that ALWAYS
// wins. So any test that builds an isolated temp workspace tree and then runs a
// server path which re-derives the root (migrate-to-cloud → findLatticeRoot(
// configPath)) would resolve to the real ~/.lattice and register its throwaway
// cloud workspaces (lattice_mig_*, duplicated names) into the developer's live
// registry.json — which surfaces as fake workspaces in the GUI switcher.
//
// tests/setup/pg-env.ts deletes LATTICE_ROOT / LATTICE_CONFIG_DIR before any test
// module loads, so root resolution walks up from the actual temp path instead. If
// that neutralization is ever removed, these assertions fail and the pollution
// returns.
describe('test env is isolated from the developer machine root', () => {
  it('does not inherit the machine LATTICE_ROOT; config dir is a throwaway temp', () => {
    // LATTICE_ROOT must be cleared so root resolution can never escape to the
    // real ~/.lattice registry.
    expect(process.env.LATTICE_ROOT).toBeUndefined();
    // LATTICE_CONFIG_DIR is isolated to a temp (credential store) — it just must
    // never be the developer's real ~/.lattice.
    const cfg = process.env.LATTICE_CONFIG_DIR;
    if (cfg !== undefined) {
      expect(cfg).toContain('lattice-test-cfg-');
      expect(cfg).not.toContain('/.lattice');
    }
  });

  it('findLatticeRoot resolves a temp tree to ITS OWN root, not a global override', () => {
    const base = mkdtempSync(join(tmpdir(), 'root-iso-'));
    const root = join(base, '.lattice');
    mkdirSync(join(root, '.config'), { recursive: true }); // the root marker
    const deep = join(root, 'Workspaces', 'Some Workspace');
    mkdirSync(deep, { recursive: true });
    // Must find THIS temp root by walking up — never a machine-global ~/.lattice.
    expect(findLatticeRoot(deep)).toBe(root);
  });
});
