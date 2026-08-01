/**
 * The `lattice ask` subcommand — the assistant, from a terminal.
 *
 * This is the deepest expression of "the browser is one client, never a
 * requirement": the same assistant that answers in the app answers here, over the
 * same tools, against the same workspace, with the same permissions and the same
 * refusals. Nothing about it is a reduced version — a turn asked for from a
 * script runs the tool loop, makes the writes, and comes back with the answer.
 *
 * Extracted from the CLI entrypoint so it is importable and therefore testable:
 * `cli.ts` calls `main()` at import time, so nothing defined inside it can be
 * exercised from a test.
 *
 * WHERE THE OUTPUT GOES, and why the split matters. The ANSWER goes to stdout and
 * nothing else does, so `lattice ask "…" | pbcopy` and `$(lattice ask "…")` carry
 * the answer alone. Progress — which tools ran, what changed — goes to stderr, so
 * watching a turn work costs nothing on the pipeline. `--json` puts the structured
 * result on stdout instead, for a caller that wants the tool list too.
 *
 * A FAILURE IS A FAILURE. No model connected, a turn that errors, a workspace that
 * will not open: each exits non-zero with a sentence saying what to do about it. An
 * empty answer with a zero exit would be the worst possible outcome — a script
 * would read it as success and carry on with nothing.
 */
import { createHmac } from 'node:crypto';
import { dirname } from 'node:path';
import { openConfig, disposeActive } from './gui/lifecycle.js';
import type { ActiveDb } from './gui/active-db.js';
import { resolveWorkspaceTarget } from './cli-target.js';
import { getOrCreateSessionSecret, readIdentity } from './framework/user-config.js';
import {
  runAssistantTurn,
  assistantTurnErrorCode,
  type AssistantTurnResult,
  type AssistantTurnWorkspace,
} from './ops/assistant-turn.js';
import {
  createUserEntity,
  createUserJunction,
  createFileJunction,
  addUserColumn,
  aiDeleteEntity,
} from './gui/schema-ops.js';
import {
  listComputedTables,
  previewComputedTable,
  createComputedTable,
  updateComputedTable,
  refreshComputedTable,
  deleteComputedTable,
} from './gui/computed-ops.js';

/** Everything the ask subcommand needs from the parsed argv. */
export interface AskCommandArgs {
  /** The prompt, as typed. */
  prompt?: string | undefined;
  /** `--config` as parsed, which carries a default the user may not have typed. */
  config: string;
  /** True only when `--config` was actually passed. */
  explicitConfig: boolean;
  /** `--root`, when given. */
  root?: string | undefined;
  /** `--json` — put the structured turn result on stdout instead of the answer. */
  json?: boolean;
}

/** Where the command's two streams go. Injected so a test can read them. */
export interface AskIo {
  /** The answer (or the JSON result). Nothing else is ever written here. */
  out(line: string): void;
  /** Progress and status. Safe to be noisy: it is not the output. */
  err(line: string): void;
  /** Opens the workspace. Injected so a test can hand over one it already has. */
  open?(configPath: string, outputDir: string): Promise<ActiveDb>;
}

/**
 * The session a command-line turn's writes are attributed to.
 *
 * A session id exists so undo can be scoped to one actor's own actions, and every
 * `lattice ask` is a fresh process — so a random per-process id would make each
 * turn's writes un-undoable by the next command, which is exactly the headless
 * gap this whole surface exists to close. It is instead stable for THIS operator's
 * command line: `lattice ask "undo that"` reaches what the previous one did, and
 * `undoGroup` still works from a later process.
 *
 * IT MUST ALSO BE UNGUESSABLE, and that is not a refinement — it is what makes
 * the identity safe to use at all. On a shared workspace this string IS the
 * authorship gate: undo, redo, and group-revert will only touch entries stamped
 * with the caller's own session, and the browser satisfies that with a random
 * per-process id nobody else can produce. A name cannot do the job. Spelling one
 * out of the machine-local identity would mean a second member could set the
 * identity environment variable to a colleague's address and walk back their
 * work — and two machines with no identity configured at all would collide on
 * the same value with no spoofing whatsoever.
 *
 * So it is derived from a machine-local random secret, mixed with the identity so
 * that two people sharing one machine still get two sessions. Stable because the
 * secret is stored; unforgeable because the secret is not, and cannot be, part of
 * anything a caller says about themselves.
 */
