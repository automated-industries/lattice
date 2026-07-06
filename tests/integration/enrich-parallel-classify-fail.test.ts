import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Phase 1a (parallelized enrichment): the three per-file LLM calls now run
// concurrently, but a classify FAILURE must still preserve the prior semantics —
// the description (from the independent summarize call) is still saved, the
// "Couldn't auto-link" note is surfaced, and extract is SKIPPED (no entity/rows
// created), returning []. summarize succeeds, classify rejects, extract would
// have proposed an entity — which must NOT be created.
vi.mock('../../src/gui/ai/summarize.js', async (orig) => {
  const actual = await orig();
  return {
    ...(actual as object),
    summarizeText: () => Promise.resolve('a real summary'),
    classifyLinks: () => Promise.reject(new Error('classify boom')),
    extractObjects: () =>
      Promise.resolve([
        { entity: 'people', columns: ['name'], values: { name: 'X' }, label: 'X', confidence: 1 },
      ]),
  };
});

import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
  savedEnv.LATTICE_ENCRYPTION_KEY = process.env.LATTICE_ENCRYPTION_KEY;
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-enrich-cfg-'));
  dirs.push(cfgDir);
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'enrich-test-key';
  seedClaudeOAuth();
});
afterEach(async () => {
  if (savedEnv.LATTICE_CONFIG_DIR === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedEnv.LATTICE_CONFIG_DIR;
  if (savedEnv.LATTICE_ENCRYPTION_KEY === undefined) delete process.env.LATTICE_ENCRYPTION_KEY;
  else process.env.LATTICE_ENCRYPTION_KEY = savedEnv.LATTICE_ENCRYPTION_KEY;
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-enrich-'));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  projects:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: projects.md',
      '',
    ].join('\n'),
  );
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
  });
  servers.push(server);
  return server;
}

describe('parallel enrichment — classify failure preserves description + skips extract', () => {
  it('saves the description, surfaces the classify failure, and creates no extract entity', async () => {
    const server = await boot();
    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(' '));
    });

    const res = await fetch(`${server.url}/api/ingest/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Notes about the quarterly plan', title: 'memo' }),
    });
    const body = (await res.json()) as { id?: string };
    spy.mockRestore();
    expect(res.ok).toBe(true);
    expect(body.id).toBeTruthy();

    // The description (from the INDEPENDENT summarize call) is still saved even
    // though classify failed — this is the core parallelization invariant.
    const row = (await fetch(`${server.url}/api/tables/files/rows/${body.id}`).then((r) =>
      r.json(),
    )) as {
      description?: string;
    };
    expect(row.description).toBe('a real summary');

    // The classify failure was surfaced (not swallowed).
    expect(errs.some((m) => m.includes('[ingest]') && /classify failed/i.test(m))).toBe(true);

    // Extract was SKIPPED — the proposed 'people' entity must NOT exist (a classify
    // failure jumps past extract, exactly as the old sequential outer-catch did).
    const summary = (await fetch(`${server.url}/api/entities-summary`).then((r) => r.json())) as {
      tables?: { name: string }[];
    };
    expect((summary.tables ?? []).some((t) => t.name === 'people')).toBe(false);
  });
});
