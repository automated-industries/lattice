import { randomUUID } from 'node:crypto';
import type { Lattice } from '../lattice.js';
import type { StorageAdapter } from '../db/adapter.js';
import { runAsyncOrSync, getAsyncOrSync, allAsyncOrSync } from '../db/adapter.js';
import { linkMaterializedRows, type MaterializedLinkSpec } from '../import/materialize.js';
import type { FeedBus, FeedSource } from './feed.js';
import { updateRow, linkRows, type MutationCtx } from './mutations.js';
import { upsertColumnMeta, upsertTableMeta } from './column-descriptions.js';
import { recordLineage } from './lineage-store.js';

/**
 * Clarification-question store: when an automated inference is MARGINAL
 * (confident enough not to drop, not confident enough to act), the producer
 * enqueues a short multiple-choice question here instead of guessing. Questions
 * surface as interactive cards in the assistant chat panel; answering one
 * executes a deferred action and/or persists the answer text onto the object it
 * describes, so the knowledge outlives the conversation.
 *
 * Managed via RAW DDL + raw SQL (NOT `db.define`), exactly like
 * `__lattice_lineage`: an unregistered `__lattice_` bookkeeping table so the
 * renderer never scans it and the Objects list / brain graph / cloud-member
 * grants ignore it by prefix. Timestamps carry NO SQL DEFAULT (the SQLite-only
 * `strftime(...)` default is non-parseable on Postgres) — every writer supplies
 * an explicit ISO string, keeping the CREATE byte-identical across dialects.
 */
export const QUESTIONS_TABLE = '__lattice_questions';

/** Create the questions table + its pending-scan index. Idempotent. */
export async function ensureQuestionsTable(adapter: StorageAdapter): Promise<void> {
  await runAsyncOrSync(
    adapter,
    `CREATE TABLE IF NOT EXISTS "${QUESTIONS_TABLE}" (
       "id"           TEXT PRIMARY KEY,
       "created_at"   TEXT NOT NULL,
       "source"       TEXT NOT NULL,
       "question"     TEXT NOT NULL,
       "options_json" TEXT NOT NULL,
       "context_json" TEXT,
       "status"       TEXT NOT NULL,
       "answer"       TEXT,
       "answered_at"  TEXT
     )`,
  );
  await runAsyncOrSync(
    adapter,
    `CREATE INDEX IF NOT EXISTS "${QUESTIONS_TABLE}_status_idx" ON "${QUESTIONS_TABLE}" ("status")`,
  );
}

/** Who produced a question (drives the card's source label, not permissions). */
export type QuestionSource = 'import' | 'assistant' | 'enrich';

/**
 * The action an ANSWER triggers, stored in `context_json`. A small tagged union
 * executed through the existing audited mutation paths — extend by adding a
 * member here and a case to {@link executeAction}. v1 producers only emit
 * `none` / `set_definition`; `link_rows` is implemented so the executor's
 * switch has a second real arm to grow from.
 */
export type DeferredAction =
  | { kind: 'none' }
  /** Record the answer text as the definition of a table (or one column). */
  | { kind: 'set_definition'; table: string; column?: string }
  /** Insert a junction row (the audited `linkRows` path). */
  | { kind: 'link_rows'; junction: string; values: Record<string, unknown> }
  /**
   * Create + populate the junction for a marginal import link the user
   * confirmed. Runs ONLY when the answer exactly matches `confirm` (the
   * affirmative option) — any other answer, including a free-form reply,
   * resolves the question without touching the schema.
   */
  | ({ kind: 'import_link'; confirm: string } & MaterializedLinkSpec);

/**
 * Where the ANSWER TEXT is additionally persisted (enrichment, not just
 * disambiguation). Applied only when the answer carries information — a
 * free-form reply — through the same audited definition/row/lineage paths the
 * assistant tools use, so activity cards appear for each write.
 */
export interface EnrichTarget {
  target: 'table_definition' | 'column_definition' | 'row_field' | 'lineage_detail';
  table: string;
  column?: string;
  rowId?: string;
}

