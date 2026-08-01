import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readModelStatus,
  connectModelEndpoint,
  disconnectModelEndpoint,
  selectModelProvider,
  testModelProvider,
  setAssistantApiKey,
  clearAssistantApiKey,
  disconnectClaudeSubscription,
  CLAUDE_OAUTH_KIND,
} from '../../src/ops/ai-config.js';
import { transcribeRecording, filenameForMimeType } from '../../src/ops/voice.js';
import { modelErrorCode } from '../../src/ops/model-errors.js';
import { runModelCommand, formatModelStatus } from '../../src/cli-model.js';
import { readOpenAiCompatConfig, activeProviderKind } from '../../src/gui/ai/provider-config.js';
import { getAssistantCredential, setAssistantCredential } from '../../src/framework/user-config.js';

/**
 * Pointing a machine at a model, with no browser.
 *
 * The claim under test is not "a command exists". It is that the operation
 * itself — connect, choose, save a key, clear one, disconnect, transcribe — is
 * reachable as a call, does the whole job (including the verify-and-revert that
 * makes an unattended connect safe), and REFUSES the same things it refuses
 * through a request handler. A managed deployment must not be configurable from
 * here either; a capability that enforced its refusals only in the route would be
 * a bypass, not a capability.
 *
 * Everything runs against a throwaway credential directory, so nothing here can
 * see or touch the machine's real configuration. The only stub is the model
 * client boundary — the one seam that would otherwise reach the network.
 */

const scripted = vi.hoisted(() => ({
  /** What `resolveLlmProvider` should hand back. `null` = nothing configured. */
  provider: null as unknown,
  /** What a smoke test should report. */
  smoke: { ok: true } as { ok: true } | { ok: false; error: string },
}));

vi.mock('../../src/gui/ai/provider.js', async (orig) => {
  const actual = await orig<typeof import('../../src/gui/ai/provider.js')>();
  return {
    ...actual,
    resolveLlmProvider: () => Promise.resolve(scripted.provider),
    smokeTestProvider: () => Promise.resolve(scripted.smoke),
  };
});

const scriptedVoice = vi.hoisted(() => ({
  text: 'transcribed text',
  fail: null as string | null,
  seen: [] as { filename: string; provider: string }[],
}));

vi.mock('../../src/gui/ai/transcribe.js', () => ({
  transcribe: (opts: { provider: string; filename: string }) => {
    scriptedVoice.seen.push({ filename: opts.filename, provider: opts.provider });
    if (scriptedVoice.fail !== null) return Promise.reject(new Error(scriptedVoice.fail));
    return Promise.resolve(scriptedVoice.text);
  },
}));

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-model-cfg-'));
  dirs.push(cfgDir);
  for (const k of [
    'LATTICE_CONFIG_DIR',
    'LATTICE_ENCRYPTION_KEY',
    'LATTICE_MANAGED_MODEL_AUTH',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'ELEVENLABS_API_KEY',
    'LATTICE_ACCOUNT_URL',
  ]) {
    savedEnv[k] = process.env[k];
    Reflect.deleteProperty(process.env, k);
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'model-test-key';
  scripted.provider = null;
  scripted.smoke = { ok: true };
  scriptedVoice.text = 'transcribed text';
  scriptedVoice.fail = null;
  scriptedVoice.seen = [];
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The tagged code on a call that should have been refused. */
async function refusal(run: () => unknown): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (e) {
    const code = modelErrorCode(e);
    return { code: code ?? `UNTAGGED(${(e as Error).message})`, message: (e as Error).message };
  }
  throw new Error('expected a refusal, but the call succeeded');
}

describe('reading how this machine reaches a model', () => {
  it('reports a fresh machine as connected to nothing', async () => {
    const status = await readModelStatus(null);
    expect(status.connected).toBe(false);
    expect(status.activeProvider).toBe('anthropic');
    expect(status.claudeAuthKind).toBeNull();
    expect(status.openaiCompat).toEqual({ configured: false, model: null, baseUrl: null });
    expect(status.latticeCloud).toEqual({ configured: false });
    // Nothing was asked for, so nothing is "unavailable" — the distinction the
    // client depends on to avoid printing an unread balance as zero.
    expect(status.balanceCents).toBeNull();
    expect(status.balanceUnavailable).toBe(false);
  });

  it('never reports a stored value back, only that one exists', async () => {
    await connectModelEndpoint(null, {
      baseUrl: 'https://api.example.com',
      model: 'gpt-4o',
      apiKey: 'sk-secret-value',
    });
    const status = await readModelStatus(null);
    expect(status.openaiCompat).toEqual({
      configured: true,
      model: 'gpt-4o',
      baseUrl: 'https://api.example.com',
    });
    expect(JSON.stringify(status)).not.toContain('sk-secret-value');
  });
});

