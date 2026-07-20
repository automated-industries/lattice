import type { Lattice } from '../../lattice.js';
import type { LlmClient } from './chat.js';
import {
  extractDashboardSql,
  extractSourceTables,
  extractQueryGetTables,
  extractSqlFromJoinTables,
  extractCteNames,
} from '../dashboard-row.js';
import { runDashboardSql } from '../dashboard-sql.js';

/**
 * Automatic QA for an assistant-authored dashboard, run BEFORE the page is stored/shown.
 * A dashboard reads its live data through `lattice.sql('SELECT …')` calls embedded in the
 * page; this extracts those queries, EXECUTES them against the real data, and checks:
 *   1. does the data actually answer the user's question / intent?  (LLM judgment)
 *   2. are there SQL errors making the output differ from what was intended?  (execution)
 *   3. were ambiguities resolved sensibly / was confidence overstated?  (LLM judgment)
 *   4. does a query return NO data at all — often a wrong join, wrong column/terminology,
 *      or a literal `=` where a fuzzy `LIKE`/`ILIKE` was meant?  (row count)
 * When issues are found it re-authors the page with that feedback (a bounded repair loop)
 * and re-checks; any issues that survive are returned so the caller can surface them to
 * the user rather than silently ship a flawed dashboard. Best-effort throughout — a QA
 * failure never blocks the dashboard (the un-QA'd page still ships).
 */

export type DashboardQaIssueKind =
  | 'missing_table'
  | 'sql_error'
  | 'no_data'
  | 'no_query'
  | 'templated_skipped'
  | 'intent_mismatch'
  | 'ambiguity'
  | 'overconfidence';

export interface DashboardQaIssue {
  kind: DashboardQaIssueKind;
  /** The offending query (verbatim), when the issue is tied to one. */
  query?: string;
  detail: string;
}

export interface DashboardQaResult {
  /** The (possibly repaired) dashboard HTML to store + show. */
  html: string;
  /** Issues still present after the repair loop — surface these to the user. */
  issues: DashboardQaIssue[];
  /** How many repair rounds ran (0 = passed first check). */
  rounds: number;
}

export interface DashboardQaDeps {
  db: Lattice;
  /** Model client for the intent/ambiguity judgment (the active provider's client). */
  client: LlmClient;
  model: string;
  /** Re-author the page with repair feedback — the same htmlAuthor the tools use. */
  reAuthor: (instruction: string, currentHtml: string) => Promise<string>;
  /** Max repair rounds (default 1). */
  maxRounds?: number;
}

/** One executed query's outcome, fed to the heuristic + LLM checks. */
interface QueryOutcome {
  query: string;
  templated?: boolean;
  error?: string;
  rowCount?: number;
  truncated?: boolean;
  sample?: unknown[];
}

const MAX_QUERIES = 12; // bound the QA work for a page with many charts

/** Execute each embedded SQL query (skipping runtime-templated ones), read-only + capped. */
async function runQueries(db: Lattice, html: string): Promise<QueryOutcome[]> {
  const queries = extractDashboardSql(html).slice(0, MAX_QUERIES);
  return Promise.all(
    queries.map(async (q): Promise<QueryOutcome> => {
      // A query assembled at runtime (a backtick `${…}` template) can't be statically run
      // with real values — skip it rather than false-flag a synthetic SQL error.
      if (q.dynamic) return { query: q.sql, templated: true };
      const r = await runDashboardSql(db, q.sql);
      if ('error' in r) return { query: q.sql, error: r.error };
      return {
        query: q.sql,
        rowCount: r.rows.length,
        truncated: r.truncated,
        sample: r.rows.slice(0, 3),
      };
    }),
  );
}

