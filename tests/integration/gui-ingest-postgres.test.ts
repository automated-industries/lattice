/**
 * Postgres parity for the AI ingest → auto-junction → link loop.
 *
 * The Context Constructor's writes all go through the adapter-agnostic mutation
 * primitives, and createFileJunction creates the junction with portable DDL
 * (`CREATE TABLE … TEXT`) + defineLate. This test proves that whole path works
 * against a real Postgres-backed lattice, not just SQLite.
 *
 * How to run locally:
 *   LATTICE_TEST_PG_URL=postgres://... npm test
 * Without the env var it skips; CI provides a postgres:16 service container.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

// A unique entity name per run so parallel CI runs against the shared database
// don't collide. vi.hoisted shares it with the (hoisted) mock factory.
const { ENTITY } = vi.hoisted(() => ({
  ENTITY: 'aiproj_' + Math.random().toString(36).slice(2, 8),
}));

vi.mock('../../src/gui/ai/chat.js', async (orig) => {
  const actual = await orig();
  return { ...actual, createAnthropicClient: () => ({}) };
});
vi.mock('../../src/gui/ai/summarize.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    summarizeText: () => Promise.resolve('a deterministic summary'),
    classifyLinks: () => Promise.resolve([{ table: ENTITY, id: 'proj-1' }]),
  };
});

import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
// Claude access is OAuth-only: the server's AI-auth gate refuses /api/ingest/*
// unless a Claude subscription is connected. Auth is a fake OAuth token in the
// machine-local credential store, seeded per-test (below) — NOT ANTHROPIC_API_KEY,
// which no longer authenticates.
import { seedClaudeOAuth } from '../helpers/claude-auth.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

// The credential store is keyed off LATTICE_CONFIG_DIR, so point it at an isolated
// per-test dir before seeding, and scrub any stray ANTHROPIC_API_KEY so nothing
// else can silently authenticate.
const authEnvKeys = ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY', 'ANTHROPIC_API_KEY'] as const;
const savedAuthEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'gui-pg-ingest-cfg-'));
  dirs.push(cfgDir);
  for (const k of authEnvKeys) savedAuthEnv[k] = process.env[k];
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'gui-pg-ingest-auth-key';
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedAuthEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

describe.skipIf(!PG_URL)('AI ingest auto-junction — Postgres parity', () => {
  it('creates + links the files↔entity junction on a Postgres-backed lattice', async () => {
    // Satisfy the AI-auth gate on /api/ingest/*: seed a connected Claude
    // subscription into the isolated machine store set up in beforeEach. The model
    // client + summarize/classify leaves are mocked above, so this only makes
    // resolveClaudeAuth() return a token — no real network call happens.
    seedClaudeOAuth();
    const runId = randomBytes(4).toString('hex');
    const root = mkdtempSync(join(tmpdir(), `gui-pg-ingest-${runId}-`));
    dirs.push(root);
    const configPath = join(root, 'lattice.config.yml');
    writeFileSync(
      configPath,
      [
        `db: ${PG_URL!}`,
        '',
        'entities:',
        `  ${ENTITY}:`,
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      title: { type: text }',
        '      deleted_at: { type: text }',
        `    outputFile: ${ENTITY}.md`,
      ].join('\n'),
    );
    mkdirSync(join(root, 'context'), { recursive: true });
    const server = await startGuiServer({
      configPath,
      outputDir: join(root, 'context'),
      port: 0,
      openBrowser: false,
    });
    servers.push(server);

    await fetch(`${server.url}/api/tables/${ENTITY}/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'proj-1', title: 'Quarterly plan' }),
    });
    await fetch(`${server.url}/api/assistant/aggressiveness`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0.9 }),
    });

    await fetch(`${server.url}/api/ingest/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Notes about the quarterly plan', title: 'memo' }),
    });

    const links = (await fetch(`${server.url}/api/tables/files_${ENTITY}/rows`).then((r) =>
      r.json(),
    )) as { rows: Record<string, unknown>[] };
    expect(links.rows).toHaveLength(1);
    expect(links.rows[0]).toMatchObject({ [`${ENTITY}_id`]: 'proj-1' });
  });
});