describe('connecting an endpoint', () => {
  it('refuses a URL that is not http(s), and a missing model', async () => {
    expect(
      (await refusal(() => connectModelEndpoint(null, { baseUrl: 'ftp://x', model: 'm' }))).code,
    ).toBe('invalid_request');
    expect(
      (await refusal(() => connectModelEndpoint(null, { baseUrl: 'https://x.dev', model: '  ' })))
        .code,
    ).toBe('invalid_request');
    expect(readOpenAiCompatConfig(), 'nothing was stored by a refused connect').toBeNull();
  });

  it('stores the endpoint and makes it active', async () => {
    const result = await connectModelEndpoint(null, {
      baseUrl: '  https://api.example.com  ',
      model: ' gpt-4o ',
      apiKey: 'sk-1',
    });
    expect(result).toEqual({
      ok: true,
      activeProvider: 'openai_compat',
      model: 'gpt-4o',
      baseUrl: 'https://api.example.com',
    });
    expect(activeProviderKind()).toBe('openai_compat');
    expect(readOpenAiCompatConfig()?.apiKey).toBe('sk-1');
  });

  it('a blank key on a re-connect keeps the key already stored', async () => {
    await connectModelEndpoint(null, {
      baseUrl: 'https://api.example.com',
      model: 'gpt-4o',
      apiKey: 'sk-original',
    });
    // The settings screen never shows a key back, so an empty field is not a
    // request to clear it.
    await connectModelEndpoint(null, {
      baseUrl: 'https://api.example.com',
      model: 'gpt-4o-mini',
      apiKey: '',
    });
    expect(readOpenAiCompatConfig()).toMatchObject({ model: 'gpt-4o-mini', apiKey: 'sk-original' });
  });

  it('puts the working configuration back when a verified connect fails', async () => {
    await connectModelEndpoint(null, {
      baseUrl: 'https://good.example.com',
      model: 'good-model',
      apiKey: 'sk-good',
    });
    scripted.provider = { client: {} };
    scripted.smoke = { ok: false, error: 'connection refused' };

    const result = await connectModelEndpoint(null, {
      baseUrl: 'https://bad.example.com',
      model: 'bad-model',
      apiKey: 'sk-bad',
      test: true,
    });

    expect(result).toEqual({ ok: false, error: 'connection refused' });
    expect(
      readOpenAiCompatConfig(),
      'a bad edit must never replace a working configuration',
    ).toMatchObject({ baseUrl: 'https://good.example.com', model: 'good-model' });
  });

  it('leaves nothing behind when the FIRST connect fails its check', async () => {
    scripted.provider = { client: {} };
    scripted.smoke = { ok: false, error: 'no answer' };
    const result = await connectModelEndpoint(null, {
      baseUrl: 'https://bad.example.com',
      model: 'bad-model',
      test: true,
    });
    expect(result).toEqual({ ok: false, error: 'no answer' });
    expect(readOpenAiCompatConfig(), 'there was no prior config to put back').toBeNull();
    expect(activeProviderKind()).toBe('anthropic');
  });

  it('forgetting the endpoint falls back to Claude', async () => {
    await connectModelEndpoint(null, { baseUrl: 'https://api.example.com', model: 'gpt-4o' });
    expect(disconnectModelEndpoint()).toBe('anthropic');
    expect(readOpenAiCompatConfig()).toBeNull();
    expect(activeProviderKind()).toBe('anthropic');
  });
});

