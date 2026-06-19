import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { probeRunningGui } from '../../src/gui/probe-running.js';

// Root-cause regression for "curl … | sh crashed my browser". `lattice gui` was
// not a singleton: when a GUI was already on the port, the server's port-fallback
// silently started a SECOND instance on the next free port — its own browser tab,
// its own auto-update supervisor. Repeated launches piled up instances + tabs at
// drifting versions and crashed the browser. The fix makes `runGui` probe the
// port first (probeRunningGui) and reuse a running instance instead of duplicating.
//
// These tests pin the mechanism: (1) a running GUI is detected, a free port is
// not; (2) the duplicate-on-fallback behavior the singleton check now guards
// against is real (a second start on the same requested port binds a DIFFERENT
// port). runGui uses (1) to refuse to create (2).
const handles: GuiServerHandle[] = [];
const dirs: string[] = [];

function tempConfig(): { configPath: string; outputDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-singleton-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  const outputDir = join(dir, 'context');
  mkdirSync(outputDir, { recursive: true });
  const configPath = join(dir, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/app.db',
      'name: singleton-test',
      '',
      'entities:',
      '  items:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: items.md',
      '',
    ].join('\n'),
  );
  return { configPath, outputDir };
}

async function boot(port: number, version: string): Promise<GuiServerHandle> {
  const { configPath, outputDir } = tempConfig();
  const handle = await startGuiServer({
    configPath,
    outputDir,
    port,
    host: '127.0.0.1',
    teamCloud: false,
    openBrowser: false,
    version,
  });
  handles.push(handle);
  return handle;
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

afterEach(async () => {
  while (handles.length) await handles.pop()?.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('lattice gui singleton: detect a running instance instead of duplicating it', () => {
  it('probeRunningGui returns the version of a running GUI and null for a free port', async () => {
    const h = await boot(0, '7.7.7'); // port 0 → OS picks a free port
    const livePort = portOf(h.url);

    const found = await probeRunningGui(livePort);
    expect(found).not.toBeNull();
    expect(found?.version).toBe('7.7.7');

    // A port with nothing listening must read as "no Lattice GUI here".
    const freePort = livePort + 7;
    const none = await probeRunningGui(freePort, 500);
    expect(none).toBeNull();
  });

  it('a second GUI requesting the SAME port falls back to a different one (the duplicate the singleton check prevents)', async () => {
    const first = await boot(0, '1.0.0');
    const takenPort = portOf(first.url);

    // Without the runGui singleton guard, starting again on the SAME requested
    // port does NOT fail — it binds the next free port → a duplicate instance.
    const second = await boot(takenPort, '1.0.0');
    expect(portOf(second.url)).not.toBe(takenPort);

    // And the guard's input is satisfied: the original port is detectably a
    // running Lattice GUI, so runGui would reuse it rather than start `second`.
    const detected = await probeRunningGui(takenPort);
    expect(detected?.version).toBe('1.0.0');
  });
});
