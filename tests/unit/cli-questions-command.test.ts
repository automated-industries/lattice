/**
 * `lattice questions` — draining the clarification queue without a browser.
 *
 * The queue exists because stopping to ask is better than guessing. That is also
 * how it becomes a trap: answering was only possible in the browser app, so a
 * scheduled import, an agent, or a pipeline could be stopped indefinitely by one
 * question nobody was able to reach, with every later step waiting behind it.
 *
 * The three things these prove are the three that make the loop actually usable
 * from a terminal: `list` prints the id `answer` takes (an id you cannot see is a
 * question you cannot resolve), `answer` RUNS what the question was holding
 * rather than just recording a reply, and both verbs refuse a question that is
 * already resolved instead of quietly doing it twice.
 *
 * These drive the subcommand directly rather than the process, which is why the
 * logic lives in its own module: the CLI entrypoint runs `main()` at import time
 * and cannot be imported.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQuestionsCommand } from '../../src/cli-questions.js';
import { openConfig, disposeActive } from '../../src/gui/lifecycle.js';
import { enqueueQuestion, getQuestion } from '../../src/gui/questions.js';
import type { Lattice } from '../../src/lattice.js';

const dirs: string[] = [];
const prev: Record<string, string | undefined> = {};
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lattice-cli-questions-'));
  for (const key of ['LATTICE_CONFIG_DIR', 'LATTICE_ROOT', 'LATTICE_ENCRYPTION_KEY']) {
    prev[key] = process.env[key];
  }
  // Identity, session secret, and registry all resolve inside the scratch dir —
  // never the machine's own config dir or home root.
  process.env.LATTICE_CONFIG_DIR = join(scratch, 'config');
  mkdirSync(process.env.LATTICE_CONFIG_DIR, { recursive: true });
  process.env.LATTICE_ROOT = join(scratch, 'unused-root');
  process.env.LATTICE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
});

afterAll(() => {
  for (const [key, value] of Object.entries(prev)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Workspace {
  configPath: string;
  contextDir: string;
}

/** A one-table workspace on disk. */
function workspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'lattice-questions-ws-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  customers:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: customers.md',
      '',
    ].join('\n'),
    'utf8',
  );
  return { configPath, contextDir: join(root, 'context') };
}

/** The definition stored for a table, read straight out of the metadata row. */
async function storedDefinition(db: Lattice, table: string): Promise<string | null> {
  const row = (await db.get('_lattice_gui_meta', table)) as { description?: string | null } | null;
  return row?.description ?? null;
}

/** Put one question in the queue and hand back its id. */
async function ask(
  ws: Workspace,
  question: string,
  context?: Parameters<typeof enqueueQuestion>[2]['context'],
): Promise<string> {
  const active = await openConfig(ws.configPath, ws.contextDir);
  try {
    return await enqueueQuestion(active.db, active.feed, {
      source: 'import',
      question,
      options: ['Yes', 'No'],
      ...(context ? { context } : {}),
    });
  } finally {
    await disposeActive(active);
  }
}

describe('questions list', () => {
  it('prints the id, so the next command has something to name', async () => {
    const ws = workspace();
    const id = await ask(ws, 'What does the amount column mean?');

    const lines = await runQuestionsCommand({ ...ws, subcommand: 'list' });

    const text = lines.join('\n');
    expect(text).toContain(id);
    expect(text).toContain('What does the amount column mean?');
    // The offered answers, so somebody can reply without opening anything.
    expect(text).toContain('Yes | No');
  });

  it('says so plainly when nothing is waiting', async () => {
    const ws = workspace();
    expect((await runQuestionsCommand({ ...ws, subcommand: 'list' })).join('\n')).toMatch(
      /Nothing is waiting/,
    );
  });

  it('emits one record per line for a machine reader', async () => {
    const ws = workspace();
    const id = await ask(ws, 'Which one?');

    const lines = await runQuestionsCommand({ ...ws, subcommand: 'list', json: true });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { id: string; options: string[] };
    expect(parsed.id).toBe(id);
    expect(parsed.options).toEqual(['Yes', 'No']);
  });
});

describe('questions answer', () => {
  it('runs the action the question was holding, not just the reply', async () => {
    // The point of the verb. A version that only stamped the row would report
    // success while the thing the question was blocking never happened.
    const ws = workspace();
    const id = await ask(ws, 'What is customers for?', {
      action: { kind: 'set_definition', table: 'customers' },
    });

    const lines = await runQuestionsCommand({
      ...ws,
      subcommand: 'answer',
      action: id,
      text: 'People who have bought something',
    });

    expect(lines.join('\n')).toContain('set_definition');
    const active = await openConfig(ws.configPath, ws.contextDir);
    try {
      expect(await getQuestion(active.db, id)).toMatchObject({ status: 'answered' });
      expect(await storedDefinition(active.db, 'customers')).toBe(
        'People who have bought something',
      );
    } finally {
      await disposeActive(active);
    }
  });

  it('refuses an answer with no text rather than resolving a question with nothing', async () => {
    const ws = workspace();
    const id = await ask(ws, 'Which one?');

    await expect(runQuestionsCommand({ ...ws, subcommand: 'answer', action: id })).rejects.toThrow(
      /--text/,
    );

    const active = await openConfig(ws.configPath, ws.contextDir);
    try {
      expect(await getQuestion(active.db, id)).toMatchObject({ status: 'pending' });
    } finally {
      await disposeActive(active);
    }
  });

  it('refuses a question that is already resolved instead of doing it twice', async () => {
    const ws = workspace();
    const id = await ask(ws, 'Which one?');
    await runQuestionsCommand({ ...ws, subcommand: 'answer', action: id, text: 'Yes' });

    await expect(
      runQuestionsCommand({ ...ws, subcommand: 'answer', action: id, text: 'No' }),
    ).rejects.toThrow(/already answered/);
  });

  it('refuses an id that names nothing', async () => {
    const ws = workspace();
    await expect(
      runQuestionsCommand({ ...ws, subcommand: 'answer', action: 'not-an-id', text: 'Yes' }),
    ).rejects.toThrow(/No question with id/);
  });
});

describe('questions dismiss', () => {
  it('drops a question without running what it was holding', async () => {
    const ws = workspace();
    const id = await ask(ws, 'What is customers for?', {
      action: { kind: 'set_definition', table: 'customers' },
    });

    await runQuestionsCommand({ ...ws, subcommand: 'dismiss', action: id });

    const active = await openConfig(ws.configPath, ws.contextDir);
    try {
      expect(await getQuestion(active.db, id)).toMatchObject({ status: 'dismissed' });
      // Dismissing is not a quiet "yes" — the deferred write must not have run.
      expect(await storedDefinition(active.db, 'customers')).toBeNull();
    } finally {
      await disposeActive(active);
    }
    expect((await runQuestionsCommand({ ...ws, subcommand: 'list' })).join('\n')).toMatch(
      /Nothing is waiting/,
    );
  });
});

describe('unknown subcommand', () => {
  it('lists the ones that exist', async () => {
    const ws = workspace();
    await expect(runQuestionsCommand({ ...ws, subcommand: 'resolve' })).rejects.toThrow(
      /lattice questions list/,
    );
  });
});