describe('choosing which backend answers', () => {
  it('refuses a kind that is not a selectable backend', async () => {
    expect((await refusal(() => selectModelProvider('gemini'))).code).toBe('invalid_request');
  });

  it('refuses a backend that has nothing stored, rather than stranding the assistant', async () => {
    const { code, message } = await refusal(() => selectModelProvider('openai_compat'));
    expect(code).toBe('provider_not_configured');
    expect(message).toContain('no OpenAI-compatible endpoint is configured');
  });

  it('switches between configured backends without disconnecting either', async () => {
    await connectModelEndpoint(null, { baseUrl: 'https://api.example.com', model: 'gpt-4o' });
    expect(selectModelProvider('anthropic')).toBe('anthropic');
    expect(readOpenAiCompatConfig(), 'switching away does not forget it').not.toBeNull();
    expect(selectModelProvider('openai_compat')).toBe('openai_compat');
  });
});

describe('testing the active backend', () => {
  it('says so when nothing is configured, rather than throwing', async () => {
    scripted.provider = null;
    expect(await testModelProvider(null)).toEqual({
      ok: false,
      error: 'No model provider is configured.',
    });
  });

  it('reports the reason a configured backend did not answer', async () => {
    scripted.provider = { client: {} };
    scripted.smoke = { ok: false, error: 'HTTP 502' };
    expect(await testModelProvider(null)).toEqual({ ok: false, error: 'HTTP 502' });
  });
});

describe('speech credentials', () => {
  it('refuses Claude as a pasted key, and an unknown credential name', async () => {
    expect((await refusal(() => setAssistantApiKey(null, 'anthropic', 'sk-x'))).code).toBe(
      'invalid_request',
    );
    expect((await refusal(() => setAssistantApiKey(null, 'gemini', 'sk-x'))).code).toBe(
      'invalid_request',
    );
    expect((await refusal(() => setAssistantApiKey(null, 'openai', '   '))).code).toBe(
      'invalid_request',
    );
  });

  it('saves a key and reports it present', async () => {
    await setAssistantApiKey(null, 'openai', ' sk-voice ');
    const status = await readModelStatus(null);
    expect(status.hasOpenaiKey).toBe(true);
    expect(status.hasVoiceKey).toBe(true);
    expect(status.sttProvider).toBe('openai');
  });

  it('a cleared key STAYS cleared even with the environment variable set', async () => {
    await setAssistantApiKey(null, 'openai', 'sk-voice');
    await clearAssistantApiKey(null, 'openai');
    // The environment fallback would otherwise resurrect it on the next read,
    // which is what "cleared" has to survive to mean anything.
    process.env.OPENAI_API_KEY = 'sk-from-env';
    expect((await readModelStatus(null)).hasOpenaiKey).toBe(false);
  });
});

describe('disconnecting a subscription', () => {
  it('forgets the stored token', async () => {
    setAssistantCredential(CLAUDE_OAUTH_KIND, JSON.stringify({ access_token: 'tok' }));
    expect((await readModelStatus(null)).claudeAuthKind).toBe('oauth');
    disconnectClaudeSubscription();
    expect(getAssistantCredential(CLAUDE_OAUTH_KIND)).toBeNull();
    expect((await readModelStatus(null)).connected).toBe(false);
  });
});

describe('a managed deployment cannot be reconfigured from here', () => {
  beforeEach(() => {
    process.env.LATTICE_MANAGED_MODEL_AUTH = '1';
  });

  it('refuses every per-user write, in the capability and not only in the route', async () => {
    for (const run of [
      () => connectModelEndpoint(null, { baseUrl: 'https://x.dev', model: 'm' }),
      () => selectModelProvider('anthropic'),
      () => setAssistantApiKey(null, 'openai', 'sk-x'),
      () => clearAssistantApiKey(null, 'openai'),
    ]) {
      expect((await refusal(run)).code).toBe('managed_model_auth');
    }
  });
});

