import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * An extraction the engine REFUSES to write (it aimed at a read-only projection
 * or a connected mirror) must reach the caller, not just the server console.
 * Otherwise the upload reports a clean ingest while content was silently lost —
 * the user is told everything landed when it did not.
 *
 * The subtle part this pins: the enricher returns its matches as an ARRAY that
 * also carries a `dropped` property. `JSON.stringify` omits non-index
 * properties of an array, so simply forwarding the enrich result serializes the
 * links and silently discards `dropped`. The route has to lift it onto a plain
 * field. This test fails if that lift is removed.
 */
vi.mock('../../src/gui/ai/enrich.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    // Mirror the real return shape exactly: an array of matches with `dropped`
    // hung off it as a non-index property.
    enrichWithLlm: () =>
      Promise.resolve(
        Object.assign([], {
          dropped: [
            {
              table: 'external_items',
              reason: 'read-only mirror table refuses row writes',
              label: 'Acme Corp',
            },
          ],
        }),
      ),
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
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-drop-cfg-'));
  dirs.push(cfgDir);
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'drop-test-key';
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-drop-'));
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

describe('ingest surfaces refused extractions to the caller', () => {
  it('reports dropped extractions in the ingest response body', async () => {
    const server = await boot();

    const res = await fetch(`${server.url}/api/ingest/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'A note mentioning Acme Corp', title: 'memo' }),
    });
    const body = (await res.json()) as {
      id?: string;
      dropped?: { table?: string; reason?: string; label?: string }[];
    };

    // The file still ingests — a refused extraction is a PARTIAL result, not a
    // failed upload.
    expect(res.ok).toBe(true);
    expect(body.id).toBeTruthy();

    // ...and the refusal is reported rather than swallowed.
    expect(body.dropped ?? []).toHaveLength(1);
    expect(body.dropped?.[0]).toMatchObject({ table: 'external_items' });
  });
});
