import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * Live round-trip against the real Anthropic API. Skipped unless BOTH
 * ANTHROPIC_API_KEY is set AND LATTICE_LIVE_LLM=1 — so CI (and any env that
 * merely has a key lying around) never spends tokens by accident.
 *
 *   set -a; source <env-with-key>; set +a; LATTICE_LIVE_LLM=1 \
 *     npx vitest run tests/integration/gui-chat-live.test.ts
 */
const LIVE = Boolean(process.env.ANTHROPIC_API_KEY) && process.env.LATTICE_LIVE_LLM === '1';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeConfig(): { configPath: string; outputDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-chat-live-'));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  people:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '    render: default-list',
      '    outputFile: people.md',
      '',
    ].join('\n'),
  );
  return { configPath, outputDir: join(root, 'context') };
}

async function readSse(res: Response, timeoutMs = 45000): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  for (;;) {
    if (Date.now() > deadline) throw new Error('SSE read timed out');
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const json = line.slice('data:'.length).trim();
      if (json) {
        try {
          events.push(JSON.parse(json) as Record<string, unknown>);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return events;
}

describe('chat live round-trip', () => {
  (LIVE ? it : it.skip)(
    'responds and can use a tool against the live API',
    async () => {
      const { configPath, outputDir } = writeConfig();
      const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
      servers.push(server);

      // Seed a row so a tool call has something to find.
      const seed = await fetch(`${server.url}/api/tables/people/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada Lovelace' }),
      });
      expect(seed.status).toBe(201);

      const res = await fetch(`${server.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: 'Use the list_rows tool on the "people" table, then tell me the names you find.',
        }),
      });
      expect(res.ok).toBe(true);

      const events = await readSse(res);
      const types = events.map((e) => e.type);
      // Stream completed cleanly.
      expect(types[types.length - 1]).toBe('done');
      expect(types).not.toContain('error');
      // The model produced text.
      expect(types).toContain('text_delta');
      // It used the tool we asked for, and the result was not an error.
      const toolUse = events.find((e) => e.type === 'tool_use');
      expect(toolUse).toBeDefined();
      expect((toolUse as { name: string }).name).toBe('list_rows');
      const toolResult = events.find((e) => e.type === 'tool_result');
      expect((toolResult as { isError: boolean }).isError).toBe(false);

      // The streamed answer should mention the seeded name.
      const answer = events
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e as { delta: string }).delta)
        .join('');
      expect(answer.toLowerCase()).toContain('ada');
    },
    60000,
  );
});
