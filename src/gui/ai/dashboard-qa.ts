import type { Lattice } from '../../lattice.js';
import type { BoundedCountOptions } from '../../types.js';
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
  | 'overconfidence'
  /** Every number the page RENDERS is zero — a data-less shell, not a dashboard. */
  | 'all_zeros'
  /** A figure stated in the answer is not a figure the page actually shows. */
  | 'claim_unverified'
  /** One real-world thing occupies several rows, so counting rows overcounts. */
  | 'duplicate_keys'
  /** The requested grouping has no clean categorical column behind it. */
  | 'no_clean_category'
  /** The same status/concept is recorded several inconsistent ways. */
  | 'competing_encodings';

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
 *  (c) the page's DATA does not load: its primary figure query returns no rows, or every
 *      number the page renders is zero → `no_data` / `all_zeros` (see
 *      {@link verifyDashboardData}). A page of zeros is broken, not healthy — binding
 *      alone (tables exist, SQL parses) passed exactly that page and it shipped as "done".
 *
 * Says nothing about INTENT — that judgment is soft and stays with {@link qaDashboard}.
 * Bounded (caps the executed queries) and never throws — on an internal fault it returns []
 * so the gate can only ever catch a real defect, never manufacture one.
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
    // Each query is executed ONCE and its result feeds both checks — the binding
    // verdict (did it run?) and the rendered-value verdict (did it show anything?).
    const rendered = emptyRendered();
    for (const q of extractDashboardSql(html)) {
      if (!q.dynamic && rendered.executed < MAX_QUERIES) {
        const first = rendered.executed === 0;
        rendered.executed++;
        const r = await runDashboardSql(db, q.sql);
        if ('error' in r) {
          rendered.errors.push({ query: q.sql, error: r.error });
          issues.push({ kind: 'sql_error', query: q.sql, detail: r.error });
        } else {
          foldRenderedRows(rendered, q.sql, r.rows, first);
        }
      } else {
        const ctes = new Set(extractCteNames(q.sql).map((c) => c.toLowerCase()));
        for (const name of extractSqlFromJoinTables(q.sql)) {
          if (!ctes.has(name.toLowerCase())) flagMissing(name);
        }
      }
    }
    // A page that fails to BIND is already condemned; the data verdict would only add
    // noise on top of the real fault. When it binds cleanly, whether it actually shows
    // anything is the remaining honesty question.
    if (issues.length === 0) {
      finalizeRendered(rendered);
      issues.push(...(await dataVerdict(db, html, rendered)));
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
  const dataless = issues
    .filter((i) => i.kind === 'no_data' || i.kind === 'all_zeros')
    .map((i) => i.detail);
  const parts: string[] = [];
  if (missing.length > 0) parts.push(missing.join(' '));
  if (errors.length > 0) parts.push(`A data query failed: ${errors.join('; ')}.`);
  if (dataless.length > 0) parts.push(dataless.join(' '));
  // A page of zeros is a DIFFERENT failure from a missing table, and needs a different
  // next step: the data is there, the question is which rows count. Say what the page
  // would have shown, then put the choice to the user instead of guessing at it.
  const next =
    dataless.length > 0 && missing.length === 0 && errors.length === 0
      ? `Tell the user exactly what the page would have shown (zeros / no rows) and what is ` +
        `really in the data. Then look before you guess: read the actual values (list_rows / ` +
        `search) and ASK which rows should count — the same status is often recorded several ` +
        `inconsistent ways, and rows are often relationships rather than one row per thing, so ` +
        `counting rows overcounts. If the fix is dirty VALUES rather than a wrong page, clean ` +
        `the rows themselves (update_row / bulk_update / dedup / merge_rows) — never by ` +
        `re-authoring the dashboard.`
      : `Tell the user plainly what data is missing and offer to bring it in — if they attached ` +
        `a spreadsheet, call import_spreadsheet with its file id to import it, otherwise offer ` +
        `to connect the source.`;
  return (
    `The dashboard was NOT created because its data does not load. ${parts.join(' ')} ${next} ` +
    `Do NOT report it as ready, do NOT state any figure the page does not actually show, and ` +
    `do NOT tell them to "try again" — retrying changes nothing on its own.`
  );
}