export function commandLineSessionId(): string {
  const id = readIdentity();
  const who = id.email || id.display_name || 'local';
  const derived = createHmac('sha256', getOrCreateSessionSecret()).update(who).digest('hex');
  return `cli:${derived.slice(0, 32)}`;
}

/** Every primitive the assistant may use, wired to an open workspace. */
export function askWorkspace(active: ActiveDb, sessionId: string): AssistantTurnWorkspace {
  return {
    db: active.db,
    feed: active.feed,
    validTables: active.validTables,
    junctionTables: active.junctionTables,
    softDeletable: active.softDeletable,
    computedTables: active.computedTables,
    configPath: active.configPath,
    outputDir: active.outputDir,
    sessionId,
    // The same audited, reversible, no-reopen primitives the browser hands it.
    // `importAttachment` is deliberately absent: it works on a file the composer
    // attached, and a command line attaches nothing — so the assistant is told
    // that tool is unavailable rather than being left to fail inside it.
    createEntity: (name, columns) =>
      createUserEntity(active, name, columns, sessionId, { rejectAnonymous: true }),
    addColumn: (table, column) => addUserColumn(active, table, column, sessionId),
    createJunction: (a, b) => createUserJunction(active, a, b, sessionId),
    createFileJunction: (otherTable) => createFileJunction(active, otherTable, sessionId),
    deleteEntity: (name, resolution) => aiDeleteEntity(active, name, resolution, sessionId),
    computedOps: {
      list: () => listComputedTables(active),
      preview: (def, limit) => previewComputedTable(active, def, limit),
      create: (name, def) => createComputedTable(active, name, def, sessionId),
      update: (name, def) => updateComputedTable(active, name, def, sessionId),
      refresh: (name) => refreshComputedTable(active, name, { sessionId }),
      delete: (name) => deleteComputedTable(active, name, sessionId),
    },
  };
}

/** The turn as a caller of `--json` sees it: the answer plus what the turn did. */
export interface AskJsonResult {
  ok: boolean;
  answer: string;
  tools: { name: string; ok: boolean }[];
  opened: { table: string; id: string }[];
  stopped: boolean;
  /** Warnings the turn raised about itself — today, that it ran out of steps. */
  warnings: string[];
  outcomeNotice?: string;
  question?: { question: string; options: string[]; allowOther: boolean };
  error?: string;
  /**
   * True exactly when the command exits zero. Derived from the fields above by
   * {@link turnFinishedTheJob}, and included so a caller reading the JSON does
   * not have to re-derive the same judgement — and cannot disagree with the exit
   * code about it.
   */
  finished: boolean;
}

