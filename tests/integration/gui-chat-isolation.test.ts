/**
 * Local single-user chat back-compat.
 *
 * Per-member chat isolation on a team cloud is enforced by the chat routes'
 * owner filter (added in 2.2.1) wherever a team context is present. As of
 * 2.2.3 a member never reaches a cloud through a direct `postgres://`
 * connection — they go through a user-authenticated server and work on a
 * locally-synced mirror — so the old "two GUIs directly on the same cloud
 * Postgres" harness no longer models a real deployment and was retired. The
 * owner-filter logic stays exercised by the unit/route tests; this file keeps
 * the local (no team context) back-compat guarantee: NULL-owner chats stay
 * fully visible to the single local operator.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';

describe('chat (local single-user DB) — back-compat', () => {
  const localDirs: string[] = [];
  const localServers: GuiServerHandle[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    // Claude access is OAuth-only: the GET /api/chat/* thread routes sit behind
    // the server's AI-auth gate, which refuses them with 403 `claude_not_connected`
    // when no subscription is connected. Point the machine-local credential store
    // at an isolated config dir and seed a connected subscription so the gate lets
    // the read through. This test only reads persisted threads — no model call is
    // made — so seeding auth is all the gate needs. Seed AFTER
    // LATTICE_CONFIG_DIR/LATTICE_ENCRYPTION_KEY (the store is keyed off both).
    const cfgDir = mkdtempSync(join(tmpdir(), 'chat-local-cfg-'));
    localDirs.push(cfgDir);
    for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY']) {
      savedEnv[k] = process.env[k];
    }
    process.env.LATTICE_CONFIG_DIR = cfgDir;
    process.env.LATTICE_ENCRYPTION_KEY = 'chat-isolation-test-key';
    seedClaudeOAuth();
  });

  afterAll(async () => {
    for (const s of localServers.splice(0)) await s.close();
    for (const d of localDirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });

  it('NULL-owner threads stay visible when there is no team context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chat-local-'));
    localDirs.push(root);
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
        '    render: default-list',
        '    outputFile: notes.md',
      ].join('\n'),
    );
    const server = await startGuiServer({
      configPath,
      outputDir: join(root, 'context'),
      port: 0,
      openBrowser: false,
    });
    localServers.push(server);
    // Insert a thread with no owner (the local / pre-2.2.1 shape).
    await fetch(`${server.url}/api/tables/chat_threads/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'local-1', title: 'Local chat' }),
    });
    const list = (await fetch(`${server.url}/api/chat/threads`).then((r) => r.json())) as {
      threads: { id: string }[];
    };
    expect(list.threads.map((t) => t.id)).toContain('local-1');
  });
});