// ── What the page actually RENDERS ───────────────────────────────────────────
//
// Binding proves the tables exist and the SQL parses. It does not prove the page
// SHOWS anything: a count with a filter that matches nothing binds perfectly and
// renders `0`. Everything below reads the values the page will actually display,
// so a diagnosis can speak about the rendered page instead of about the SQL.

/** One number the page will display, with the column label it renders under. */
export interface RenderedValue {
  /** The query that produces it. */
  query: string;
  /** The column name the value comes back under — what the tile is labelled. */
  label: string;
  value: number;
}

/** The values a dashboard page will actually show, read by executing its queries. */
export interface RenderedDashboard {
  /** How many of the page's queries were executed (templated ones can't be). */
  executed: number;
  /** Queries that failed to run, with the engine's error. */
  errors: { query: string; error: string }[];
  /** The FIRST executable query — the headline figure — returned no rows. */
  primaryEmpty: boolean;
  /** At least one query returned at least one row. */
  anyRows: boolean;
  /** Every number the page renders, in query order (capped). */
  values: RenderedValue[];
  /** There is at least one rendered number and every one of them is zero. */
  allZero: boolean;
}

/** Rows read per query when harvesting rendered values (a tile/chart shows few). */
const RENDERED_ROW_SCAN = 20;
/** Hard cap on harvested values, so a wide result can't balloon the check. */
const RENDERED_VALUE_CAP = 60;

/**
 * Coerce a cell to the number the page would display. Postgres returns `COUNT(*)`
 * as a decimal STRING (bigint), SQLite as a number — both are the same rendered
 * figure, so both must count, or the all-zeros check would silently pass on cloud.
 */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '' || !/^[+-]?\d+(?:\.\d+)?$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function emptyRendered(): RenderedDashboard {
  return {
    executed: 0,
    errors: [],
    primaryEmpty: false,
    anyRows: false,
    values: [],
    allZero: false,
  };
}

/**
 * Fold one query's result into the rendered picture. Shared so the binding gate
 * and {@link readRenderedValues} read a query's rows the SAME way — and so the
 * gate never has to execute the page's queries a second time to get them.
 */
function foldRenderedRows(
  out: RenderedDashboard,
  query: string,
  rows: unknown[],
  first: boolean,
): void {
  if (rows.length === 0) {
    if (first) out.primaryEmpty = true;
    return;
  }
  out.anyRows = true;
  for (const row of rows.slice(0, RENDERED_ROW_SCAN)) {
    if (!row || typeof row !== 'object') continue;
    for (const [label, cell] of Object.entries(row as Record<string, unknown>)) {
      const n = toNumber(cell);
      if (n === null || out.values.length >= RENDERED_VALUE_CAP) continue;
      out.values.push({ query, label, value: n });
    }
  }
}

function finalizeRendered(out: RenderedDashboard): RenderedDashboard {
  out.allZero = out.values.length > 0 && out.values.every((v) => v.value === 0);
  return out;
}

/**
 * Execute a page's queries and collect the values it will render. Bounded (same
 * query cap as the QA pass, a row cap per query, a total value cap) and read-only.
 */
export async function readRenderedValues(db: Lattice, html: string): Promise<RenderedDashboard> {
  const out = emptyRendered();
  for (const q of extractDashboardSql(html)) {
    if (q.dynamic || out.executed >= MAX_QUERIES) continue;
    const first = out.executed === 0;
    out.executed++;
    const r = await runDashboardSql(db, q.sql);
    if ('error' in r) out.errors.push({ query: q.sql, error: r.error });
    else foldRenderedRows(out, q.sql, r.rows, first);
  }
  return finalizeRendered(out);
}

/** Rows a table currently holds, capped so the probe stays cheap on a big table. */
const SOURCE_COUNT_CAP = 5000;

