import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chooseUpdateStrategy,
  resolveAppBundle,
  parseTeamIdentifier,
  sameSigningTeam,
  BUNDLE_SWAP_SH,
} from '../../src/desktop-update.js';

describe('chooseUpdateStrategy', () => {
  it('swaps only on macOS with a writable bundle parent', () => {
    expect(chooseUpdateStrategy({ platform: 'darwin', bundleParentWritable: true })).toBe('swap');
  });
  it('falls back to the installer on a non-writable /Applications (standard user)', () => {
    expect(chooseUpdateStrategy({ platform: 'darwin', bundleParentWritable: false })).toBe(
      'installer',
    );
  });
  it('falls back to the installer on Windows and Linux (no in-place bundle swap)', () => {
    expect(chooseUpdateStrategy({ platform: 'windows', bundleParentWritable: true })).toBe(
      'installer',
    );
    expect(chooseUpdateStrategy({ platform: 'linux', bundleParentWritable: true })).toBe(
      'installer',
    );
  });
});

describe('resolveAppBundle', () => {
  it('resolves the enclosing .app from the running executable path', () => {
    expect(resolveAppBundle('/Applications/Lattice.app/Contents/MacOS/Lattice')).toBe(
      '/Applications/Lattice.app',
    );
  });
  it('handles a user-Applications install and paths with spaces', () => {
    expect(resolveAppBundle('/Users/x/Applications/Lattice.app/Contents/MacOS/lattice')).toBe(
      '/Users/x/Applications/Lattice.app',
    );
    expect(resolveAppBundle('/Volumes/My Disk/Lattice.app/Contents/MacOS/Lattice')).toBe(
      '/Volumes/My Disk/Lattice.app',
    );
  });
  it('returns null when not inside a .app (dev run / odd layout)', () => {
    expect(resolveAppBundle('/usr/local/bin/lattice')).toBeNull();
    expect(resolveAppBundle('')).toBeNull();
  });
});

describe('parseTeamIdentifier / sameSigningTeam', () => {
  const codesign = [
    'Executable=/Applications/Lattice.app/Contents/MacOS/Lattice',
    'Identifier=com.example.lattice',
    'Authority=Developer ID Application: Example Corp (ABCDE12345)',
    'TeamIdentifier=ABCDE12345',
    'Sealed Resources version=2',
  ].join('\n');
  it('parses the Team Identifier from codesign -dvv output', () => {
    expect(parseTeamIdentifier(codesign)).toBe('ABCDE12345');
  });
  it('treats an ad-hoc / unsigned bundle (no team) as null', () => {
    expect(parseTeamIdentifier('Identifier=x\nTeamIdentifier=not set\n')).toBeNull();
    expect(parseTeamIdentifier('Identifier=x\n')).toBeNull();
  });
  it('same-team is true only for two present, equal teams (never two nulls)', () => {
    expect(sameSigningTeam('ABCDE12345', 'ABCDE12345')).toBe(true);
    expect(sameSigningTeam('ABCDE12345', 'DIFFERENT99')).toBe(false);
    expect(sameSigningTeam(null, null)).toBe(false);
    expect(sameSigningTeam('ABCDE12345', null)).toBe(false);
  });
});

describe('BUNDLE_SWAP_SH — injection safety', () => {
  it('is static: paths arrive as positional args, never interpolated', () => {
    // No `${...}` template holes and no un-quoted expansions of caller data — the
    // running/staged paths + pid are $1/$2/$3, passed as argv (not shell-parsed).
    expect(BUNDLE_SWAP_SH).not.toContain('${');
    expect(BUNDLE_SWAP_SH).toContain('RUNNING="$1"');
    expect(BUNDLE_SWAP_SH).toContain('STAGED="$2"');
    expect(BUNDLE_SWAP_SH).toContain('PID="$3"');
  });
});

// Execute the real swap helper against throwaway directories. This is the one
// piece whose bug could brick an install, so we prove swap + rollback + the
// never-delete-without-a-replacement guard with actual `sh`.
describe('BUNDLE_SWAP_SH — execution (swap / guard / rollback)', () => {
  // A genuinely dead pid so the helper's wait-for-exit loop returns immediately
  // (a spawned node process that has already exited; its pid is now free).
  const deadPid = String(spawnSync(process.execPath, ['-e', '0']).pid ?? 999999);

  function runSwap(dir: string, running: string, staged: string): number {
    const scriptPath = join(dir, 'swap.sh');
    writeFileSync(scriptPath, BUNDLE_SWAP_SH);
    // argv form — NOT `sh -c` — so the paths can never be shell-interpreted.
    const r = spawnSync('sh', [scriptPath, running, staged, deadPid], { timeout: 20000 });
    return r.status ?? -1;
  }

  it('swaps the staged bundle into the running path and relaunches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swap-ok-'));
    try {
      const running = join(dir, 'Lattice.app');
      const staged = join(dir, 'Lattice.app.new');
      mkdirSync(running);
      writeFileSync(join(running, 'marker'), 'OLD');
      mkdirSync(staged);
      writeFileSync(join(staged, 'marker'), 'NEW');
      runSwap(dir, running, staged);
      // Running path now holds the NEW bundle; the staged copy is consumed.
      expect(readFileSync(join(running, 'marker'), 'utf8')).toBe('NEW');
      expect(existsSync(staged)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NEVER deletes the running app when no staged bundle exists (exit 1, running intact)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swap-guard-'));
    try {
      const running = join(dir, 'Lattice.app');
      const staged = join(dir, 'Lattice.app.new'); // does NOT exist
      mkdirSync(running);
      writeFileSync(join(running, 'marker'), 'OLD');
      const status = runSwap(dir, running, staged);
      expect(status).toBe(1); // guard refused
      // The running app is untouched — the critical never-brick invariant.
      expect(readFileSync(join(running, 'marker'), 'utf8')).toBe('OLD');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the running app when the swap cannot proceed (read-only parent)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swap-ro-'));
    const parent = join(dir, 'Applications');
    try {
      mkdirSync(parent);
      const running = join(parent, 'Lattice.app');
      const staged = join(parent, 'Lattice.app.new');
      mkdirSync(running);
      writeFileSync(join(running, 'marker'), 'OLD');
      mkdirSync(staged);
      writeFileSync(join(staged, 'marker'), 'NEW');
      chmodSync(parent, 0o500); // read+execute, no write → first mv fails
      runSwap(dir, running, staged);
      chmodSync(parent, 0o700); // restore so we can read the assertion + clean up
      // First mv (running → .bak) failed, so the running app is still the original.
      expect(readFileSync(join(running, 'marker'), 'utf8')).toBe('OLD');
    } finally {
      try {
        chmodSync(parent, 0o700);
      } catch {
        /* already restored */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