describe('turning a recording into text', () => {
  it('names the upload after the container the bytes are in', () => {
    expect(filenameForMimeType('audio/webm')).toBe('audio.webm');
    expect(filenameForMimeType('audio/mp4')).toBe('audio.m4a');
    expect(filenameForMimeType('audio/wav')).toBe('audio.wav');
  });

  it('refuses when the machine has no speech credential at all', async () => {
    const { code, message } = await refusal(() =>
      transcribeRecording(null, { audio: new Uint8Array([1, 2, 3]) }),
    );
    expect(code).toBe('no_voice_key');
    expect(message).toContain('No voice key configured');
  });

  it('transcribes bytes — no upload, no request', async () => {
    await setAssistantApiKey(null, 'openai', 'sk-voice');
    const text = await transcribeRecording(null, {
      audio: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/mp4',
    });
    expect(text).toBe('transcribed text');
    expect(scriptedVoice.seen).toEqual([{ filename: 'audio.m4a', provider: 'openai' }]);
  });

  it('separates an empty recording from a service that refused', async () => {
    await setAssistantApiKey(null, 'openai', 'sk-voice');
    expect((await refusal(() => transcribeRecording(null, { audio: new Uint8Array() }))).code).toBe(
      'invalid_request',
    );

    scriptedVoice.fail = 'rate limited';
    const failed = await refusal(() => transcribeRecording(null, { audio: new Uint8Array([1]) }));
    expect(failed.code).toBe('transcription_failed');
    expect(failed.message, 'the reason survives, never swallowed').toBe('rate limited');
  });
});

describe('the command wrapper, pointed at a real workspace', () => {
  /**
   * A workspace on disk, opened by the command's OWN opener.
   *
   * No `open` seam is injected anywhere in this block, and that is the point. The
   * command used to construct the workspace without opening it, so every verb
   * that reaches the `secrets` table died at the first query — on any machine
   * that had a workspace at all, which is most of them. A stubbed opener would
   * have hidden that exactly as thoroughly as never passing a workspace did, and
   * for the same reason: it is the real opener that was wrong.
   */
  function workspaceOnDisk(): string {
    const root = mkdtempSync(join(tmpdir(), 'lattice-model-ws-'));
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
    return configPath;
  }

  it('reads the status of a machine that has a workspace', async () => {
    const configPath = workspaceOnDisk();
    const lines = await runModelCommand({ subcommand: 'status', configPath });
    expect(lines[0]).toBe('Model: NOT connected');
  });

  it('saves a key against a workspace, and says so only because it really landed', async () => {
    const configPath = workspaceOnDisk();
    // The failure this replaces was the worst shape a write can take: the
    // machine-local half landed, the workspace half threw, and the command
    // reported failure — so the key was on disk and the operator was told it was
    // not. Both halves have to run before the success line is printed.
    expect(
      await runModelCommand({ subcommand: 'key', action: 'openai', token: 'sk-abc', configPath }),
    ).toEqual(['Saved the openai key.']);
    expect(getAssistantCredential('openai_api_key')).toBe('sk-abc');

    expect(
      await runModelCommand({ subcommand: 'key', action: 'openai', revoke: true, configPath }),
    ).toEqual(['Cleared the openai key.']);
    expect(getAssistantCredential('openai_api_key')).toBeNull();
  });

  it('tests the active backend against a workspace', async () => {
    const configPath = workspaceOnDisk();
    scripted.provider = { client: {} };
    scripted.smoke = { ok: true };
    expect(await runModelCommand({ subcommand: 'test', configPath })).toEqual([
      'The model answered.',
    ]);
  });

  it('closes the workspace it opened', async () => {
    const configPath = workspaceOnDisk();
    let opened: { closed: boolean } | null = null;
    await runModelCommand({
      subcommand: 'status',
      configPath,
      open: async (p) => {
        const { openConfiguredLattice } = await import('../../src/cli-open.js');
        const db = await openConfiguredLattice({ config: p });
        await db.init();
        const original = db.close.bind(db);
        opened = { closed: false };
        db.close = () => {
          opened = { closed: true };
          original();
        };
        return db;
      },
    });
    expect(opened, 'a command that never closes holds the database past its own exit').toEqual({
      closed: true,
    });
  });

  it('closes the workspace even when the verb refuses', async () => {
    const configPath = workspaceOnDisk();
    process.env.LATTICE_MANAGED_MODEL_AUTH = '1';
    let closed = false;
    await expect(
      runModelCommand({
        subcommand: 'key',
        action: 'openai',
        token: 'sk-abc',
        configPath,
        open: async (p) => {
          const { openConfiguredLattice } = await import('../../src/cli-open.js');
          const db = await openConfiguredLattice({ config: p });
          await db.init();
          const original = db.close.bind(db);
          db.close = () => {
            closed = true;
            original();
          };
          return db;
        },
      }),
    ).rejects.toThrow();
    expect(closed).toBe(true);
  });
});

