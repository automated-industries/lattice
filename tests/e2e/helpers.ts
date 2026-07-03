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
export async function bootGui(opts: { yaml?: string; version?: string } = {}): Promise<BootedGui> {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-e2e-'));
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-e2e-home-'));
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  // Isolate the workspace-registry ROOT too. A lattice install exports
  // LATTICE_ROOT pointing at the real ~/.lattice, and root resolution treats it
  // as an always-wins override — so on a dev machine the booted GUI would READ
  // the developer's real workspace list and the workspace-lifecycle specs would
  // WRITE their throwaway workspaces (Alpha/Beta/…) into the real registry.json.
  // A fresh per-boot root keeps every spec hermetic (CI is unaffected either way).
  const rootDir = join(cfgDir, '.lattice');
  mkdirSync(join(rootDir, '.config'), { recursive: true });
  process.env.LATTICE_ROOT = rootDir;
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
    // Optional: stamp a version so the page's version chip (and the reconnect
    // version check) are exercised; defaults to empty (the prior behavior).
    ...(opts.version ? { version: opts.version } : {}),
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
