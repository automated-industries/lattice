import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The assistant can CREATE tables + relationships on request. This drives the
 * real POST /api/chat tool loop (real dispatcher + real server primitives —
 * createUserEntity / createUserJunction, no DB reopen) with a scripted model,
 * reproducing "create projects from tickets and link them": create_entity →
 * create_relationship → create_row → link. Only the Anthropic round-trip is
 * mocked; everything else is the production path.
 */

interface ScriptedTurn {
  text: string;
  toolUses?: { id: string; name: string; input: Record<string, unknown> }[];
}

const turnState = vi.hoisted(() => ({ turns: [] as ScriptedTurn[] }));

vi.mock('../../src/gui/ai/chat.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    // Keep the real runChat; replace only the model client with a scripted one.
    createAnthropicClient: () => {
      let i = 0;
      return {
        runTurn(params: { onText: (s: string) => void }) {
          const turn = turnState.turns[Math.min(i, turnState.turns.length - 1)] ?? { text: '' };
          i++;
          params.onText(turn.text);
          return Promise.resolve({
            stopReason: turn.toolUses?.length ? 'tool_use' : 'end_turn',
            text: turn.text,
            toolUses: turn.toolUses ?? [],
          });
        },
      };
    },
  };
});

import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-chatschema-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY', 'ANTHROPIC_API_KEY']) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'chatschema-test-key';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake'; // resolves auth; client is mocked
  turnState.turns = [];
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-chatschema-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  tickets:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      key: { type: text }',
      '      summary: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: tickets.md',
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

describe('assistant schema creation via POST /api/chat', () => {
  it('creates a projects table from tickets, relates them, and links a row', async () => {
    const server = await boot();
    // Seed a ticket to link to.
    await fetch(`${server.url}/api/tables/tickets/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'tk1', key: 'AIR-331', summary: 'Legal AI Training' }),
    });

    // Scripted tool plan: build the table + relationship, then a row + link.
    turnState.turns = [
      {
        text: 'Creating a projects table and relating it to tickets.',
        toolUses: [
          {
            id: 'u1',
            name: 'create_entity',
            input: { name: 'projects', columns: ['title', 'status'] },
          },
          {
            id: 'u2',
            name: 'create_relationship',
            input: { table_a: 'projects', table_b: 'tickets' },
          },
        ],
      },
      {
        text: 'Adding the project and linking it to the ticket.',
        toolUses: [
          {
            id: 'u3',
            name: 'create_row',
            input: { table: 'projects', values: { id: 'pr1', title: 'Legal AI Training' } },
          },
          {
            id: 'u4',
            name: 'link',
            input: { table: 'projects_tickets', values: { projects_id: 'pr1', tickets_id: 'tk1' } },
          },
        ],
      },
      { text: 'Done — created projects and linked it to tickets.' },
    ];

    // Drive the chat to completion (reading the body drains the SSE stream).
    const res = await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Go through and create projects from tickets and link them',
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    // The new table exists (created live, no reopen)…
    const ents = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: { name: string }[];
    };
    const names = ents.tables.map((t) => t.name);
    expect(names).toContain('projects');
    expect(names).toContain('projects_tickets');

    // …with the project row…
    const projects = (await fetch(`${server.url}/api/tables/projects/rows`).then((r) =>
      r.json(),
    )) as { rows: Record<string, unknown>[] };
    expect(projects.rows).toHaveLength(1);
    expect(projects.rows[0]).toMatchObject({ title: 'Legal AI Training' });

    // …linked to the ticket via the auto-created junction.
    const links = (await fetch(`${server.url}/api/tables/projects_tickets/rows`).then((r) =>
      r.json(),
    )) as { rows: Record<string, unknown>[] };
    expect(links.rows).toHaveLength(1);
    expect(links.rows[0]).toMatchObject({ projects_id: 'pr1', tickets_id: 'tk1' });

    // Schema mutations are revertible — recorded in the audit/version history.
    const hist = (await fetch(`${server.url}/api/history?limit=50`).then((r) => r.json())) as {
      entries: { operation: string; table_name: string }[];
    };
    expect(
      hist.entries.some(
        (e) => e.operation === 'schema.create_entity' && e.table_name === 'projects',
      ),
    ).toBe(true);
    expect(
      hist.entries.some(
        (e) => e.operation === 'schema.create_junction' && e.table_name === 'projects_tickets',
      ),
    ).toBe(true);
  });
});