describe('the command wrapper', () => {
  it('reports status without a workspace, because the settings are the machine', async () => {
    const lines = await runModelCommand({ subcommand: 'status' });
    expect(lines[0]).toBe('Model: NOT connected');
    expect(lines.join('\n')).toContain('Claude subscription: not connected');
  });

  it('emits the whole status as JSON when asked', async () => {
    const [json] = await runModelCommand({ subcommand: 'status', json: true });
    expect(JSON.parse(json ?? '{}')).toMatchObject({
      connected: false,
      activeProvider: 'anthropic',
    });
  });

  it('refuses --json on a verb that changes something', async () => {
    await expect(
      runModelCommand({ subcommand: 'use', action: 'anthropic', json: true }),
    ).rejects.toThrow(/--json applies to/);
  });

  it('refuses a verb it does not have, naming the ones it does', async () => {
    await expect(runModelCommand({ subcommand: 'enable' })).rejects.toThrow(
      /Unknown model subcommand: enable/,
    );
  });

  it('always verifies a connect, and changes nothing when the endpoint is silent', async () => {
    scripted.provider = { client: {} };
    scripted.smoke = { ok: false, error: 'timed out' };
    await expect(
      runModelCommand({
        subcommand: 'connect',
        baseUrl: 'https://api.example.com',
        model: 'gpt-4o',
      }),
    ).rejects.toThrow(/timed out/);
    expect(
      readOpenAiCompatConfig(),
      'a command that failed must not leave the machine configured',
    ).toBeNull();
  });

  it('connects when the endpoint answers', async () => {
    scripted.provider = { client: {} };
    scripted.smoke = { ok: true };
    const lines = await runModelCommand({
      subcommand: 'connect',
      baseUrl: 'https://api.example.com',
      model: 'gpt-4o',
      keyStdin: true,
      readStdin: () => Promise.resolve('sk-piped\n'),
    });
    expect(lines[0]).toContain('Connected gpt-4o at https://api.example.com');
    expect(readOpenAiCompatConfig()?.apiKey, 'the key came from stdin, not argv').toBe('sk-piped');
  });

  it('saves and clears a speech key', async () => {
    expect(
      await runModelCommand({
        subcommand: 'key',
        action: 'openai',
        keyStdin: true,
        readStdin: () => Promise.resolve('sk-voice'),
      }),
    ).toEqual(['Saved the openai key.']);
    expect((await readModelStatus(null)).hasOpenaiKey).toBe(true);

    expect(await runModelCommand({ subcommand: 'key', action: 'openai', revoke: true })).toEqual([
      'Cleared the openai key.',
    ]);
    expect((await readModelStatus(null)).hasOpenaiKey).toBe(false);
  });

  it('will not save a key nobody supplied', async () => {
    await expect(runModelCommand({ subcommand: 'key', action: 'openai' })).rejects.toThrow(
      /No key given/,
    );
  });

  it('forgets what it is told to forget', async () => {
    await connectModelEndpoint(null, { baseUrl: 'https://api.example.com', model: 'gpt-4o' });
    expect(await runModelCommand({ subcommand: 'disconnect', action: 'endpoint' })).toEqual([
      'Forgot the OpenAI-compatible endpoint. Turns fall back to Claude.',
    ]);
    expect(readOpenAiCompatConfig()).toBeNull();
    await expect(
      runModelCommand({ subcommand: 'disconnect', action: 'everything' }),
    ).rejects.toThrow(/endpoint\|account\|subscription/);
  });

  it('says out loud when a balance could not be read, instead of showing zero', () => {
    const lines = formatModelStatus({
      ...({} as never),
      connected: true,
      activeProvider: 'lattice_cloud',
      claudeAuthKind: null,
      openaiCompat: { configured: false, model: null, baseUrl: null },
      latticeCloud: { configured: true },
      modelAccessBlocked: null,
      limitState: null,
      authWarning: null,
      managedModelAuth: false,
      balanceCents: null,
      balanceUnavailable: true,
      hasVoiceKey: false,
      sttProvider: null,
      voiceMode: 'local',
    });
    expect(lines.join('\n')).toContain('could not be read (this is not the same as zero)');
  });
});