/** Deterministic checks — criteria 2 (SQL errors) + 4 (no data), plus "no query at all". */
function heuristicIssues(html: string, outcomes: QueryOutcome[]): DashboardQaIssue[] {
  const issues: DashboardQaIssue[] = [];
  // "No data query" fires only when the page reads NO live data by ANY means — not just
  // no lattice.sql. extractSourceTables detects lattice.sql/query/get reads, so a valid
  // dashboard that lists rows via lattice.query is not falsely flagged.
  if (extractSourceTables(html) === null) {
    issues.push({
      kind: 'no_query',
      detail:
        'The dashboard reads no live data — it may be hardcoding values instead of reading ' +
        'it with lattice.sql / lattice.query.',
    });
  }
  for (const o of outcomes) {
    if (o.templated) {
      issues.push({
        kind: 'templated_skipped',
        query: o.query,
        detail: 'Query is assembled at runtime (a ${…} template) and was not statically verified.',
      });
    } else if (o.error) {
      issues.push({ kind: 'sql_error', query: o.query, detail: o.error });
    } else if (o.rowCount === 0) {
      issues.push({
        kind: 'no_data',
        query: o.query,
        detail:
          'Query returned NO rows. Likely a wrong join, a wrong column/terminology, or a ' +
          'literal `=` match where a fuzzy `LIKE`/`ILIKE` (case-insensitive, partial) was ' +
          'meant. Verify the table/column names and matching against the real data.',
      });
    }
  }
  return issues;
}

const JUDGE_SYSTEM =
  'You QA the DATA QUERIES behind a dashboard against the user request that produced it. ' +
  'You are given the request and, for each SQL query the dashboard runs, its row count and ' +
  'a small sample of rows (or an execution error). Decide ONLY: (a) does the returned data ' +
  'actually answer the request (intent_mismatch if a query pulls the wrong thing, wrong ' +
  'grouping, wrong filter, or omits what was asked); (b) was an ambiguity in the request ' +
  'resolved in a questionable way (ambiguity); (c) does any result look too confident / ' +
  'not to be trusted given the data — e.g. a single-row sample presented as a trend, or a ' +
  'suspiciously round/empty result treated as fact (overconfidence). Do NOT re-flag plain ' +
  'SQL errors or empty results — those are already handled. Return ONLY a JSON array of ' +
  '{"kind","detail"} where kind is one of "intent_mismatch" | "ambiguity" | "overconfidence" ' +
  'and detail is one concrete sentence naming the query/column at fault; [] if the data ' +
  'soundly answers the request. Output the JSON in a ```json fenced block and nothing else.';

function summarizeOutcomes(outcomes: QueryOutcome[]): string {
  return outcomes
    .map((o, i) => {
      const head = `Query ${String(i + 1)}: ${o.query.replace(/\s+/g, ' ').slice(0, 400)}`;
      if (o.templated) return `${head}\n  (built at runtime — not executed)`;
      if (o.error) return `${head}\n  ERROR: ${o.error}`;
      const sample = JSON.stringify(o.sample ?? []).slice(0, 600);
      return `${head}\n  rows: ${String(o.rowCount)}${o.truncated ? '+ (capped)' : ''}, sample: ${sample}`;
    })
    .join('\n');
}

function parseJudgeIssues(raw: string): DashboardQaIssue[] {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fence?.[1] ?? raw).trim();
  try {
    const arr = JSON.parse(body) as unknown;
    if (!Array.isArray(arr)) return [];
    const allowed = new Set(['intent_mismatch', 'ambiguity', 'overconfidence']);
    return arr
      .filter((x): x is { kind: string; detail: string } => {
        const o = x as { kind?: unknown; detail?: unknown };
        return typeof o.kind === 'string' && allowed.has(o.kind) && typeof o.detail === 'string';
      })
      .slice(0, 8)
      .map((o) => ({ kind: o.kind as DashboardQaIssueKind, detail: o.detail }));
  } catch {
    return [];
  }
}

