import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end proof that the type-based auto-ingest actually wires into the chat turn:
 * a message carrying reference material is triaged, routed through the ingestion engine
 * (stubbed here), and the resulting "already saved" note is PREPENDED to the message the
 * model receives — so the model works with the saved item instead of re-creating it.
 * Without this the concat `attachedNote + ingestNote + message` is untested end-to-end.
 */

const state = vi.hoisted(() => ({ captured: [] as unknown[][] }));
const ingestTextSpy = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ id: 'f-auto', suggestedLinks: [] })),
);

vi.mock('../../src/gui/ai/chat.js', async (orig) => {
  const actual = await orig<typeof import('../../src/gui/ai/chat.js')>();
  return {
    ...actual,
    // Keep the real runChat; script only the model client.
    createAnthropicClient: () => ({
      runTurn(params: { onText: (s: string) => void; messages?: unknown[]; system?: string }) {
        // The reference-material TRIAGE pass runs first (its own runTurn). Message-aware:
        // report the fact as reference material only when the message actually contains
        // it, so the negative case (pure directive) is genuinely exercised.
        if (
          typeof params.system === 'string' &&
          params.system.includes('router for a personal knowledge base')
        ) {
          const seen = JSON.stringify(params.messages ?? []);
          const reference = seen.includes('Acme signed the renewal on Tuesday.')
            ? 'Acme signed the renewal on Tuesday.'
            : '';
          return Promise.resolve({
            stopReason: 'end_turn',
            text: '```json\n' + JSON.stringify({ reference }) + '\n```',
            toolUses: [],
          });
        }
        // The fast INTENT pass runs before the chat turn (off-FIFO, on the raw message).
        // Route to needs_work=true so the real chat turn runs — and do NOT capture it, so
        // `captured[0]` stays the CHAT turn (with the prepended ingest note under assert).
        if (typeof params.system === 'string' && params.system.includes('fast intake step')) {
          return Promise.resolve({
            stopReason: 'end_turn',
            text: '```json\n{"intent_summary":"scripted","ack_message":"Working on it…","needs_work":true,"needs_more_info":false}\n```',
            toolUses: [],
          });
        }
        // The chat turn: capture exactly what the model was handed, then answer trivially.
        state.captured.push(params.messages ?? []);
        params.onText('Noted.');
        return Promise.resolve({ stopReason: 'end_turn', text: 'Noted.', toolUses: [] });
      },
    }),
  };
});
// Stub the ingestion engine so this test proves the WIRING (triage → ingest → note →
// prepend), not the engine internals (covered by the enrich/ingest unit tests).
vi.mock('../../src/gui/ingest-routes.js', async (orig) => {
  const actual = await orig<typeof import('../../src/gui/ingest-routes.js')>();
  return { ...actual, ingestTextAsFile: ingestTextSpy };
});

import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';
import { runChatTurnOverStream } from './stream-helper.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-autoingest-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY']) savedEnv[k] = process.env[k];
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'autoingest-test-key';
  seedClaudeOAuth();
  state.captured = [];
  ingestTextSpy.mockClear();
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-autoingest-'));
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

describe('chat auto-ingest wiring (POST /api/chat)', () => {
  it('ingests reference material and PREPENDS the saved-item note to the model turn', async () => {
    const server = await boot();
    // Mixed message: a fact to save + a directive to act on. The turn runs as a background
    // job; resolve on its terminal `done` frame so the ingest + chat-turn capture are done.
    await runChatTurnOverStream(server.url, {
      message: 'Acme signed the renewal on Tuesday. Draft a thank-you note.',
    });

    // The engine was invoked with EXACTLY the reference span (not the directive).
    expect(ingestTextSpy).toHaveBeenCalledTimes(1);
    expect(ingestTextSpy.mock.calls[0]?.[1]).toBe('Acme signed the renewal on Tuesday.');

    // The chat turn (captured[0]) received the saved-item note prepended to the message.
    const chatTurnMessages = JSON.stringify(state.captured[0] ?? []);
    expect(chatTurnMessages).toContain('already been saved');
    // …and the user's real message still rides along after it.
    expect(chatTurnMessages).toContain('Draft a thank-you note.');
  });

  it('does NOT ingest or prepend a note when the message is a pure directive', async () => {
    const server = await boot();
    await runChatTurnOverStream(server.url, { message: 'What tickets are open?' });

    // Triage found nothing to save → the engine is never called and no note is injected.
    expect(ingestTextSpy).not.toHaveBeenCalled();
    const chatTurnMessages = JSON.stringify(state.captured[0] ?? []);
    expect(chatTurnMessages).not.toContain('already been saved');
    expect(chatTurnMessages).toContain('What tickets are open?');
  });
});