/**
 * What the question is about — a record reference for display + navigation.
 * Used to label clarification-question cards (e.g., "Re: <label>") and link
 * the card to that record when clicked.
 */
export interface QuestionSubject {
  table: string;
  rowId: string;
  label: string;
}

/** The `context_json` payload: what answering this question should do. */
export interface QuestionContext {
  action?: DeferredAction;
  enrich?: EnrichTarget[];
  /** The record this question is about (optional, for display + navigation). */
  subject?: QuestionSubject;
}

/** A stored question row, options/context still JSON-encoded. */
export interface QuestionRow {
  id: string;
  created_at: string;
  source: string;
  question: string;
  options_json: string;
  context_json: string | null;
  status: 'pending' | 'answered' | 'dismissed';
  answer: string | null;
  answered_at: string | null;
}

export interface EnqueueQuestionInput {
  source: QuestionSource;
  question: string;
  /** Answer choices (a free-form "Other" is always offered by the UI). */
  options: string[];
  context?: QuestionContext;
  /** Feed attribution for the enqueue event (defaults to 'system'). */
  feedSource?: FeedSource;
}

/**
 * Insert a pending question and publish a `question` feed event so open GUIs
 * learn about it live (card + auto-open + trigger dot). Self-ensuring, like
 * `recordLineage`. Returns the new question id.
 */
export async function enqueueQuestion(
  db: Lattice,
  feed: FeedBus,
  input: EnqueueQuestionInput,
): Promise<string> {
  await ensureQuestionsTable(db.adapter);
  const id = randomUUID();
  await runAsyncOrSync(
    db.adapter,
    `INSERT INTO "${QUESTIONS_TABLE}"
       ("id","created_at","source","question","options_json","context_json","status","answer","answered_at")
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)`,
    [
      id,
      new Date().toISOString(),
      input.source,
      input.question,
      JSON.stringify(input.options),
      JSON.stringify({ action: { kind: 'none' }, ...input.context }),
    ],
  );
  // `table: null` on purpose: the bookkeeping table is feed-hidden by prefix,
  // and the event is a signal ("questions changed — reconcile"), not a row card.
  feed.publish({
    table: null,
    op: 'question',
    rowId: id,
    source: input.feedSource ?? 'system',
    summary: input.question,
  });
  return id;
}

/** Bounded pending read for the GUI (oldest first, so cards keep their order). */
export async function listPendingQuestions(db: Lattice, limit = 50): Promise<QuestionRow[]> {
  await ensureQuestionsTable(db.adapter);
  const rows = await allAsyncOrSync(
    db.adapter,
    `SELECT * FROM "${QUESTIONS_TABLE}" WHERE "status" = 'pending' ORDER BY "created_at" ASC LIMIT ?`,
    [limit],
  );
  return rows as unknown as QuestionRow[];
}

/** One question by id, or null. */
export async function getQuestion(db: Lattice, id: string): Promise<QuestionRow | null> {
  await ensureQuestionsTable(db.adapter);
  const row = await getAsyncOrSync(
    db.adapter,
    `SELECT * FROM "${QUESTIONS_TABLE}" WHERE "id" = ?`,
    [id],
  );
  return (row as unknown as QuestionRow | undefined) ?? null;
}

/** Everything the answer executor needs — one active-workspace bundle. */
export interface QuestionsCtx {
  db: Lattice;
  feed: FeedBus;
  softDeletable: Set<string>;
  /** GUI session id, so executed writes share the user's undo/redo stack. */
  sessionId?: string;
  /**
   * Workspace config path — schema-creating actions (a confirmed import
   * link's junction table) persist their definition here, like the importer
   * itself does. Absent ⇒ the table lives for the session only.
   */
  configPath?: string | null;
  /**
   * The active workspace's servable-table set. A schema-creating action adds
   * its new table here so the HTTP layer serves it without a reopen (the same
   * bookkeeping the import-apply route does for the tables it creates).
   */
  validTables?: Set<string>;
}

/** What answering a question actually did (returned to the card). */
export interface AnswerOutcome {
  id: string;
  status: 'answered';
  /** The action that ran (its kind), or 'none'. */
  action: DeferredAction['kind'];
  /** Human-readable notes of the enrichment writes that were applied. */
  enriched: string[];
}