/** LLM judgment — criteria 1 (intent match) + 3 (ambiguity / overconfidence). Best-effort. */
async function judgeIntent(
  deps: DashboardQaDeps,
  intent: string,
  outcomes: QueryOutcome[],
): Promise<DashboardQaIssue[]> {
  // Nothing executed successfully → the heuristic checks already own it; skip the call.
  if (!outcomes.some((o) => o.rowCount !== undefined)) return [];
  try {
    const turn = await deps.client.runTurn({
      model: deps.model,
      system: JUDGE_SYSTEM,
      temperature: 0,
      tools: [],
      messages: [
        {
          role: 'user',
          content: `# Request\n${intent.slice(0, 2000)}\n\n# Dashboard queries + results\n${summarizeOutcomes(
            outcomes,
          )}\n\n# Task\nReturn the JSON array of issues.`,
        },
      ],
      onText: () => undefined,
    });
    return parseJudgeIssues(turn.text);
  } catch (e) {
    console.warn('[dashboard-qa] intent judgment failed:', (e as Error).message);
    return [];
  }
}

/** Turn the found issues into one plain-language repair brief for the re-author. */
function buildRepairInstruction(intent: string, issues: DashboardQaIssue[]): string {
  const lines = issues.map((i) => {
    const q = i.query ? ` [query: ${i.query.replace(/\s+/g, ' ').slice(0, 200)}]` : '';
    return `- (${i.kind}) ${i.detail}${q}`;
  });
  return (
    'A QA pass on the dashboard you just authored found problems with its data queries. ' +
    'Keep the original intent: "' +
    intent.replace(/\s+/g, ' ').slice(0, 500) +
    '". Fix the SQL so the page answers it correctly. Problems found:\n' +
    lines.join('\n') +
    '\n\nRewrite the page. For a query that returned no rows, re-check the join keys and ' +
    'column names against the real schema and prefer a case-insensitive fuzzy match ' +
    "(LOWER(col) LIKE LOWER('%…%')) over an exact `=` when matching names/text. Fix any " +
    'SQL errors. Make sure every chart/number is backed by a query that returns the data ' +
    'the request asks for.'
  );
}

/**
 * QA an authored dashboard and repair it (bounded loop). Returns the HTML to ship + any
 * residual issues. Never throws — on any internal failure it returns the input HTML so a
 * QA problem cannot block the dashboard.
 */
export async function qaDashboard(
  deps: DashboardQaDeps,
  html: string,
  intent: string,
): Promise<DashboardQaResult> {
  const maxRounds = deps.maxRounds ?? 1;
  let currentHtml = html;
  let rounds = 0;
  for (;;) {
    let issues: DashboardQaIssue[];
    try {
      const outcomes = await runQueries(deps.db, currentHtml);
      issues = [
        ...heuristicIssues(currentHtml, outcomes),
        ...(await judgeIntent(deps, intent, outcomes)),
      ];
    } catch (e) {
      // QA machinery itself failed — never block the dashboard on it.
      console.warn('[dashboard-qa] QA pass failed:', (e as Error).message);
      return { html: currentHtml, issues: [], rounds };
    }
    if (issues.length === 0 || rounds >= maxRounds) {
      return { html: currentHtml, issues, rounds };
    }
    rounds++;
    try {
      currentHtml = await deps.reAuthor(buildRepairInstruction(intent, issues), currentHtml);
    } catch (e) {
      // Re-author failed — ship the last good HTML + report the issues we found.
      console.warn('[dashboard-qa] repair re-author failed:', (e as Error).message);
      return { html: currentHtml, issues, rounds };
    }
  }
}

/** A short, user-facing note summarizing residual QA issues (empty string when none). */
export function qaIssuesNote(issues: DashboardQaIssue[]): string {
  if (issues.length === 0) return '';
  const parts = issues.slice(0, 5).map((i) => `• ${i.detail}`);
  return `Automatic QA flagged possible issues with this dashboard's data:\n${parts.join('\n')}`;
}

