import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig, disposeActive } from '../../src/gui/lifecycle.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import { runIngestCommand } from '../../src/cli-ingest.js';

/**
 * What `lattice ingest` tells the script that ran it.
 *
 * A document can LAND and still have failed at the only thing landing it was
 * for: nothing was read out of it, nothing was described, nothing was linked. The
 * row records that as an enrichment failure, and the command has one channel for
 * saying so — its exit code.
 *
 * The failure this pins is not that the code was missing everywhere. It is that
 * the guard existed on ONE branch: a file exited 1 and the identical failure
 * arriving on standard input, or from a web address, exited 0. So every branch is
 * exercised here against the same outcome, and they have to agree.
 *
 * The ingest engine itself is stubbed at exactly the two functions that land a
 * document, because the subject is the reporting decision, not the pipeline.
 */

const scripted = vi.hoisted(() => ({
  /** What the stubbed ingest should hand back. */
  result: {} as Record<string, unknown>,
}));

vi.mock('../../src/ops/ingest-file.js', async (orig) => {
  const actual = await orig<typeof import('../../src/ops/ingest-file.js')>();
  return {
    ...actual,
    ingestText: () => Promise.resolve(scripted.result),
    ingestPath: () => Promise.resolve(scripted.result),
  };
});

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-ingest-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY', 'LATTICE_SEED_WELCOME']) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'ingest-exit-key';
  process.env.LATTICE_SEED_WELCOME = '0';
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function openWorkspace(): Promise<{ active: ActiveDb; configPath: string }> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-ingest-ws-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      body: { type: text }',
      '    outputFile: notes.md',
      '',
    ].join('\n'),
  );
  return { active: await openConfig(configPath, join(root, 'context')), configPath };
}

/** One run of the command, with the workspace handed over already open. */
async function run(
  args: Parameters<typeof runIngestCommand>[0],
  active: ActiveDb,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runIngestCommand(args, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    open: () => Promise.resolve(active),
    readStdin: () => Promise.resolve('some notes worth keeping'),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('a document that landed but was not processed is not a success', () => {
  /** The three ways a single document reaches the command. */
  const branches: { name: string; args: Parameters<typeof runIngestCommand>[0] }[] = [
    {
      name: 'text on standard input',
      args: { stdin: true, config: 'x', explicitConfig: true, title: 'Notes' },
    },
    {
      name: 'a web address',
      args: { target: 'https://example.test/page', config: 'x', explicitConfig: true },
    },
  ];

  for (const branch of branches) {
    it(`reports a failed enrichment from ${branch.name}`, async () => {
      const { active, configPath } = await openWorkspace();
      scripted.result = {
        id: 'file-1',
        extraction_status: 'enrichment_failed',
        error: 'the provider refused',
      };
      try {
        const r = await run({ ...branch.args, config: configPath }, active);
        expect(r.code, 'a nightly job must not read this as a clean run').toBe(1);
        // And it says WHY, on the stream that is not the output.
        expect(r.err).toContain('the provider refused');
      } finally {
        await disposeActive(active);
      }
    });

    it(`reports a clean ingest from ${branch.name} as a success`, async () => {
      const { active, configPath } = await openWorkspace();
      scripted.result = { id: 'file-1', extraction_status: 'extracted', suggestedLinks: [] };
      try {
        const r = await run({ ...branch.args, config: configPath }, active);
        expect(r.code).toBe(0);
        expect(r.out).toContain('file-1');
      } finally {
        await disposeActive(active);
      }
    });
  }

  it('the file branch and the text branch agree about the same outcome', async () => {
    // The bug was a disagreement, so this is the assertion that would have caught
    // it: one outcome, two doors, one answer.
    const { active, configPath } = await openWorkspace();
    const file = join(dirs[dirs.length - 1]!, 'doc.txt');
    writeFileSync(file, 'hello');
    scripted.result = {
      id: 'file-1',
      extraction_status: 'enrichment_failed',
      error: 'the provider refused',
      suggestedLinks: [],
    };
    try {
      const fromFile = await run(
        { target: file, config: configPath, explicitConfig: true },
        active,
      );
      const fromStdin = await run(
        { stdin: true, config: configPath, explicitConfig: true },
        active,
      );
      expect(fromStdin.code).toBe(fromFile.code);
      expect(fromFile.code).toBe(1);
    } finally {
      await disposeActive(active);
    }
  });
});