/** Shape one finished turn for `--json`. */
export function askJson(result: AssistantTurnResult): AskJsonResult {
  return {
    ok: result.ok,
    answer: result.text,
    tools: result.tools.map((t) => ({ name: t.name, ok: t.ok })),
    opened: result.opened,
    stopped: result.stopped,
    warnings: result.warnings,
    ...(result.outcomeNotice ? { outcomeNotice: result.outcomeNotice } : {}),
    ...(result.question ? { question: result.question } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    finished: turnFinishedTheJob(result),
  };
}

/**
 * Did this turn actually do what it was asked?
 *
 * This is the whole exit code, and it is deliberately stricter than "did the
 * model produce prose". A script has ONE channel for this — the number — and it
 * is normally read as `command || alert`. So every way a turn can end without
 * having done the job has to reach that number:
 *
 *   - the turn errored, or hit a provider limit (`ok` is already false);
 *   - it ASKED a question instead of acting. Nobody is there to answer it, so the
 *     job is not done and will not become done. The question is still printed —
 *     it is the useful part — but a scheduled run must not read it as an answer;
 *   - it warned about itself. Today that means the step cap: it was cut off with
 *     work outstanding, and the answer it managed describes an unfinished job;
 *   - the outcome ledger has something to say. That notice exists precisely when
 *     something the answer might claim did NOT happen, happened but is not a
 *     success, or was half-applied and is still applied — including every refusal
 *     from the gate on wide permanent removals. A clean turn produces none;
 *   - there is no answer at all.
 *
 * The reason is always on stderr as well, so a person watching sees WHICH of
 * these it was, not just that the number was one.
 */
export function turnFinishedTheJob(result: AssistantTurnResult): boolean {
  if (!result.ok) return false;
  if (result.question) return false;
  if (result.warnings.length > 0) return false;
  if (result.outcomeNotice !== undefined) return false;
  return result.text.length > 0;
}

/**
 * Run one `lattice ask`.
 *
 * @returns the process exit code — 0 when the turn did the job it was given, 1
 * when it did not. {@link turnFinishedTheJob} is the whole test, and it covers
 * more than "did it throw": a turn that asked a question, ran out of steps, or
 * had its work refused is not a success, however fluent the prose it produced.
 * @throws when the workspace itself cannot be resolved or opened, which the
 * caller reports and exits on. A turn that RAN and failed is not thrown: its
 * reason is written out (or carried in the JSON) and reported as a non-zero code,
 * because the caller asked for a turn and one happened.
 */
export async function runAskCommand(args: AskCommandArgs, io: AskIo): Promise<number> {
  const prompt = (args.prompt ?? '').trim();
  if (!prompt) throw new Error('Usage: lattice ask "<prompt>" [--json] [--config <path>]');

  const target = resolveWorkspaceTarget({
    config: args.config,
    explicitConfig: args.explicitConfig,
    ...(args.root !== undefined ? { root: args.root } : {}),
  });
  // One-shot: the rendered context tree is not kept in step here (that is what
  // `lattice render` is for), so nothing schedules a render behind the answer and
  // there is no background work still running when the command returns.
  const active = await (io.open ?? openConfig)(target.configPath, target.contextDir);
  const sessionId = commandLineSessionId();
  try {
    io.err(`Workspace: ${dirname(target.configPath)}`);
    const result = await runAssistantTurn(askWorkspace(active, sessionId), {
      message: prompt,
      // Each tool is reported as it is REQUESTED rather than after it finishes, so
      // a long call shows what is being waited on instead of a silent pause.
      onToolRecord: (rec) => {
        io.err(rec.isError ? `  ${rec.name} — failed` : `  ${rec.name}`);
      },
      onOutcomeNotice: (notice) => {
        io.err(notice);
      },
    });

    if (args.json) {
      io.out(JSON.stringify(askJson(result), null, 2));
    } else if (result.question) {
      // The model asked instead of answering. There is nobody to click an option,
      // so the question goes out as the answer — it is the useful part — and the
      // exit code says the job was not done.
      io.out(result.question.question);
      for (const option of result.question.options) io.out(`  - ${option}`);
    } else if (result.ok) {
      io.out(result.text);
    }

    // Say WHICH of the ways the turn fell short applied, on the channel that is
    // not the output. A bare non-zero exit is a fact with no explanation.
    if (!result.ok) io.err(`Error: ${result.error ?? 'the turn failed'}`);
    // The turn cut off with work outstanding. This travels the same stream a
    // browser renders as a warning bubble, and was previously dropped here —
    // which meant the one signal that an answer describes an unfinished job
    // reached a person and never reached a script.
    for (const warning of result.warnings) io.err(`Warning: ${warning}`);
    if (result.question) io.err('The assistant asked a question instead of answering.');
    if (result.ok && !result.text && !result.question) {
      io.err('The assistant produced no answer.');
    }
    // The outcome notice is already on stderr — it was streamed as it happened.
    return turnFinishedTheJob(result) ? 0 : 1;
  } finally {
    await disposeActive(active);
  }
}

/**
 * Turn a failure from {@link runAskCommand} into the sentence to print.
 *
 * "No model connected" is the one failure that is nobody's mistake — it is the
 * state of a fresh machine — so it prints as the instructions it already is,
 * rather than being dressed up as an error report.
 */
export function askFailureMessage(e: unknown): string {
  if (assistantTurnErrorCode(e) === 'no_model_connected') return (e as Error).message;
  return `Error: ${e instanceof Error ? e.message : String(e)}`;
}
