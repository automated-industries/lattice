/**
 * The library surface the docs tell people to use must exist, and must be the
 * same surface the product itself runs on.
 *
 * Two failures this pins:
 *
 * 1. A doc snippet that names a symbol the package does not export. The snippet
 *    reads as tested code and is not; the reader finds out at import time.
 * 2. A doc snippet that names a symbol the package DOES export but which answers
 *    a different question than the one the reader is asking. The workspace guide
 *    told embedders to resolve the root with `ensureLatticeRoot()`, which searches
 *    upward from the working directory. A session — the GUI, the CLI,
 *    `Lattice.openWorkspace()` — never does that; it uses the named root, then
 *    `LATTICE_ROOT`, then the home root. An embedder following the guide therefore
 *    registered workspaces in one registry while the app it was automating read
 *    another, with nothing reporting the divergence.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as lattice from '../../src/index.js';
import {
  Lattice,
  addWorkspace,
  getActiveWorkspace,
  resolveLatticeRoot,
  resolveSessionRoot,
} from '../../src/index.js';

let scratch: string;
const prev: Record<string, string | undefined> = {};

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lattice-docs-surface-'));
  for (const key of ['LATTICE_CONFIG_DIR', 'LATTICE_ROOT', 'LATTICE_ENCRYPTION_KEY']) {
    prev[key] = process.env[key];
  }
  process.env.LATTICE_CONFIG_DIR = join(scratch, 'config');
  mkdirSync(process.env.LATTICE_CONFIG_DIR, { recursive: true });
  // Every root this test touches lives under the scratch dir — the session root
  // included, so nothing can reach the machine's own home root.
  process.env.LATTICE_ROOT = join(scratch, 'session-root');
  process.env.LATTICE_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
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

describe('every symbol a doc imports from the package is exported by it', () => {
  const docsDir = resolve(import.meta.dirname, '../../docs');
  const files = readdirSync(docsDir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.md'));

  /** Runtime (non-type) names imported from the package across all guides. */
  const imported = new Map<string, string[]>();
  for (const file of files) {
    const src = readFileSync(join(docsDir, file), 'utf-8');
    const blocks = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*'latticesql'/g;
    let match: RegExpExecArray | null;
    while ((match = blocks.exec(src)) !== null) {
      if (match[1]) continue; // `import type` — erased, nothing to resolve at runtime
      for (const raw of (match[2] ?? '').split(',')) {
        const name = raw.replace(/\/\/.*$/gm, '').trim();
        if (name === '' || name.startsWith('type ')) continue;
        imported.set(name, [...(imported.get(name) ?? []), file]);
      }
    }
  }

  it('finds the import blocks', () => {
    // Guards the scan: an extraction that silently matched nothing would make
    // the per-symbol checks below vacuous.
    expect(imported.size).toBeGreaterThan(20);
    expect(imported.has('Lattice')).toBe(true);
  });

  it.each([...imported.keys()].sort())('exports %s', (name) => {
    expect(
      lattice,
      `imported by docs/${(imported.get(name) ?? []).join(', docs/')}`,
    ).toHaveProperty(name);
  });
});

describe('the session root an embedder resolves is the one a session opens', () => {
  it('exports the session-root resolver', () => {
    expect(typeof resolveSessionRoot).toBe('function');
  });

  it('honors an explicit root and LATTICE_ROOT', () => {
    const session = resolveSessionRoot();
    expect(session.root).toBe(join(scratch, 'session-root'));
    expect(session.source).toBe('env');
    expect(resolveSessionRoot({ explicitRoot: '/named' })).toMatchObject({
      root: '/named',
      source: 'explicit',
    });
  });

  it('is a different question from "which root owns this directory?"', () => {
    const elsewhere = join(scratch, 'a-project');
    mkdirSync(elsewhere, { recursive: true });
    // With no root named, the two answers genuinely diverge: a session serves the
    // home root, while the path question walks up from the directory it was
    // handed and otherwise proposes one beside it. `resolveLatticeRoot` is the
    // no-write half of `ensureLatticeRoot` — asserted here so the test cannot
    // leave a stray root anywhere on the machine.
    const saved = process.env.LATTICE_ROOT;
    delete process.env.LATTICE_ROOT;
    try {
      const session = resolveSessionRoot({ startDir: elsewhere });
      const owning = resolveLatticeRoot(elsewhere);

      expect(session.root).toBe(join(homedir(), '.lattice'));
      expect(session.source).toBe('home');
      expect(owning).toBe(join(elsewhere, '.lattice'));
      expect(owning).not.toBe(session.root);
    } finally {
      process.env.LATTICE_ROOT = saved;
    }
  });

  it('registers into the registry `Lattice.openWorkspace()` reads', async () => {
    const { root } = resolveSessionRoot();
    const ws = addWorkspace(root, { displayName: 'Research' });

    // No root argument — exactly what an app automating this workspace does.
    const db = await Lattice.openWorkspace();
    try {
      expect(getActiveWorkspace(root)?.id).toBe(ws.id);
      expect(db.getRegisteredTableNames().length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe('the documented member-invite flow can assert what its prose promises', () => {
  it('exports the scoped-role assertion the invite path runs', () => {
    // The invite prose promises the provisioned role is checked to be
    // non-privileged before its credentials are handed to anyone. The HTTP route
    // does exactly that; the library snippet could not, because the guard was not
    // exported. A caller building an invite by hand needs the same guard.
    expect(typeof lattice.assertScopedMemberRole).toBe('function');
  });
});
