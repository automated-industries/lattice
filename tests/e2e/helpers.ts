import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

export interface BootedGui {
  url: string;
  dir: string;
  configPath: string;
  outputDir: string;
  close: () => Promise<void>;
}

const DEFAULT_YAML = [
  'db: ./data/app.db',
  'name: e2e',
  '',
  'entities:',
  '  items:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      name: { type: text }',
  '      deleted_at: { type: text }',
  '    outputFile: items.md',
  '',
].join('\n');

/**
 * Boot an isolated GUI server on an ephemeral port against a fresh temp config.
 * Each call gets its own ~/.lattice dir + encryption key so specs never share
 * credentials or saved databases. Call `close()` (return value) in afterEach.
 */
export async function bootGui(opts: { yaml?: string } = {}): Promise<BootedGui> {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-e2e-'));
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-e2e-home-'));
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'e2e-test-key';
  mkdirSync(join(dir, 'data'), { recursive: true });
  const outputDir = join(dir, 'context');
  mkdirSync(outputDir, { recursive: true });
  const configPath = join(dir, 'lattice.config.yml');
  writeFileSync(configPath, opts.yaml ?? DEFAULT_YAML);

  const handle: GuiServerHandle = await startGuiServer({
    configPath,
    outputDir,
    port: 0,
    host: '127.0.0.1',
    teamCloud: false,
    openBrowser: false,
  });

  return {
    url: handle.url,
    dir,
    configPath,
    outputDir,
    close: async () => {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cfgDir, { recursive: true, force: true });
    },
  };
}

/** Insert a row through the same HTTP path the UI uses. Returns the created row. */
export async function createRow(
  base: string,
  table: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/tables/${table}/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`createRow ${table} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}
