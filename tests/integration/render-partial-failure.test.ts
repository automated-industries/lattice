import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/index.js';
import { manifestPath } from '../../src/lifecycle/manifest.js';
import * as writerModule from '../../src/render/writer.js';

/**
 * PARTIAL-FAILURE: never a silent divergence.
 *
 * FAIL-FIRST on the pre-fix code, GREEN after. The discriminating assertions are:
 *   B1 — a write failure pre-empted by the writability probe leaves ZERO new
 *        live files from the failing render on disk (pre-commit clean throw). On
 *        the pre-fix code the probe is never invoked, so phase-1 partially writes
 *        the new row's files before the manifest commit — that "zero new live
 *        files" assertion fails.
 *   B2 — an auto-render that hits a write failure surfaces a host-visible error
 *        carrying an actionable disk-full message, and the committed manifest is
 *        still the prior one (cleanup did not prune against a failed render).
 *
 * Failure is injected via `vi.spyOn` on the writer module (NOT chmod — chmod
 * 0o555 is inert when the process runs as root, which CI containers commonly do).
 */

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeDb(base: string): Lattice {
  const db = new Lattice(join(base, 'db.sqlite'));
  db.define('agents', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', role: 'TEXT' },
    render: () => '',
    outputFile: '.schema-only/agents.md',
  });
  db.defineEntityContext('agents', {
    slug: (r) => String(r.name),
    files: {
      'AGENT.md': {
        source: { type: 'self' },
        render: ([r]) => `# ${String(r?.name)}\n\nRole: ${String(r?.role)}\n`,
      },
    },
  });
  return db;
}

function enospc(): NodeJS.ErrnoException {
  const e = new Error('no space left on device') as NodeJS.ErrnoException;
  e.code = 'ENOSPC';
  return e;
}

describe('render partial-failure: never silent divergence', () => {
  it('B1: a write failure is pre-empted pre-commit — prior manifest kept, no new live file written', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-pf-b1-'));
    dirs.push(base);
    const db = makeDb(base);
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'alpha', role: 'eng' });
    await db.insert('agents', { id: 'a2', name: 'beta', role: 'qa' });

    const out = join(base, 'ctx');
    // First render establishes the prior manifest + tree (alpha, beta).
    await db.render(out);
    const priorManifest = readFileSync(manifestPath(out), 'utf8');
    expect(priorManifest).toContain('alpha');
    expect(priorManifest).toContain('beta');
    expect(priorManifest).not.toContain('gamma');

    // Mutate the DB to add gamma — the next render would write gamma's files.
    await db.insert('agents', { id: 'a3', name: 'gamma', role: 'pm' });

    // Inject a disk-full at the writability probe. On the fixed code this is the
    // first thing render() does (before any live byte). On the pre-fix code the
    // probe is never invoked, so the render proceeds and writes gamma's files.
    vi.spyOn(writerModule, 'probeDirWritable').mockImplementation(() => {
      throw enospc();
    });

    await expect(db.render(out)).rejects.toThrow();

    // (a) The committed manifest is byte-identical to the prior one (no gamma).
    const afterManifest = readFileSync(manifestPath(out), 'utf8');
    expect(afterManifest).toBe(priorManifest);

    // (b) DISCRIMINATOR — NO new live file from the failing render was written.
    // gamma's entity dir must not exist; the on-disk tree reflects ONLY prior state.
    const gammaFile = join(out, 'agents', 'gamma', 'AGENT.md');
    expect(existsSync(gammaFile)).toBe(false);
    expect(existsSync(join(out, 'agents', 'gamma'))).toBe(false);

    db.close();
  });

  it('B2: an auto-render write failure surfaces loudly to on(error) and leaves the prior manifest', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-pf-b2-'));
    dirs.push(base);
    const db = makeDb(base);
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'alpha', role: 'eng' });

    const out = join(base, 'ctx');
    // Establish the prior manifest + tree (alpha) up front.
    await db.render(out);
    const priorManifest = readFileSync(manifestPath(out), 'utf8');
    expect(priorManifest).toContain('alpha');

    // Wire the host error channel; resolve a promise when the failure surfaces.
    let resolveErr!: (e: Error) => void;
    const errored = new Promise<Error>((res) => {
      resolveErr = res;
    });
    db.on('error', (e: Error) => {
      resolveErr(e);
    });

    // Inject the disk-full at the probe seam, then drive the debounced auto-render.
    vi.spyOn(writerModule, 'probeDirWritable').mockImplementation(() => {
      throw enospc();
    });

    db.enableAutoRender(out, { debounceMs: 0 });
    // A mutation schedules the (0ms-debounced) auto-render deterministically; we
    // await the host error handler firing rather than a nonexistent flush.
    await db.insert('agents', { id: 'a2', name: 'beta', role: 'qa' });

    const err = await Promise.race([
      errored,
      new Promise<Error>((_, rej) => {
        setTimeout(() => {
          rej(new Error('auto-render error did not surface within 5s'));
        }, 5000);
      }),
    ]);

    // The error reached the host handler with an actionable disk-full message.
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe('ENOSPC');
    expect(err.message.toLowerCase()).toContain('render write failed');

    // The committed manifest is still the prior (alpha-only) one — cleanup did
    // not run/prune against a failed render.
    const afterManifest = readFileSync(manifestPath(out), 'utf8');
    expect(afterManifest).toBe(priorManifest);
    expect(afterManifest).not.toContain('beta');

    db.disableAutoRender();
    db.close();
  });
});
