/**
 * The `lattice questions` subcommand — the assistant's clarification queue from a
 * terminal.
 *
 * When something automated is confident enough not to drop a guess but not
 * confident enough to act on it, it stops and asks instead. That is the right
 * behaviour, and it is also a trap: the queue was answerable only in the browser
 * app, so anything running without one — a scheduled import, an agent, a
 * pipeline — could be stopped indefinitely by a single question nobody could
 * reach. One unanswered question is enough to wedge every later step behind it.
 *
 * So there are three verbs, and they are the whole loop: `list` shows what is
 * waiting, `answer` resolves one, `dismiss` drops one. Answering runs whatever
 * the question was deferring, through the same audited paths the browser app
 * uses, which is why this is the real queue and not a view of it.
 *
 * Nothing here writes to stdout or exits the process. Output is RETURNED as lines
 * and errors are THROWN, so the same logic serves the CLI wrapper (which prints
 * and sets an exit code) and a caller that wants the outcome as a value.
 */
import { openConfig, disposeActive } from './gui/lifecycle.js';
import type { ActiveDb } from './gui/active-db.js';
import {
  answerQuestion,
  dismissQuestion,
  listPendingQuestions,
  parseQuestionContext,
  type QuestionsCtx,
  type QuestionRow,
} from './gui/questions.js';
import { commandLineSessionId } from './cli-ask.js';

/** Everything the questions subcommand needs from the parsed argv. */
export interface QuestionsCommandArgs {
  /** The workspace this command is about. */
  configPath: string;
  /** Its rendered-context directory. */
  contextDir: string;
  /** `list` | `answer` | `dismiss`. Defaults to `list`. */
  subcommand?: string | undefined;
  /** The trailing positional: the question id for `answer` and `dismiss`. */
  action?: string | undefined;
  /**
   * `--text <answer>` — what `answer` replies with. Either one of the question's
   * own options, or free-form text, which is additionally kept as knowledge about
   * whatever the question was about.
   */
  text?: string | undefined;
  /** `--json` — emit `list` as machine-readable records instead of a table. */
  json?: boolean;
  /** Opens the workspace. Injected so a test can hand over one it already has. */
  open?: (configPath: string, outputDir: string) => Promise<ActiveDb>;
}

export const QUESTIONS_USAGE =
  'Usage: lattice questions list [--json]\n' +
  '       lattice questions answer <id> --text "<answer>"\n' +
  '       lattice questions dismiss <id>';

/** The answer options a question offers, or an empty list when it offers none. */
function optionsOf(q: QuestionRow): string[] {
  try {
    const parsed = JSON.parse(q.options_json) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((o): o is string => typeof o === 'string');
  } catch {
    // Unreadable options are not a fault: the question is still answerable in
    // free-form, which is exactly what the browser app falls back to as well.
  }
  return [];
}

/** One pending question as lines a person can act on — the id first, to copy. */
function describe(q: QuestionRow): string[] {
  const lines = [`${q.id}  [${q.source}]  ${q.question}`];
  const options = optionsOf(q);
  if (options.length > 0) lines.push(`    options: ${options.join(' | ')}`);
  const subject = parseQuestionContext(q.context_json).subject;
  if (subject) lines.push(`    about: ${subject.table} — ${subject.label}`);
  return lines;
}

/** The mutation context a command-line answer runs its writes under. */
function questionsCtx(active: ActiveDb): QuestionsCtx {
  return {
    db: active.db,
    feed: active.feed,
    softDeletable: active.softDeletable,
    sessionId: commandLineSessionId(),
    configPath: active.configPath,
    validTables: active.validTables,
  };
}

/**
 * Run one `lattice questions` subcommand against an existing workspace.
 *
 * The workspace is opened for the duration and closed again, including when the
 * operation fails — a command that leaves a store open behind it holds a file
 * handle nothing will ever release.
 *
 * @returns the lines to print, in order.
 * @throws on a usage error, an unknown subcommand, or a question that is missing
 *         or already resolved.
 */
export async function runQuestionsCommand(args: QuestionsCommandArgs): Promise<string[]> {
  const sub = args.subcommand ?? 'list';
  if (!['list', 'answer', 'dismiss'].includes(sub)) {
    throw new Error(`Unknown questions subcommand: ${sub}\n${QUESTIONS_USAGE}`);
  }
  const active = await (args.open ?? openConfig)(args.configPath, args.contextDir);
  try {
    switch (sub) {
      case 'list': {
        const pending = await listPendingQuestions(active.db);
        if (args.json === true) {
          return pending.map((q) =>
            JSON.stringify({
              id: q.id,
              question: q.question,
              options: optionsOf(q),
              source: q.source,
              created_at: q.created_at,
            }),
          );
        }
        if (pending.length === 0) return ['Nothing is waiting on an answer.'];
        return pending.flatMap(describe);
      }
      case 'answer': {
        if (!args.action) throw new Error('Usage: lattice questions answer <id> --text "<answer>"');
        const answer = args.text?.trim() ?? '';
        if (!answer) {
          throw new Error(
            'Nothing to answer with. Pass the reply: --text "<answer>" — either one of ' +
              "the question's options or your own words.",
          );
        }
        const outcome = await answerQuestion(questionsCtx(active), args.action, answer);
        const lines = [`Answered ${outcome.id}.`];
        if (outcome.action !== 'none') lines.push(`  ran: ${outcome.action}`);
        for (const note of outcome.enriched) lines.push(`  recorded onto the ${note}`);
        return lines;
      }
      default: {
        if (!args.action) throw new Error('Usage: lattice questions dismiss <id>');
        await dismissQuestion(questionsCtx(active), args.action);
        return [`Dismissed ${args.action}.`];
      }
    }
  } finally {
    await disposeActive(active);
  }
}
