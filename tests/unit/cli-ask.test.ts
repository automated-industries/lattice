import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig, disposeActive } from '../../src/gui/lifecycle.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import type { LlmClient, TurnParams, TurnResult } from '../../src/gui/ai/chat.js';
import type { ResolvedProvider } from '../../src/gui/ai/provider.js';
import { runAssistantTurn, assistantTurnErrorCode } from '../../src/ops/assistant-turn.js';
import {
  runAskCommand,
  askWorkspace,
  askFailureMessage,
  commandLineSessionId,
} from '../../src/cli-ask.js';
import { undoGroup } from '../../src/gui/mutations.js';
import { FeedBus } from '../../src/gui/feed.js';

/**
 * `lattice ask` — the assistant with no browser.
 *
 * The claim under test is not "a command exists". It is that the SAME turn runs:
 * the model gets the workspace's real schema, the tools it calls really execute,
 * a change it makes is audited and reversible as ONE action afterwards, and a
 * machine with no model connected is told so and fails rather than printing
 * nothing and exiting zero.
 *
 * The model is stubbed at the client boundary — the one seam between the turn and
 * the network — so every layer below it (the dispatcher, the mutation chokepoint,
 * the audit log) is the real one. No test here reaches a real endpoint.
 */

/**
 * What the command should resolve as the machine's model provider. `undefined`
 * means "ask the real resolver" — which, against an isolated config dir, is a
 * machine with nothing connected.
 */
const scripted = vi.hoisted(() => ({ provider: undefined as unknown }));
vi.mock('../../src/gui/ai/provider.js', async (orig) => {
  const actual = await orig<typeof import('../../src/gui/ai/provider.js')>();
  return {
    ...actual,
    resolveLlmProvider: async (db: Parameters<typeof actual.resolveLlmProvider>[0]) =>
      scripted.provider === undefined
        ? await actual.resolveLlmProvider(db)
        : (scripted.provider as Awaited<ReturnType<typeof actual.resolveLlmProvider>>),
  };
});

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-ask-cfg-'));
  dirs.push(cfgDir);
  for (const k of [
    'LATTICE_CONFIG_DIR',
    'LATTICE_ENCRYPTION_KEY',
    'LATTICE_CHAT_AUTOINGEST',
    'LATTICE_SEED_WELCOME',
    'LATTICE_USER_EMAIL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
  ]) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'ask-test-key';
  // The pre-pass that saves reference material out of a message runs a model call
  // of its own. These turns are about the loop, not the pre-pass, so it is off.
  process.env.LATTICE_CHAT_AUTOINGEST = 'false';
  process.env.LATTICE_SEED_WELCOME = '0';
  // No ambient credential may grant the assistant auth.
  delete process.env.ANTHROPIC_API_KEY;
  scripted.provider = undefined;
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

/** A workspace on disk with one table, opened the way every other caller opens one. */
async function openWorkspace(): Promise<{ active: ActiveDb; configPath: string }> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-ask-ws-'));
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
  const active = await openConfig(configPath, join(root, 'context'));
  return { active, configPath };
}

/** One scripted model reply: some text, and the tools to ask for alongside it. */
interface ScriptedTurn {
  text: string;
  toolUses?: { id: string; name: string; input: Record<string, unknown> }[];
}

/**
 * A model client that replays a fixed script, one entry per round, and records
 * the system prompt it was given so a test can prove the real schema reached it.
 */
function scriptedClient(script: ScriptedTurn[]): LlmClient & { systems: string[] } {
  const systems: string[] = [];
  let round = 0;
  return {
    systems,
    runTurn(params: TurnParams): Promise<TurnResult> {
      systems.push(params.system);
      const turn = script[Math.min(round, script.length - 1)];
      round += 1;
      const toolUses = turn?.toolUses ?? [];
      for (const ch of turn?.text ?? '') params.onText(ch);
      return Promise.resolve({
        stopReason: toolUses.length > 0 ? 'tool_use' : 'end_turn',
        text: turn?.text ?? '',
        toolUses,
      });
    },
  };
}

function provider(client: LlmClient): ResolvedProvider {
  return { client, kind: 'anthropic', authorModel: 'stub-model', noteError: () => 'other' };
}

