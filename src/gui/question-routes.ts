import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import type { FeedBus } from './feed.js';
import { sendJson, readJson } from './http.js';
import {
  answerQuestion,
  dismissQuestion,
  listPendingQuestions,
  type QuestionsCtx,
} from './questions.js';

/**
 * HTTP surface for the clarification-question store (`/api/questions/*`).
 * Mounted only against an active workspace (the server's dispatch registry),
 * with the same trust model as the other mutating GUI routes: localhost +
 * same-origin gate; the virgin (zero-workspace) state 409s before we're
 * reached.
 */

export interface QuestionRoutesContext {
  db: Lattice;
  feed: FeedBus;
  softDeletable: Set<string>;
  /** GUI session id — answer-driven writes join the user's undo/redo stack. */
  sessionId?: string;
  /** Workspace config path — schema-creating answers persist definitions here. */
  configPath?: string;
  /** Servable-table set — schema-creating answers register new tables here. */
  validTables?: Set<string>;
  pathname: string;
  method: string;
}

const ANSWER_RE = /^\/api\/questions\/([^/]+)\/answer$/;
const DISMISS_RE = /^\/api\/questions\/([^/]+)\/dismiss$/;

/** Map a store error to an HTTP status by its stable `code`. */
function statusFor(e: Error & { code?: string }): number {
  if (e.code === 'not_found') return 404;
  if (e.code === 'not_pending') return 409;
  return 500;
}

/**
 * Dispatch `/api/questions/*`. Returns true when a route matched — the caller
 * falls through to the GUI's 404 handler otherwise.
 */
export async function dispatchQuestionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: QuestionRoutesContext,
): Promise<boolean> {
  const { pathname, method } = ctx;
  const qctx: QuestionsCtx = {
    db: ctx.db,
    feed: ctx.feed,
    softDeletable: ctx.softDeletable,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
    ...(ctx.validTables ? { validTables: ctx.validTables } : {}),
  };

  if (method === 'GET' && pathname === '/api/questions/pending') {
    const rows = await listPendingQuestions(ctx.db);
    sendJson(res, {
      questions: rows.map((q) => {
        let options: string[] = [];
        try {
          const parsed = JSON.parse(q.options_json) as unknown;
          if (Array.isArray(parsed)) {
            options = parsed.filter((o): o is string => typeof o === 'string');
          }
        } catch {
          // unreadable options → the card still renders with free-form only
        }
        return {
          id: q.id,
          question: q.question,
          options,
          // Every question always offers a free-form "Other" answer.
          allowOther: true,
          source: q.source,
          created_at: q.created_at,
        };
      }),
    });
    return true;
  }

  const answerMatch = ANSWER_RE.exec(pathname);
  if (method === 'POST' && answerMatch) {
    const id = decodeURIComponent(answerMatch[1] ?? '');
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
    if (!answer) {
      sendJson(res, { error: 'answer is required' }, 400);
      return true;
    }
    try {
      sendJson(res, await answerQuestion(qctx, id, answer));
    } catch (e) {
      // Executor failure leaves the question PENDING (answerQuestion stamps
      // status only after execution succeeds) — return the error loudly so
      // the card shows it and the user can retry or dismiss.
      const err = e as Error & { code?: string };
      sendJson(res, { error: err.message }, statusFor(err));
    }
    return true;
  }

  const dismissMatch = DISMISS_RE.exec(pathname);
  if (method === 'POST' && dismissMatch) {
    const id = decodeURIComponent(dismissMatch[1] ?? '');
    try {
      await dismissQuestion(qctx, id);
      sendJson(res, { ok: true, id, status: 'dismissed' });
    } catch (e) {
      const err = e as Error & { code?: string };
      sendJson(res, { error: err.message }, statusFor(err));
    }
    return true;
  }

  return false;
}