/**
 * DETERMINISTIC honesty gate — run before a dashboard is stored/shown, INDEPENDENT of the
 * best-effort {@link qaDashboard} repair loop (which uses an LLM and can be disabled or
 * rate-limited). It surfaces only HARD binding failures — the ones that make a dashboard a
 * broken, data-less shell the product must never claim is "done":
 *
 *  (a) a `lattice.query(...)` / `lattice.get(...)` first-arg table, or a FROM/JOIN table in
 *      a RUNTIME-TEMPLATED `lattice.sql` (which the QA loop skips, so it would otherwise be
 *      unchecked), that is not in the live schema → `missing_table`. CTE names defined in
 *      the same statement are subtracted so a query-local `WITH` block isn't misflagged.
 *  (b) a non-templated `lattice.sql` that ERRORS when executed against the real data (a
 *      missing table surfaces here too, plus any other SQL fault) → `sql_error`.
 *
 * Deliberately says NOTHING about empty results / intent — those are soft (a legitimately
 * empty dashboard is valid), and stay with {@link qaDashboard}. Bounded (caps the executed
 * queries) and never throws — on an internal fault it returns [] so the gate can only ever
 * catch a real defect, never manufacture one.
 */
export async function verifyDashboardBinding(
  db: Lattice,
  html: string,
  allowedTables: Iterable<string>,
): Promise<DashboardQaIssue[]> {
  try {
    const allowed = new Set<string>();
    for (const t of allowedTables) allowed.add(t.toLowerCase());
    const issues: DashboardQaIssue[] = [];
    const flagged = new Set<string>();
    const flagMissing = (name: string): void => {
      const key = name.toLowerCase();
      if (allowed.has(key) || flagged.has(key)) return;
      flagged.add(key);
      issues.push({
        kind: 'missing_table',
        detail:
          `The dashboard reads from a table "${name}" that does not exist in this ` +
          `workspace. The data it needs has not been created yet.`,
      });
    };
    // (a1) Unambiguous lattice.query/get table reads.
    for (const name of extractQueryGetTables(html)) flagMissing(name);
    // Non-templated SQL is EXECUTED (up to a cap) so it catches missing tables + any other
    // SQL fault; templated SQL, and any non-templated query BEYOND the execution cap, get the
    // static FROM/JOIN missing-table check instead — so NO query escapes binding
    // verification (a 13th chart's ghost table is still caught).
    let executed = 0;
    for (const q of extractDashboardSql(html)) {
      if (!q.dynamic && executed < MAX_QUERIES) {
        executed++;
        const r = await runDashboardSql(db, q.sql);
        if ('error' in r) issues.push({ kind: 'sql_error', query: q.sql, detail: r.error });
      } else {
        const ctes = new Set(extractCteNames(q.sql).map((c) => c.toLowerCase()));
        for (const name of extractSqlFromJoinTables(q.sql)) {
          if (!ctes.has(name.toLowerCase())) flagMissing(name);
        }
      }
    }
    return issues;
  } catch (e) {
    // The gate must never itself block a dashboard on a machinery fault — a thrown error
    // means we couldn't prove a defect, so report none.
    console.warn('[dashboard-qa] binding verification failed:', (e as Error).message);
    return [];
  }
}

/** A hard-failure message naming what's missing, for the `ok:false` tool result the
 *  assistant must relay honestly (never "done", never "try again"). */
export function bindingFailureMessage(issues: DashboardQaIssue[]): string {
  const missing = issues.filter((i) => i.kind === 'missing_table').map((i) => i.detail);
  const errors = issues.filter((i) => i.kind === 'sql_error').map((i) => i.detail);
  const parts: string[] = [];
  if (missing.length > 0) parts.push(missing.join(' '));
  if (errors.length > 0) parts.push(`A data query failed: ${errors.join('; ')}.`);
  return (
    `The dashboard was NOT created because its data does not load. ${parts.join(' ')} ` +
    `Tell the user plainly what data is missing and offer to bring it in — if they attached a ` +
    `spreadsheet, call import_spreadsheet with its file id to import it, otherwise offer to ` +
    `connect the source. Do NOT report it as ready and do NOT tell them to "try again" — ` +
    `retrying will not create the missing data.`
  );
}