/** Parse `context_json`, tolerating null/malformed (treated as action 'none'). */
export function parseQuestionContext(raw: string | null): QuestionContext {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as QuestionContext;
    }
  } catch {
    // fall through — a malformed context degrades to "record the answer only"
  }
  return {};
}

/**
 * True when the answer carries information worth persisting beyond the action:
 * a non-empty reply that is NOT one of the canned options. An option pick still
 * resolves the action (a "No" is informative for the decision), but persisting
 * the canned text as a definition/field value would add nothing.
 */
function isFreeformAnswer(answer: string, options: string[]): boolean {
  const trimmed = answer.trim();
  if (!trimmed) return false;
  return !options.some((o) => o.trim() === trimmed);
}

/** The mutation context question-answer writes run under (user-driven → gui). */
function answerMutationCtx(ctx: QuestionsCtx): MutationCtx {
  return {
    db: ctx.db,
    feed: ctx.feed,
    softDeletable: ctx.softDeletable,
    source: 'gui',
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
  };
}

/** Run the question's deferred action through the audited mutation paths. */
async function executeAction(
  ctx: QuestionsCtx,
  action: DeferredAction,
  answer: string,
): Promise<void> {
  switch (action.kind) {
    case 'none':
      return;
    case 'set_definition': {
      // Same write path as the assistant's set_definition tool.
      if (action.column) {
        await upsertColumnMeta(ctx.db, action.table, action.column, { description: answer });
      } else {
        await upsertTableMeta(ctx.db, action.table, { description: answer });
      }
      publishDefinitionFeed(ctx, action.table, action.column);
      return;
    }
    case 'link_rows':
      await linkRows(answerMutationCtx(ctx), action.junction, {
        id: randomUUID(),
        ...action.values,
      });
      return;
    case 'import_link': {
      // Only the explicit confirmation connects the tables; "No" (or a
      // free-form reply, which the enrichment targets persist) is a no-op.
      if (answer.trim() !== action.confirm) return;
      const { created } = await linkMaterializedRows(
        { db: ctx.db, configPath: ctx.configPath ?? null },
        action,
      );
      ctx.validTables?.add(action.junction);
      // The junction rows are import-style bulk writes (lineage-tracked, not
      // per-row audited) — publish one summary event so the change is visible
      // in the activity feed like the import's own link pass.
      ctx.feed.publish({
        table: action.junction,
        op: 'link',
        rowId: null,
        source: 'gui',
        summary: `Connected ${action.fromTable} to ${action.toTable} (${String(created)} links)`,
      });
      return;
    }
    default: {
      // A context written by a newer build names an action this build can't
      // run. Fail loudly — the question stays pending rather than half-done.
      const kind = (action as { kind?: unknown }).kind;
      throw new Error(`Unknown question action: ${String(kind)}`);
    }
  }
}

/** Definition writes have no audit chokepoint of their own — surface them on
 *  the feed so the answer shows up as an activity card like any other change. */
function publishDefinitionFeed(ctx: QuestionsCtx, table: string, column?: string): void {
  ctx.feed.publish({
    table,
    op: 'update',
    rowId: null,
    source: 'gui',
    summary: column
      ? `Recorded a definition for ${table}.${column}`
      : `Recorded a definition for ${table}`,
  });
}

