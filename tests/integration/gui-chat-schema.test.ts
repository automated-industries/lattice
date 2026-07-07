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

const turnState = vi.hoisted(() => ({
  turns: [] as ScriptedTurn[],
  // Each runTurn's `messages` array, in call order — lets a test assert what
  // prior-turn context the server fed the model (cross-turn rehydration).
  captured: [] as unknown[][],
}));

vi.mock('../../src/gui/ai/chat.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    // Keep the real runChat; replace only the model client with a scripted one.
    createAnthropicClient: () => {
      let i = 0;
      return {
        runTurn(params: { onText: (s: string) => void; messages?: unknown[]; system?: string }) {
          // The chat route runs a reference-material TRIAGE pass (its own runTurn) BEFORE
          // the chat turn. Answer it with "nothing to ingest" so it doesn't consume a
          // scripted chat turn — these tests script the CHAT turns, not the triage.
          if (
            typeof params.system === 'string' &&
            params.system.includes('router for a personal knowledge base')
          ) {
            return Promise.resolve({
              stopReason: 'end_turn',
              text: '```json\n{"reference":""}\n```',
              toolUses: [],
            });
          }
          turnState.captured.push(params.messages ?? []);
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
import { seedClaudeOAuth } from '../helpers/claude-auth.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-chatschema-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY']) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'chatschema-test-key';
  // Claude access is OAuth-only: seed a connected subscription so the server's
  // AI-auth gate and the chat route's auth check pass. Seeded AFTER
  // LATTICE_CONFIG_DIR/LATTICE_ENCRYPTION_KEY (the machine-local store is keyed
  // off the config dir + master key). The Anthropic client is mocked above, so
  // the token never reaches a real endpoint.
  seedClaudeOAuth();
  turnState.turns = [];
  turnState.captured = [];
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function boot(autoRender = false): Promise<GuiServerHandle> {
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
    autoRender,
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

  it('adds a column to an existing table on request, then stores a value in it', async () => {
    const server = await boot();
    await fetch(`${server.url}/api/tables/tickets/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'tk1', key: 'AIR-1', summary: 'first' }),
    });

    turnState.turns = [
      {
        text: 'Adding a priority field and setting it.',
        toolUses: [
          { id: 'u1', name: 'add_column', input: { table: 'tickets', column: 'priority' } },
          {
            id: 'u2',
            name: 'update_row',
            input: { table: 'tickets', id: 'tk1', values: { priority: 'high' } },
          },
        ],
      },
      { text: 'Done — added the priority field and set it to high.' },
    ];

    const res = await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'add a priority field to tickets and set tk1 to high' }),
    });
    expect(res.status).toBe(200);
    await res.text();

    // The column was added live (no reopen) and the value persisted to it.
    const rows = (await fetch(`${server.url}/api/tables/tickets/rows`).then((r) => r.json())) as {
      rows: Record<string, unknown>[];
    };
    expect(rows.rows[0]).toMatchObject({ id: 'tk1', priority: 'high' });

    // The schema change is recorded in version history (revertible).
    const hist = (await fetch(`${server.url}/api/history?limit=50`).then((r) => r.json())) as {
      entries: { operation: string; table_name: string }[];
    };
    expect(
      hist.entries.some((e) => e.operation === 'schema.add_column' && e.table_name === 'tickets'),
    ).toBe(true);
  });

  it('persists rich per-turn structure (text + tool pills) for reload', async () => {
    const server = await boot();
    turnState.turns = [
      {
        text: 'Let me list the tables.',
        toolUses: [{ id: 'u1', name: 'list_entities', input: {} }],
      },
      { text: 'There is a tickets table.' },
    ];
    const res = await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'what tables exist?' }),
    });
    const threadId = res.headers.get('x-thread-id');
    await res.text();
    expect(threadId).toBeTruthy();

    // The reloaded conversation carries the structure, not just flattened text:
    // the assistant message has per-turn entries with the tool pills it fired.
    const replay = (await fetch(`${server.url}/api/chat/threads/${threadId}/messages`).then((r) =>
      r.json(),
    )) as {
      messages: {
        role: string;
        text: string;
        turns?: { text: string; tools: { name: string; isError: boolean }[] }[];
      }[];
    };
    const assistant = replay.messages.find((m) => m.role === 'assistant');
    expect(assistant?.turns?.length).toBeGreaterThan(0);
    const toolNames = (assistant?.turns ?? []).flatMap((t) => t.tools.map((x) => x.name));
    expect(toolNames).toContain('list_entities');
    expect(assistant?.text).toContain('There is a tickets table.');
  });

  it('rehydrates a prior turn’s tool result (row id) into the next turn’s model context', async () => {
    const server = await boot();
    // Seed a generic record to read. (tickets is the config's stock table — no
    // personal data anywhere in this test.)
    await fetch(`${server.url}/api/tables/tickets/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'tk1', key: 'AIR-1', summary: 'Stock record' }),
    });

    // Turn 1 (new thread): the model lists the table, then answers.
    turnState.turns = [
      {
        text: 'Listing.',
        toolUses: [{ id: 'u1', name: 'list_rows', input: { table: 'tickets' } }],
      },
      { text: 'Here is record tk1.' },
    ];
    const r1 = await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'list the tickets' }),
    });
    const threadId = r1.headers.get('x-thread-id');
    await r1.text();
    expect(threadId).toBeTruthy();

    // Turn 2 (same thread): a single text turn. The server must rebuild the
    // prior tool_use/tool_result blocks from the thread so the model sees tk1.
    turnState.captured = []; // ignore turn-1's calls; capture only turn-2's
    turnState.turns = [{ text: 'The id is tk1.' }];
    await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'what is the id?', threadId }),
    }).then((r) => r.text());

    // The messages the model received on turn 2 carry turn 1's row id, as a real
    // tool_result block — rehydrated server-side, NOT from the text-only client
    // history (this request sent no history at all).
    const turn2Messages = JSON.stringify(turnState.captured[turnState.captured.length - 1] ?? []);
    expect(turn2Messages).toContain('tk1');
    expect(turn2Messages).toContain('tool_result');

    // The GUI reload, by contrast, must NOT receive the raw tool result content —
    // toolCalls is stripped; only text + pill names survive.
    const replay = await fetch(`${server.url}/api/chat/threads/${threadId}/messages`).then((r) =>
      r.json(),
    );
    const replayStr = JSON.stringify(replay);
    expect(replayStr).not.toContain('toolCalls');
    expect(replayStr).not.toContain('tool_result');
  });

  it('renders a chat-created entity automatically in workspace mode (no reopen)', async () => {
    const server = await boot(true); // workspace mode: autoRender on
    turnState.turns = [
      {
        text: 'Creating a people table.',
        toolUses: [
          { id: 'u1', name: 'create_entity', input: { name: 'people', columns: ['name', 'role'] } },
          {
            id: 'u2',
            name: 'create_row',
            input: { table: 'people', values: { id: 'pe1', name: 'Jarrod Wolf', role: 'Eng' } },
          },
        ],
      },
      { text: 'Done — created people and added a person.' },
    ];

    const res = await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'create a people object' }),
    });
    expect(res.status).toBe(200);
    await res.text();

    // Auto-render is debounced; give it a beat to flush after the insert.
    await new Promise((r) => setTimeout(r, 500));

    // The runtime-created entity has a rendered per-row context — the canonical
    // context was registered inline at creation (no reopen), so the row view no
    // longer shows "No rendered context for this row".
    const ctx = (await fetch(`${server.url}/api/tables/people/rows/pe1/context`).then((r) =>
      r.json(),
    )) as { files: { name: string }[] };
    expect(ctx.files.length).toBeGreaterThan(0);
    expect(ctx.files.some((f) => /PERSON\.md|PEOPLE\.md|CONTEXT\.md/i.test(f.name))).toBe(true);
  });

  it('refreshes an EXISTING table’s context when a relationship is added (no reopen)', async () => {
    const server = await boot(true); // workspace mode
    await fetch(`${server.url}/api/tables/tickets/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'tk1', key: 'AIR-1', summary: 'x' }),
    });
    turnState.turns = [
      {
        text: 'Creating projects and linking to tickets.',
        toolUses: [
          { id: 'u1', name: 'create_entity', input: { name: 'projects', columns: ['title'] } },
          {
            id: 'u2',
            name: 'create_row',
            input: { table: 'projects', values: { id: 'pr1', title: 'P1' } },
          },
          {
            id: 'u3',
            name: 'create_relationship',
            input: { table_a: 'projects', table_b: 'tickets' },
          },
          {
            id: 'u4',
            name: 'link',
            input: { table: 'projects_tickets', values: { projects_id: 'pr1', tickets_id: 'tk1' } },
          },
        ],
      },
      { text: 'Done.' },
    ];
    await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'link projects to tickets' }),
    }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 600));

    // `tickets` already existed (and had a canonical context) before the
    // relationship. Without the redefine-on-junction fix its rollup would only
    // appear after a reopen; now the linked-junction rollup renders inline.
    const ctx = (await fetch(`${server.url}/api/tables/tickets/rows/tk1/context`).then((r) =>
      r.json(),
    )) as { files: { name: string }[] };
    expect(ctx.files.some((f) => /PROJECTS/i.test(f.name))).toBe(true);
  });

  it('a first message gives the new thread an AI title, replacing the raw-message placeholder', async () => {
    const server = await boot();
    // ensureThread seeds the title to the truncated first message; after the reply the
    // server generates a friendly title (generateThreadTitle) and updates the thread —
    // AFTER the stream closes. The scripted client returns this on the title call too
    // (a fresh client each createAnthropicClient call restarts at turn 0).
    turnState.turns = [{ text: 'Company Overview' }];
    const res = await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'tell me about my company' }),
    });
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE stream (res.end) — the title lands shortly after

    // The title is written post-close, so poll the conversation list until it flips
    // from the placeholder to the AI title (this is exactly the timing the feed-event
    // signal covers on the client).
    let title = 'tell me about my company';
    for (let i = 0; i < 60 && title !== 'Company Overview'; i++) {
      const list = (await fetch(`${server.url}/api/chat/threads`).then((r) => r.json())) as {
        threads: { title: string }[];
      };
      title = list.threads[0]?.title ?? title;
      if (title === 'Company Overview') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // The friendly summary replaced the verbatim first message.
    expect(title).toBe('Company Overview');
    expect(title).not.toBe('tell me about my company');
  });
});