/** Live row counts for the tables a page reads (unknown/unreadable tables skipped). */
async function sourceRowCounts(
  db: Lattice,
  html: string,
): Promise<{ table: string; rows: number; capped: boolean }[]> {
  const registered = new Set(db.getRegisteredTableNames());
  const out: { table: string; rows: number; capped: boolean }[] = [];
  for (const table of extractSourceTables(html) ?? []) {
    if (!registered.has(table)) continue;
    try {
      const opts: BoundedCountOptions = { cap: SOURCE_COUNT_CAP };
      // No `deleted_at` filter is applied by default, so tombstones would otherwise
      // be counted as live data and mask an empty table.
      if (db.getRegisteredColumns(table)?.deleted_at !== undefined) {
        opts.filters = [{ col: 'deleted_at', op: 'isNull' }];
      }
      const n = await db.boundedCount(table, opts);
      out.push({ table, rows: Math.min(n, SOURCE_COUNT_CAP), capped: n > SOURCE_COUNT_CAP });
    } catch (e) {
      // Loud, never silent — but one uncountable table must not sink the whole check.
      console.warn(`[dashboard-qa] could not count "${table}": ${(e as Error).message}`);
    }
  }
  return out;
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** "people holds 6 rows, roles holds 2 rows" — what is really behind the page. */
function describeSources(sources: { table: string; rows: number; capped: boolean }[]): string {
  return sources
    .map((s) => `${s.table} holds ${plural(s.rows, 'row')}${s.capped ? '+' : ''}`)
    .join(', ');
}

/** "headcount = 0, temps = 0" — what the page will put on screen. */
function describeRendered(values: RenderedValue[]): string {
  return values
    .slice(0, 6)
    .map((v) => `${v.label} = ${String(v.value)}`)
    .join(', ');
}

/**
 * The honesty check binding could not make: does the page actually SHOW anything?
 *
 * Two hard failures, both of which a binding-only gate passes:
 *  - `no_data` — the PRIMARY figure query (the first one the page runs; the authoring
 *    contract puts the key-number tiles first) returns no rows, so the headline is blank;
 *  - `all_zeros` — every number the page renders is zero.
 *
 * Each detail states what the page would show AND what is really in the source tables,
 * so the two very different causes stay distinguishable: the data was never imported
 * (bring it in) versus the query does not match the data as stored (fix the match, or
 * clean the rows). Never throws — a probe fault reports no defect rather than inventing
 * or hiding one.
 */
export async function verifyDashboardData(db: Lattice, html: string): Promise<DashboardQaIssue[]> {
  try {
    return await dataVerdict(db, html, await readRenderedValues(db, html));
  } catch (e) {
    console.warn('[dashboard-qa] rendered-value verification failed:', (e as Error).message);
    return [];
  }
}

/**
 * The verdict itself, over a page whose queries have ALREADY been executed — so the
 * binding gate can reuse the results it just produced instead of running every query
 * a second time.
 */
async function dataVerdict(
  db: Lattice,
  html: string,
  rendered: RenderedDashboard,
): Promise<DashboardQaIssue[]> {
  try {
    // Nothing executable (a page that reads via lattice.query, or only templated SQL)
    // has no statically-knowable rendered value — the static checks own it.
    if (rendered.executed === 0) return [];
    // A failing query is the fault to report; a data verdict on top is noise.
    if (rendered.errors.length > 0) return [];
    if (!rendered.primaryEmpty && !rendered.allZero) return [];

    const sources = await sourceRowCounts(db, html);
    const withRows = sources.filter((s) => s.rows > 0);
    const context =
      withRows.length > 0
        ? `The data it reads is NOT empty (${describeSources(withRows)}), so the query does not ` +
          `match the data as it is actually stored — check the column, the spelling/case, and ` +
          `whether the value is recorded somewhere else entirely.`
        : sources.length > 0
          ? `The tables it reads hold no rows yet (${describeSources(sources)}) — the data has ` +
            `not been brought in.`
          : `None of the tables it reads could be counted, so what is behind it is unknown.`;

    if (rendered.primaryEmpty) {
      const primary = extractDashboardSql(html).find((q) => !q.dynamic)?.sql;
      return [
        {
          kind: 'no_data',
          ...(primary ? { query: primary } : {}),
          detail: `The dashboard's primary figure returns NO rows, so the page renders empty. ${context}`,
        },
      ];
    }
    return [
      {
        kind: 'all_zeros',
        detail: `Every number the page renders is zero (${describeRendered(rendered.values)}). ${context}`,
      },
    ];
  } catch (e) {
    // A probe fault proves nothing — report no defect rather than inventing one.
    console.warn('[dashboard-qa] rendered-value verdict failed:', (e as Error).message);
    return [];
  }
}

/** Figures below this are list sizes / ordinals ("top 5"), not asserted totals. */
const CLAIM_MIN_TOTAL = 21;

/**
 * Numbers an answer ASSERTS about the data. Years and percentages are excluded —
 * they are context ("since 2026", "up 12%"), not figures the page renders.
 */
function claimedNumbers(claim: string): number[] {
  const out: number[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(%)?/g;
  for (const m of claim.matchAll(re)) {
    if (m[2]) continue; // a percentage
    const n = Number((m[1] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    if (Number.isInteger(n) && n >= 1900 && n <= 2100) continue; // a year
    out.push(n);
  }
  return out;
}

/**
 * Reconcile a stated figure against the page it is stated about.
 *
 * This is the exact failure this whole module exists for: an answer asserted a
 * specific headcount that was never on the page, because the page rendered zero.
 * Two rules, both deliberately conservative:
 *  - the answer asserts a non-zero figure while the page renders nothing but zeros
 *    (or no rows at all) — always wrong, whatever the figure was;
 *  - the answer asserts a TOTAL the page does not show anywhere; small numbers are
 *    ignored, since "top 5" is a list size, not a claim about the data.
 */
export function checkClaimAgainstRendered(
  claim: string,
  rendered: RenderedDashboard,
): DashboardQaIssue[] {
  const numbers = claimedNumbers(claim).filter((n) => n !== 0);
  if (numbers.length === 0 || rendered.executed === 0) return [];
  if (rendered.allZero || !rendered.anyRows) {
    const shows = rendered.allZero
      ? `every number it renders is zero (${describeRendered(rendered.values)})`
      : 'it renders no rows at all';
    return [
      {
        kind: 'claim_unverified',
        detail:
          `The answer states ${numbers.map((n) => String(n)).join(', ')}, but the page shows ` +
          `no such figure — ${shows}. State what the page actually shows, and do not repeat ` +
          `a number that was never rendered.`,
      },
    ];
  }
  const shown = new Set(rendered.values.map((v) => v.value));
  return numbers
    .filter((n) => n >= CLAIM_MIN_TOTAL && !shown.has(n))
    .slice(0, 2)
    .map((n) => ({
      kind: 'claim_unverified' as const,
      detail:
        `The answer states ${String(n)}, which the page does not show anywhere. It renders ` +
        `${describeRendered(rendered.values)}. Verify the figure against the page before stating it.`,
    }));
}

// ── Pre-build data readiness ─────────────────────────────────────────────────
//
// The zeros usually start BEFORE the page is authored: the column the request
// names does not exist, the rows are relationships rather than one row per thing,
// and the status being asked about is recorded three inconsistent ways. Picking
// one of those silently produces a confident number nobody can reproduce.
//
// So this measures the dirt with counts and hands back a QUESTION. It is not a
// gate: it never refuses to build anything and never decides for the user — it
// makes the competing definitions visible so the user can choose one.

/** One value (or column) with how many rows it covers. */
export interface ReadinessSample {
  value: string;
  count: number;
}

export interface ReadinessFinding {
  kind: 'duplicate_keys' | 'no_clean_category' | 'competing_encodings';
  table: string;
  /** The column the finding is about, when it is about one. */
  column?: string;
  /** Plain language, with the real counts in it. */
  detail: string;
  /** The evidence: values (or columns) with their row counts. */
  samples: ReadinessSample[];
}

export interface DataReadinessReport {
  table: string;
  /** Live rows in the table (capped). */
  rows: number;
  /** True when nothing needs deciding — build away. */
  ready: boolean;
  findings: ReadinessFinding[];
  /** The question to put to the user, with the competing options + counts. */
  question: string | null;
}

export interface ReadinessRequest {
  table: string;
  /** The column that identifies ONE real-world thing (a name, a code). */
  keyColumn?: string;
  /** The categorical column the request wants to group/split by — may not exist. */
  groupBy?: string;
  /** The concept the request is about ("temp", "active"), to find its encodings. */
  concept?: string;
  /** Distinct values above which a column is free text, not a category. */
  maxCategories?: number;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Above this many distinct values a column is free text, not something to group by. */
const MAX_CATEGORY_VALUES = 25;
/** Columns scanned when hunting for a category / competing encodings. */
const MAX_SCANNED_COLUMNS = 16;
/** Values listed as evidence per finding. */
const SAMPLE_LIMIT = 5;
/** Bookkeeping columns that are never a category or a key. */
const NON_DATA_COLUMNS = new Set(['id', 'deleted_at', 'created_at', 'updated_at']);

/** Quote an identifier for both engines, refusing anything that isn't a plain name. */
function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`"${name}" is not a usable column/table name`);
  return `"${name}"`;
}

/** A literal safe to inline (there is no parameter binding on this SQL surface). */
function safeConcept(concept: string): string {
  const t = concept.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9 _-]{0,39}$/.test(t)) {
    throw new Error(
      `"${concept}" cannot be searched for as-is — use plain letters, digits, spaces, - or _`,
    );
  }
  return t;
}

async function readinessRows(db: Lattice, sql: string): Promise<Record<string, unknown>[]> {
  const r = await runDashboardSql(db, sql);
  // Loud: a probe that cannot run must never read as "nothing wrong with the data".
  if ('error' in r) throw new Error(`data probe failed: ${r.error}`);
  return r.rows.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
}

async function readinessOne(db: Lattice, sql: string): Promise<Record<string, unknown>> {
  return (await readinessRows(db, sql))[0] ?? {};
}

function countOf(row: Record<string, unknown>, key: string): number {
  return toNumber(row[key]) ?? 0;
}

/** `WHERE deleted_at IS NULL` when the table is soft-deletable, else ''. */
function liveWhere(db: Lattice, table: string): string {
  return db.getRegisteredColumns(table)?.deleted_at !== undefined
    ? ` WHERE ${quoteIdent('deleted_at')} IS NULL`
    : '';
}

/** The columns worth scanning: declared, plain-named, not bookkeeping. */
function scannableColumns(db: Lattice, table: string): string[] {
  const cols = db.getRegisteredColumns(table) ?? {};
  return Object.keys(cols)
    .filter((c) => IDENT_RE.test(c) && !NON_DATA_COLUMNS.has(c.toLowerCase()))
    .slice(0, MAX_SCANNED_COLUMNS);
}

/**
 * Scannable columns that hold TEXT. Text-matching (`LOWER(col) LIKE …`) is only
 * defined for text: SQLite quietly coerces a number, Postgres raises "function
 * lower(integer) does not exist" — so an unfiltered scan would work locally and
 * fail on cloud. Filtering here keeps the probe portable and cheaper.
 */
function textColumns(db: Lattice, table: string): string[] {
  const cols = db.getRegisteredColumns(table) ?? {};
  const fieldTypes = db.getRegisteredFieldTypes(table);
  return scannableColumns(db, table).filter((c) => {
    const declared = fieldTypes?.[c];
    if (declared !== undefined) return declared === 'text';
    return /char|text|clob/i.test(cols[c] ?? '');
  });
}

/** Distinct + non-empty counts for one column. */
async function columnShape(
  db: Lattice,
  table: string,
  column: string,
): Promise<{ distinct: number; filled: number }> {
  const row = await readinessOne(
    db,
    `SELECT COUNT(DISTINCT ${quoteIdent(column)}) AS "distinct_values", ` +
      `COUNT(${quoteIdent(column)}) AS "filled" FROM ${quoteIdent(table)}${liveWhere(db, table)}`,
  );
  return { distinct: countOf(row, 'distinct_values'), filled: countOf(row, 'filled') };
}

/** Top values of a column with their row counts (optionally only the repeated ones). */
async function valueCounts(
  db: Lattice,
  table: string,
  column: string,
  opts: { repeatedOnly?: boolean; matching?: string; limit?: number } = {},
): Promise<ReadinessSample[]> {
  const col = quoteIdent(column);
  const conds = [`${col} IS NOT NULL`];
  if (opts.matching !== undefined) conds.push(`LOWER(${col}) LIKE '%${opts.matching}%'`);
  const live = liveWhere(db, table);
  const clause = live ? `${live} AND ${conds.join(' AND ')}` : ` WHERE ${conds.join(' AND ')}`;
  const rows = await readinessRows(
    db,
    `SELECT ${col} AS "value", COUNT(*) AS "n" FROM ${quoteIdent(table)}${clause} ` +
      `GROUP BY ${col}${opts.repeatedOnly === true ? ' HAVING COUNT(*) > 1' : ''} ` +
      `ORDER BY COUNT(*) DESC, ${col} LIMIT ${String(opts.limit ?? SAMPLE_LIMIT)}`,
  );
  return rows.map((r) => ({ value: cellText(r.value), count: countOf(r, 'n') }));
}

/** A cell as the text a user would see — never a stringified object. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

/** Rows matching a concept in one column. */
async function conceptMatches(
  db: Lattice,
  table: string,
  column: string,
  concept: string,
): Promise<number> {
  const where = liveWhere(db, table) ? `${liveWhere(db, table)} AND ` : ' WHERE ';
  const row = await readinessOne(
    db,
    `SELECT COUNT(*) AS "n" FROM ${quoteIdent(table)}${where}` +
      `LOWER(${quoteIdent(column)}) LIKE '%${concept}%'`,
  );
  return countOf(row, 'n');
}

function sampleList(samples: ReadinessSample[]): string {
  return samples.map((s) => `"${s.value}" (${plural(s.count, 'row')})`).join(', ');
}

/**
 * Measure whether the data can answer the request as asked, BEFORE anything is
 * built on it. Reports what is dirty, with counts and example values, plus the
 * question to ask — it decides nothing and blocks nothing.
 *
 * Throws (loudly) only when the request itself is unusable — an unknown table or
 * an unsearchable concept — because reporting a clean bill of health for a table
 * that does not exist is exactly the dishonesty this is here to remove.
 */
export async function checkDataReadiness(
  db: Lattice,
  req: ReadinessRequest,
): Promise<DataReadinessReport> {
  const table = req.table;
  const columns = db.getRegisteredColumns(table);
  if (!columns) {
    throw new Error(`Unknown table "${table}" — there is nothing to check readiness on.`);
  }
  const maxCategories = req.maxCategories ?? MAX_CATEGORY_VALUES;
  const findings: ReadinessFinding[] = [];
  const totalRow = await readinessOne(
    db,
    `SELECT COUNT(*) AS "n" FROM ${quoteIdent(table)}${liveWhere(db, table)}`,
  );
  const rows = countOf(totalRow, 'n');

  // (a) One thing, many rows. Counting rows then overcounts — the reported figure
  //     is real under a definition nobody agreed to.
  if (req.keyColumn !== undefined) {
    const key = req.keyColumn;
    if (columns[key] === undefined) {
      findings.push({
        kind: 'no_clean_category',
        table,
        column: key,
        detail: `There is no "${key}" column in "${table}", so rows cannot be identified by it.`,
        samples: [],
      });
    } else {
      const shape = await columnShape(db, table, key);
      if (rows > 0 && shape.distinct > 0 && shape.distinct < rows) {
        const dups = await valueCounts(db, table, key, { repeatedOnly: true });
        findings.push({
          kind: 'duplicate_keys',
          table,
          column: key,
          detail:
            `"${table}" has ${plural(rows, 'row')} but only ${String(shape.distinct)} distinct ` +
            `${key} values${dups.length > 0 ? ` (${sampleList(dups)})` : ''}. Rows are not one ` +
            `per ${key}, so counting rows counts the same one more than once.`,
          samples: dups,
        });
      }
    }
  }

  // (b) The grouping the request names may not exist, or may be free text.
  if (req.groupBy !== undefined) {
    const wanted = req.groupBy;
    if (columns[wanted] === undefined) {
      const candidates: ReadinessSample[] = [];
      for (const c of textColumns(db, table)) {
        const shape = await columnShape(db, table, c);
        if (shape.distinct >= 2 && shape.distinct <= maxCategories && shape.distinct < rows) {
          candidates.push({ value: c, count: shape.distinct });
        }
      }
      candidates.sort((a, b) => a.count - b.count);
      const top = candidates.slice(0, 6);
      findings.push({
        kind: 'no_clean_category',
        table,
        column: wanted,
        detail:
          `There is no "${wanted}" column in "${table}" — it does not exist, so nothing can be ` +
          `grouped by it as asked. ` +
          (top.length > 0
            ? `The columns that could stand in for it are ${top
                .map((c) => `${c.value} (${String(c.count)} distinct values)`)
                .join(', ')} — they are different questions, so this needs the user's choice.`
            : `No column in this table looks like a category, so the grouping has to come from ` +
              `somewhere else.`),
        samples: top,
      });
    } else {
      const shape = await columnShape(db, table, wanted);
      if (shape.distinct > maxCategories) {
        const top = await valueCounts(db, table, wanted);
        findings.push({
          kind: 'no_clean_category',
          table,
          column: wanted,
          detail:
            `"${wanted}" holds ${String(shape.distinct)} distinct values across ` +
            `${plural(rows, 'row')} — it is free text, not a clean category. Grouping by it ` +
            `produces one bucket per spelling${top.length > 0 ? ` (${sampleList(top)})` : ''}.`,
          samples: top,
        });
      }
    }
  }

  // (c) The same concept recorded in several places / spellings at once.
  if (req.concept !== undefined) {
    const needle = safeConcept(req.concept);
    const perColumn: ReadinessSample[] = [];
    const variants: string[] = [];
    for (const c of textColumns(db, table)) {
      const n = await conceptMatches(db, table, c, needle);
      if (n === 0) continue;
      perColumn.push({ value: c, count: n });
      const vals = await valueCounts(db, table, c, { matching: needle, limit: 3 });
      if (vals.length > 1) variants.push(`${c}: ${sampleList(vals)}`);
    }
    perColumn.sort((a, b) => b.count - a.count);
    if (perColumn.length > 1) {
      findings.push({
        kind: 'competing_encodings',
        table,
        detail:
          `"${req.concept}" is recorded in ${String(perColumn.length)} different places in ` +
          `"${table}": ${perColumn
            .map((c) => `${c.value} (${plural(c.count, 'row')})`)
            .join(', ')}. These disagree` +
          `${variants.length > 0 ? ` — and the values themselves vary (${variants.join('; ')})` : ''}, ` +
          `so which rows count as "${req.concept}" is a decision, not a lookup.`,
        samples: perColumn,
      });
    }
  }

  return {
    table,
    rows,
    ready: findings.length === 0,
    findings,
    question: readinessQuestion(req, findings),
  };
}

/**
 * The question to put to the user: every competing definition, with its counts,
 * and an explicit ask. Null when there is nothing to decide.
 */
export function readinessQuestion(
  req: ReadinessRequest,
  findings: ReadinessFinding[],
): string | null {
  if (findings.length === 0) return null;
  const lines: string[] = [];
  for (const f of findings) {
    if (f.kind === 'duplicate_keys') {
      lines.push(`• ${f.detail} Should I count distinct ${f.column ?? 'values'} instead of rows?`);
    } else if (f.kind === 'no_clean_category') {
      lines.push(`• ${f.detail} Which one did you mean?`);
    } else {
      lines.push(`• ${f.detail} Which of these should count as "${req.concept ?? 'it'}"?`);
    }
  }
  return (
    `Before I build this, one thing needs your call — the data does not answer it cleanly as ` +
    `stored:\n${lines.join('\n')}\nTell me which definition to use and I will build it that way ` +
    `(and I can clean the underlying rows instead, if the values themselves are wrong).`
  );
}