describe('the assistant runs a full turn with no server', () => {
  it('answers from a read tool it actually ran', async () => {
    const { active } = await openWorkspace();
    await active.db.insert('notes', { body: 'the quarterly plan' });
    const client = scriptedClient([
      { text: 'Let me look.', toolUses: [{ id: 't1', name: 'list_entities', input: {} }] },
      { text: 'You have one table: notes, with 1 row.' },
    ]);
    try {
      const result = await runAssistantTurn(
        { ...askWorkspace(active, 'test-session'), provider: provider(client) },
        { message: 'what tables do I have?' },
      );

      expect(result.ok).toBe(true);
      expect(result.text).toContain('notes');
      expect(result.tools.map((t) => t.name)).toEqual(['list_entities']);
      expect(result.tools[0]?.ok).toBe(true);
      // The turn is not a wrapper around a model call: the model was handed this
      // workspace's real schema, so the answer is about real tables.
      expect(client.systems[0]).toContain('notes');
    } finally {
      await disposeActive(active);
    }
  });

  it('makes a change that is reversible as ONE action afterwards', async () => {
    const { active } = await openWorkspace();
    const client = scriptedClient([
      {
        text: 'Adding it.',
        toolUses: [
          {
            id: 't1',
            name: 'create_row',
            input: { table: 'notes', values: { body: 'written by the assistant' } },
          },
        ],
      },
      { text: 'Added.' },
    ]);
    try {
      const result = await runAssistantTurn(
        { ...askWorkspace(active, 'test-session'), provider: provider(client) },
        { message: 'add a note saying written by the assistant' },
      );
      expect(result.ok).toBe(true);
      expect(result.tools.map((t) => t.name)).toEqual(['create_row']);

      const written = (await active.db.query('notes', {})) as Record<string, unknown>[];
      expect(written).toHaveLength(1);

      // Every audit entry the tool call wrote shares ONE operation-group id, so
      // the whole change is undone as a single action — the property that makes a
      // headless turn as safe to run as a click.
      const audit = (await active.db.query('_lattice_gui_audit', {})) as Record<string, unknown>[];
      const groups = new Set(audit.map((a) => String(a.op_group)));
      expect(groups.size, 'one tool call is one operation group').toBe(1);
      const group = [...groups][0] ?? '';

      const undone = await undoGroup(
        {
          db: active.db,
          feed: new FeedBus(),
          softDeletable: active.softDeletable,
          source: 'gui',
          sessionId: 'test-session',
        },
        group,
      );
      expect(undone.ok, JSON.stringify(undone)).toBe(true);
      expect(await active.db.query('notes', {})).toHaveLength(0);
    } finally {
      await disposeActive(active);
    }
  });

  it('still refuses a wide permanent removal — the gate is not relaxed off the browser', async () => {
    const { active } = await openWorkspace();
    // Past the bound a single small change stays under, and asked for in the form
    // that drops the records outright rather than sending them to the trash.
    for (let i = 0; i < 201; i++) await active.db.insert('notes', { body: `row ${String(i)}` });
    const client = scriptedClient([
      {
        text: 'Removing it.',
        toolUses: [
          {
            id: 't1',
            name: 'delete_entity',
            input: { name: 'notes', resolution: 'delete_data' },
          },
        ],
      },
      { text: 'I cannot do that one for you.' },
    ]);
    try {
      const result = await runAssistantTurn(
        { ...askWorkspace(active, 'test-session'), provider: provider(client) },
        { message: 'delete the notes table and everything in it' },
      );

      expect(result.tools[0]?.ok, 'the call was refused, not run').toBe(false);
      expect(await active.db.count('notes'), 'nothing was removed').toBe(201);
      // And the model is told, in the tool result, that nothing it can say changes it.
      const toldTheModel = client.systems.length;
      expect(toldTheModel).toBeGreaterThan(1);
    } finally {
      await disposeActive(active);
    }
  });

  it('refuses before doing anything when no model is connected, and says how to connect one', async () => {
    const { active } = await openWorkspace();
    try {
      // No provider injected and nothing configured in the isolated config dir,
      // so this is exactly the state of a machine that has never connected one.
      const thrown = await runAssistantTurn(askWorkspace(active, 'test-session'), {
        message: 'anything at all',
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(assistantTurnErrorCode(thrown)).toBe('no_model_connected');
      const message = (thrown as Error).message;
      // Actionable: it must name a way to connect one, not merely report the lack.
      expect(message).toMatch(/Claude|OpenAI-compatible|Lattice Cloud/);
      // And the way it names has to be a COMMAND. This is the first thing a fresh
      // machine says, and the machine most likely to read it has no display — so
      // sending the reader to a browser is not an instruction, it is a dead end.
      expect(message).toContain('lattice model subscription');
      expect(message).toContain('lattice model connect');
      expect(message).toContain('lattice model account');
      expect(message, 'never send a headless operator to a browser').not.toContain('lattice gui');
    } finally {
      await disposeActive(active);
    }
  });

  it('attributes writes to a session that survives the process, so a later command can undo them', () => {
    // Every invocation is a fresh process. A per-process random id would make each
    // turn's writes unreachable by the next command — the exact headless gap this
    // surface closes — so the id is stable for this operator's command line.
    expect(commandLineSessionId()).toBe(commandLineSessionId());
    expect(commandLineSessionId().startsWith('cli:')).toBe(true);
  });

  it('the session a write is attributed to cannot be produced by asserting an identity', () => {
    // This string IS the authorship gate: undo, redo and group-revert only touch
    // entries carrying the caller's own session. Spelling it out of the identity
    // would mean a second member on a shared workspace could set the identity
    // environment variable to a colleague's address and walk back their work — so
    // what a caller merely SAYS about themselves must not be enough to reproduce
    // one, and two machines that have said nothing at all must not collide.
    const machineOne = process.env.LATTICE_CONFIG_DIR!;
    const machineTwo = mkdtempSync(join(tmpdir(), 'lattice-ask-cfg2-'));
    dirs.push(machineTwo);
    const sessionOn = (configDir: string, email?: string): string => {
      process.env.LATTICE_CONFIG_DIR = configDir;
      if (email === undefined) delete process.env.LATTICE_USER_EMAIL;
      else process.env.LATTICE_USER_EMAIL = email;
      return commandLineSessionId();
    };

    const alice = sessionOn(machineOne, 'alice@example.test');
    expect(alice, 'the identity must not be readable back out of it').not.toContain(
      'alice@example.test',
    );
    // Same machine, a different asserted identity: still two sessions, as before.
    expect(sessionOn(machineOne, 'bob@example.test')).not.toBe(alice);
    // A SECOND machine asserting ALICE'S identity. Nothing about it is Alice's
    // except the name she was given, so it must not reproduce her session.
    expect(sessionOn(machineTwo, 'alice@example.test'), 'a spoofed identity').not.toBe(alice);
    // And two machines that have configured no identity at all must still differ —
    // otherwise the zero-effort case needs no spoofing to collide.
    expect(sessionOn(machineTwo), 'two unconfigured machines').not.toBe(sessionOn(machineOne));
  });
});

describe('the ask command reports its outcome honestly', () => {
  /** Run the command against a workspace it opens and disposes itself. */
  async function ask(
    configPath: string,
    active: ActiveDb,
    json: boolean,
  ): Promise<{ code: number; out: string; err: string; failure?: unknown }> {
    const out: string[] = [];
    const err: string[] = [];
    let failure: unknown;
    let code = 0;
    try {
      code = await runAskCommand(
        { prompt: 'what tables do I have?', config: configPath, explicitConfig: true, json },
        {
          out: (l) => out.push(l),
          err: (l) => err.push(l),
          // The command opens the workspace it was pointed at; the test hands over
          // one it has already opened so the config on disk is the only fixture.
          open: () => Promise.resolve(active),
        },
      );
    } catch (e) {
      failure = e;
    }
    return { code, out: out.join('\n'), err: err.join('\n'), ...(failure ? { failure } : {}) };
  }

  it('prints the answer on stdout and the tools it ran on stderr', async () => {
    const { active, configPath } = await openWorkspace();
    scripted.provider = provider(
      scriptedClient([
        { text: 'Looking.', toolUses: [{ id: 't1', name: 'list_entities', input: {} }] },
        { text: 'One table: notes.' },
      ]),
    );
    const r = await ask(configPath, active, false);

    expect(r.failure).toBeUndefined();
    expect(r.code).toBe(0);
    // stdout carries the reply and NOTHING else, so the command pipes. The reply
    // is what the app would show: the round's narration, then the answer.
    expect(r.out).toBe('Looking.\n\nOne table: notes.');
    expect(r.err).toContain('list_entities');
  });

  it('--json puts the structured result on stdout instead', async () => {
    const { active, configPath } = await openWorkspace();
    scripted.provider = provider(
      scriptedClient([
        {
          text: 'Adding it.',
          toolUses: [
            { id: 't1', name: 'create_row', input: { table: 'notes', values: { body: 'hi' } } },
          ],
        },
        { text: 'Added the note.' },
      ]),
    );
    const r = await ask(configPath, active, true);

    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as {
      ok: boolean;
      answer: string;
      tools: { name: string; ok: boolean }[];
      stopped: boolean;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.answer).toBe('Adding it.\n\nAdded the note.');
    expect(parsed.tools).toEqual([{ name: 'create_row', ok: true }]);
    expect(parsed.stopped).toBe(false);
  });

  it('exits non-zero with actionable text, and an empty stdout, when no model is connected', async () => {
    const { active, configPath } = await openWorkspace();
    scripted.provider = null; // nothing connected on this machine
    const r = await ask(configPath, active, false);

    expect(r.failure, 'a machine with no model must fail loudly').toBeDefined();
    expect(assistantTurnErrorCode(r.failure)).toBe('no_model_connected');
    // The command's own reporting turns that into the sentence it prints, and the
    // caller exits non-zero on it. What it prints is a command to run, not a
    // browser to open.
    expect(askFailureMessage(r.failure)).toContain('lattice model');
    expect(askFailureMessage(r.failure)).not.toContain('lattice gui');
    expect(r.out, 'stdout stays empty so a pipeline reads nothing as nothing').toBe('');
  });

  it('needs a prompt', async () => {
    await expect(
      runAskCommand(
        { prompt: '   ', config: './lattice.config.yml', explicitConfig: false },
        { out: () => undefined, err: () => undefined },
      ),
    ).rejects.toThrow(/Usage: lattice ask/);
  });

  it('carries the step-cap warning out, and does not call a cut-off turn a success', async () => {
    // The turn is cut off with work outstanding: no error is raised, the answer
    // reads as finished, and the ONLY signal that it is not is a warning on the
    // stream. A browser renders it. If it stops here, the person watching sees
    // "the task may be incomplete" and the scheduled job sees exit 0.
    const { active, configPath } = await openWorkspace();
    let round = 0;
    scripted.provider = provider({
      runTurn: (params: TurnParams): Promise<TurnResult> => {
        round += 1;
        const id = `t${String(round)}`;
        for (const ch of 'Still working.') params.onText(ch);
        return Promise.resolve({
          stopReason: 'tool_use',
          text: 'Still working.',
          // Always wants another tool, so the loop runs out of rounds.
          toolUses: [{ id, name: 'list_entities', input: {} }],
        });
      },
    });
    const r = await ask(configPath, active, true);

    const parsed = JSON.parse(r.out) as { ok: boolean; warnings: string[]; finished: boolean };
    expect(parsed.ok, 'nothing errored — that is exactly why this is easy to miss').toBe(true);
    expect(parsed.warnings.join(' ')).toContain('may be incomplete');
    expect(parsed.finished).toBe(false);
    expect(r.code, 'a script must not read a cut-off turn as a completed one').toBe(1);
    expect(r.err).toContain('may be incomplete');
  });

  it('does not report a question as an answer', async () => {
    // Nobody is there to pick an option, so the job is not done and will not
    // become done. The question is still printed — it is the useful part — but a
    // scheduled run that reads the exit code must not carry on as if it had acted.
    const { active, configPath } = await openWorkspace();
    scripted.provider = provider(
      scriptedClient([
        {
          text: 'Which one?',
          toolUses: [
            {
              id: 't1',
              name: 'ask_user',
              input: { question: 'Which project?', options: ['Acme', 'Globex'] },
            },
          ],
        },
      ]),
    );
    const r = await ask(configPath, active, false);

    expect(r.out).toContain('Which project?');
    expect(r.out).toContain('  - Acme');
    expect(r.code, 'asking is not answering').toBe(1);
    expect(r.err).toContain('asked a question instead of answering');
  });

  it('does not report a refused change as done', async () => {
    // The gate on wide permanent removals refuses the call, the model apologises
    // fluently, and every earlier signal says success: no error, prose on stdout,
    // a tool that "ran". What did NOT happen is only in the outcome ledger — so
    // that is what the exit code has to be built on.
    const { active, configPath } = await openWorkspace();
    for (let i = 0; i < 201; i++) await active.db.insert('notes', { body: `n${String(i)}` });
    scripted.provider = provider(
      scriptedClient([
        {
          text: 'Removing it.',
          toolUses: [
            {
              id: 't1',
              name: 'delete_entity',
              input: { name: 'notes', resolution: 'delete_data' },
            },
          ],
        },
        { text: 'All tidied up.' },
      ]),
    );
    const r = await ask(configPath, active, true);

    const parsed = JSON.parse(r.out) as {
      ok: boolean;
      answer: string;
      outcomeNotice?: string;
      finished: boolean;
    };
    expect(parsed.ok, 'the turn itself did not error').toBe(true);
    expect(parsed.answer, 'and the model said it was done').toContain('All tidied up');
    expect(parsed.outcomeNotice ?? '').toMatch(/not been removed|could not be removed/);
    expect(parsed.finished).toBe(false);
    expect(r.code).toBe(1);
  });
});
