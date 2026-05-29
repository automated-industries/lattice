import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// Wrap mkdirSync in a spy while delegating to the real implementation, so the
// relative-SQLite case still creates its data directory and the server boots.
// server.ts imports `mkdirSync` as a named binding, so mocking the module
// (rather than spying on a namespace object) is what actually intercepts it.
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync) };
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const mkdirSpy = vi.mocked(mkdirSync);

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-gui-mkdir-'));
  dirs.push(dir);
  return dir;
}

/** Write a minimal one-entity config whose `db:` is the given value. */
function writeConfig(dbValue: string): { configPath: string; outputDir: string } {
  const root = tempDir();
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      // Quote the value so connection strings / `:memory:` are valid YAML scalars.
      `db: ${JSON.stringify(dbValue)}`,
      '',
      'entities:',
      '  items:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '    outputFile: items.md',
    ].join('\n'),
  );
  return { configPath, outputDir: root };
}

/** Did mkdirSync ever get called with exactly this directory argument? */
function calledWithDir(dir: string): boolean {
  return mkdirSpy.mock.calls.some((call) => call[0] === dir);
}

beforeEach(() => {
  mkdirSpy.mockClear();
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openConfig mkdir guard', () => {
  it('creates the parent directory for a real SQLite file path', async () => {
    const { configPath, outputDir } = writeConfig('./data/test.db');
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const expectedDir = dirname(resolve(outputDir, 'data/test.db'));
    expect(calledWithDir(expectedDir)).toBe(true);
  });

  it('does NOT mkdir for a postgres:// connection string', async () => {
    const dbValue = 'postgres://localhost:5432/lattice_test';
    const { configPath, outputDir } = writeConfig(dbValue);
    // Boot fails (no reachable Postgres) — but the guard runs first, so the
    // dirname-of-URL mkdir that used to crash on Windows must never fire.
    try {
      const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
      servers.push(server);
    } catch {
      // expected — connection cannot be established in the test environment
    }
    expect(calledWithDir(dirname(dbValue))).toBe(false);
  });

  it('does NOT mkdir for a file: URL', async () => {
    const dbValue = 'file:./data/test.db';
    const { configPath, outputDir } = writeConfig(dbValue);
    try {
      const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
      servers.push(server);
    } catch {
      // boot outcome is irrelevant to the guard assertion
    }
    expect(calledWithDir(dirname(dbValue))).toBe(false);
  });

  it('does NOT mkdir for an in-memory database', async () => {
    const dbValue = ':memory:';
    const { configPath, outputDir } = writeConfig(dbValue);
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    // dirname(':memory:') === '.' — the old unconditional mkdir would target it.
    expect(calledWithDir(dirname(dbValue))).toBe(false);
  });
});
