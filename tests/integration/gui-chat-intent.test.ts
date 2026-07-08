import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The elektra-style intent pass (Stage 4) runs a fast structured call the instant a turn
 * is accepted, THEN routes: a trivial/general message is answered inline (the tool loop is
 * skipped), an ambiguous one gets a clarifying question, and anything needing the
 * workspace data publishes a contextual `ack` and runs the real loop. This drives the real
 * async route (202 + chat-progress over the WebSocket) with a scripted model so both the
 * intent classification and the chat turn are deterministic.
 */

const script = vi.hoisted(() => ({
  // The intent pass's JSON body (returned inside a ```json fence).
  intent: '{"intent_summary":"x","ack_message":"On it…","needs_work":true,"needs_more_info":false}',
  // What the scripted CHAT turn replies (only reached when needs_work routes to the loop).
  chatReply: 'Here is your answer.',
  chatCalls: 0,
}));

vi.mock('../../src/gui/ai/chat.js', async (orig) => {
  const actual = await orig<typeof import('../../src/gui/ai/chat.js')>();
  return {
    ...actual,
    createAnthropicClient: () => ({
      runTurn(params: { onText: (s: string) => void; system?: string }) {
        const sys = typeof params.system === 'string' ? params.system : '';
        // Reference-material triage → nothing to save.
        if (sys.includes('router for a personal knowledge base')) {
          return Promise.resolve({
            stopReason: 'end_turn',
            text: '```json\n{"reference":""}\n```',
            toolUses: [],
          });
        }
        // The fast intent pass.
        if (sys.includes('fast intake step')) {
          return Promise.resolve({
            stopReason: 'end_turn',
            text: '```json\n' + script.intent + '\n```',
            toolUses: [],
          });
        }
        // The post-loop thread-title generation (a new thread gets an AI title) — a
        // separate call; answer it without counting it as a chat turn.
        if (sys.includes('specific title')) {
          return Promise.resolve({ stopReason: 'end_turn', text: 'Notes Count', toolUses: [] });
        }
        // The chat turn (only reached on the needs_work path).
        script.chatCalls++;
        params.onText(script.chatReply);
        return Promise.resolve({ stopReason: 'end_turn', text: script.chatReply, toolUses: [] });
      },
    }),
  };
});

import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';
import { runChatTurnOverStream } from './stream-helper.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-chatintent-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY']) savedEnv[k] = process.env[k];
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'chatintent-test-key';
  seedClaudeOAuth();
  script.intent =
    '{"intent_summary":"x","ack_message":"On it…","needs_work":true,"needs_more_info":false}';
  script.chatReply = 'Here is your answer.';
  script.chatCalls = 0;
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-chatintent-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
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
      '    outputFile: notes.md',
      '',
    ].join('\n'),
  );
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    host: '127.0.0.1',
    teamCloud: false,
    openBrowser: false,
  });
  servers.push(server);
  return server;
}

const types = (events: Record<string, unknown>[]): string[] => events.map((e) => String(e.type));
const textOf = (events: Record<string, unknown>[]): string =>
  events
    .filter((e) => e.type === 'text_delta')
    .map((e) => (e as { delta: string }).delta)
    .join('');

describe('intent orchestrator', () => {
  it('answers a trivial/general message INLINE — no tool loop', async () => {
    script.intent =
      '{"intent_summary":"greeting","ack_message":"Hi! I help you explore your data.","needs_work":false,"needs_more_info":false}';
    const s = await boot();
    const { events } = await runChatTurnOverStream(s.url, { message: 'hello' });
    // The inline answer streams as the assistant reply and the turn ends — the scripted
    // chat loop is never entered.
    expect(textOf(events)).toContain('Hi! I help you explore your data.');
    expect(types(events)).toContain('done');
    expect(types(events)).not.toContain('tool_use');
    expect(script.chatCalls).toBe(0);
  });

  it('asks a clarifying question INLINE when the request is ambiguous — no tool loop', async () => {
    script.intent =
      '{"intent_summary":"ambiguous","ack_message":"Which project did you mean?","needs_work":false,"needs_more_info":true}';
    const s = await boot();
    const { events } = await runChatTurnOverStream(s.url, { message: 'update it' });
    expect(textOf(events)).toContain('Which project did you mean?');
    expect(script.chatCalls).toBe(0);
  });

  it('publishes a contextual ack and runs the loop when the request needs data work', async () => {
    script.intent =
      '{"intent_summary":"count","ack_message":"Counting your notes…","needs_work":true,"needs_more_info":false}';
    const s = await boot();
    const { events } = await runChatTurnOverStream(s.url, { message: 'how many notes do I have?' });
    // The ack rides its own event; then the scripted loop produces the answer.
    const ack = events.find((e) => e.type === 'ack');
    expect(ack && (ack as { message: string }).message).toBe('Counting your notes…');
    expect(textOf(events)).toContain('Here is your answer.');
    expect(script.chatCalls).toBe(1);
  });

  it('inline answer is recoverable — persisted as the final assistant message', async () => {
    script.intent =
      '{"intent_summary":"greeting","ack_message":"Hello there!","needs_work":false,"needs_more_info":false}';
    const s = await boot();
    const { threadId } = await runChatTurnOverStream(s.url, { message: 'hi' });
    const replay = (await fetch(`${s.url}/api/chat/threads/${threadId}/messages`).then((r) =>
      r.json(),
    )) as {
      messages: { role: string; text: string; status?: string }[];
    };
    const assistant = replay.messages.find((m) => m.role === 'assistant');
    expect(assistant?.text).toBe('Hello there!');
    expect(assistant?.status).toBe('done');
  });
});