/** Persist the answer text onto one enrichment target. Returns a short note. */
async function applyEnrichTarget(
  ctx: QuestionsCtx,
  questionId: string,
  target: EnrichTarget,
  answer: string,
): Promise<string> {
  switch (target.target) {
    case 'table_definition':
      await upsertTableMeta(ctx.db, target.table, { description: answer });
      publishDefinitionFeed(ctx, target.table);
      return `definition of ${target.table}`;
    case 'column_definition': {
      if (!target.column) throw new Error('column_definition target needs a column');
      await upsertColumnMeta(ctx.db, target.table, target.column, { description: answer });
      publishDefinitionFeed(ctx, target.table, target.column);
      return `definition of ${target.table}.${target.column}`;
    }
    case 'row_field': {
      if (!target.rowId) throw new Error('row_field target needs a rowId');
      if (!target.column) throw new Error('row_field target needs a column');
      // Audited row write — audit entry + feed event, undoable like any edit.
      await updateRow(answerMutationCtx(ctx), target.table, target.rowId, {
        [target.column]: answer,
      });
      return `${target.table}.${target.column} on row ${target.rowId}`;
    }
    case 'lineage_detail':
      await recordLineage(ctx.db.adapter, [
        {
          objectTable: target.table,
          objectId: target.rowId ?? '*',
          sourceKind: 'question',
          sourceTable: QUESTIONS_TABLE,
          sourceId: questionId,
          // The user told us what this object means — an observation about it,
          // not a new derivation of it.
          tier: 'observation',
          relation: 'clarified_by',
          detailJson: JSON.stringify({ answer }),
        },
      ]);
      return `lineage detail on ${target.table}`;
    default:
      throw new Error(`Unknown enrich target: ${String((target as { target?: unknown }).target)}`);
  }
}

/**
 * Answer a pending question: execute its deferred action, persist the answer
 * onto its enrichment targets (free-form answers only — see
 * {@link isFreeformAnswer}), then stamp `status`/`answer`/`answered_at` and
 * publish a `question` feed event. Ordering is deliberate: the execution runs
 * FIRST, so a failure leaves the question `pending` (the error is returned to
 * the card loudly; re-answering retries) instead of marking it answered with
 * half its effects missing.
 */
export async function answerQuestion(
  ctx: QuestionsCtx,
  id: string,
  answer: string,
): Promise<AnswerOutcome> {
  const q = await getQuestion(ctx.db, id);
  if (!q) throw Object.assign(new Error(`No question with id "${id}"`), { code: 'not_found' });
  if (q.status !== 'pending') {
    throw Object.assign(new Error(`Question is already ${q.status}`), { code: 'not_pending' });
  }
  let options: string[] = [];
  try {
    const parsed = JSON.parse(q.options_json) as unknown;
    if (Array.isArray(parsed)) options = parsed.filter((o): o is string => typeof o === 'string');
  } catch {
    // options unreadable → treat every answer as free-form
  }
  const context = parseQuestionContext(q.context_json);

  await executeAction(ctx, context.action ?? { kind: 'none' }, answer);
  const enriched: string[] = [];
  if (isFreeformAnswer(answer, options)) {
    for (const target of context.enrich ?? []) {
      enriched.push(await applyEnrichTarget(ctx, id, target, answer));
    }
  }

  await runAsyncOrSync(
    ctx.db.adapter,
    `UPDATE "${QUESTIONS_TABLE}" SET "status" = 'answered', "answer" = ?, "answered_at" = ? WHERE "id" = ?`,
    [answer, new Date().toISOString(), id],
  );
  ctx.feed.publish({
    table: null,
    op: 'question',
    rowId: id,
    source: 'gui',
    summary: `Answered: ${q.question}`,
  });
  return {
    id,
    status: 'answered',
    action: (context.action ?? { kind: 'none' }).kind,
    enriched,
  };
}

/** Dismiss a pending question (no action, no enrichment) and tell open GUIs. */
export async function dismissQuestion(ctx: QuestionsCtx, id: string): Promise<void> {
  const q = await getQuestion(ctx.db, id);
  if (!q) throw Object.assign(new Error(`No question with id "${id}"`), { code: 'not_found' });
  if (q.status !== 'pending') {
    throw Object.assign(new Error(`Question is already ${q.status}`), { code: 'not_pending' });
  }
  await runAsyncOrSync(
    ctx.db.adapter,
    `UPDATE "${QUESTIONS_TABLE}" SET "status" = 'dismissed', "answered_at" = ? WHERE "id" = ?`,
    [new Date().toISOString(), id],
  );
  ctx.feed.publish({
    table: null,
    op: 'question',
    rowId: id,
    source: 'gui',
    summary: `Dismissed: ${q.question}`,
  });
}
