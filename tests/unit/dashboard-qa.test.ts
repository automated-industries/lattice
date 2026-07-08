import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { extractDashboardSql } from '../../src/gui/dashboard-row.js';
import { validateDashboardSql, runDashboardSql } from '../../src/gui/dashboard-sql.js';
import {
  qaDashboard,
  qaIssuesNote,
  verifyDashboardBinding,
  bindingFailureMessage,
} from '../../src/gui/ai/dashboard-qa.js';
import type { LlmClient } from '../../src/gui/ai/chat.js';

/**
 * A dashboard's SQL queries get an automatic QA pass BEFORE the page is shown: run the
 * queries, flag SQL errors + empty results (wrong join / terminology / literal-vs-fuzzy),
 * judge intent-match + over-confidence with the model, and repair (bounded) — surfacing
 * anything that survives instead of silently shipping a flawed dashboard.
 */

const dash = (sql: string) => `<html><body><script>lattice.sql('${sql}')</script></body></html>`;

/** A fake model client whose intent-judgment turn returns `judgeJson`. */
const fakeClient = (judgeJson = '```json\n[]\n```'): LlmClient =>
  ({
    runTurn: () => Promise.resolve({ stopReason: 'end_turn', text: judgeJson, toolUses: [] }),
  }) as unknown as LlmClient;

describe('extractDashboardSql', () => {
  it('pulls each lattice.sql statement out of the page, in order', () => {
    const html =
      '<script>lattice.sql(\'SELECT a FROM t\'); lattice.sql("SELECT b FROM u")</script>';
    expect(extractDashboardSql(html)).toEqual([
      { sql: 'SELECT a FROM t', dynamic: false },
      { sql: 'SELECT b FROM u', dynamic: false },
    ]);
  });
  it('resolves an escaped delimiter quote to the runtime SQL (not truncated)', () => {
    // JS source: lattice.sql('SELECT * FROM t WHERE r = \'East\'') → runtime SQL has 'East'.
    const html = "lattice.sql('SELECT * FROM t WHERE r = \\'East\\'')";
    expect(extractDashboardSql(html)).toEqual([
      { sql: "SELECT * FROM t WHERE r = 'East'", dynamic: false },
    ]);
  });
  it('marks a backtick ${…} template dynamic but a literal ${ in a quoted string static', () => {
    expect(extractDashboardSql('lattice.sql(`SELECT * FROM t WHERE id = ${x}`)')).toEqual([
      { sql: 'SELECT * FROM t WHERE id = ${x}', dynamic: true },
    ]);
    expect(extractDashboardSql("lattice.sql('SELECT b FROM t WHERE b LIKE \\'%${%\\'')")).toEqual([
      { sql: "SELECT b FROM t WHERE b LIKE '%${%'", dynamic: false },
    ]);
  });
  it('returns [] when the page runs no lattice.sql query', () => {
    expect(extractDashboardSql('<div>no data</div>')).toEqual([]);
  });
});

describe('validateDashboardSql', () => {
  it('accepts a single SELECT / WITH', () => {
    expect(validateDashboardSql('SELECT 1')).toEqual({ ok: true, sql: 'SELECT 1' });
  });
  it('rejects non-SELECT, multiple statements, and protected tables', () => {
    expect(validateDashboardSql('DELETE FROM t').ok).toBe(false);
    expect(validateDashboardSql('SELECT 1; SELECT 2').ok).toBe(false);
    expect(validateDashboardSql('SELECT * FROM secrets').ok).toBe(false);
    expect(validateDashboardSql('SELECT * FROM chat_messages').ok).toBe(false);
  });
});

describe('dashboard QA', () => {
  let tmpDir: string;
  let db: Lattice;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-dashqa-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    db.define('sales', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        region: 'TEXT',
        amount: 'INTEGER',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: '.s/sales.md',
    });
    await db.init();
    await db.insert('sales', { id: 's1', region: 'East', amount: 10 });
    await db.insert('sales', { id: 's2', region: 'West', amount: 20 });
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runDashboardSql executes a valid SELECT, reports empty, and reports errors', async () => {
    const ok = await runDashboardSql(db, 'SELECT region, amount FROM sales ORDER BY amount');
    expect('rows' in ok && ok.rows.length).toBe(2);
    const empty = await runDashboardSql(db, "SELECT * FROM sales WHERE region = 'Nowhere'");
    expect('rows' in empty && empty.rows.length).toBe(0);
    const bad = await runDashboardSql(db, 'SELECT nonexistent_col FROM sales');
    expect('error' in bad).toBe(true);
  });

  it('passes a good dashboard unchanged (rows returned, model finds no intent issue)', async () => {
    const html = dash('SELECT region, SUM(amount) AS total FROM sales GROUP BY region');
    const reAuthor = vi.fn();
    const out = await qaDashboard(
      { db, client: fakeClient(), model: 'm', reAuthor },
      html,
      'total sales by region',
    );
    expect(out.issues).toEqual([]);
    expect(out.rounds).toBe(0);
    expect(out.html).toBe(html);
    expect(reAuthor).not.toHaveBeenCalled();
  });

  it('flags an empty result, repairs once, and ships the fixed page', async () => {
    const broken = dash("SELECT * FROM sales WHERE region = 'Nowhere'"); // 0 rows
    const fixed = dash('SELECT region, amount FROM sales'); // returns rows
    const reAuthor = vi.fn(() => Promise.resolve(fixed));
    const out = await qaDashboard(
      { db, client: fakeClient(), model: 'm', reAuthor },
      broken,
      'sales by region',
    );
    // The empty-result query triggered exactly one repair; the fixed page passes re-QA.
    expect(reAuthor).toHaveBeenCalledTimes(1);
    const brief = String(reAuthor.mock.calls[0]?.[0]);
    expect(brief).toMatch(/no rows|LIKE|join/i); // the repair brief names the likely causes
    expect(out.rounds).toBe(1);
    expect(out.html).toBe(fixed);
    expect(out.issues).toEqual([]); // clean after repair
  });

  it('surfaces a residual SQL error when repair does not fix it', async () => {
    const bad = dash('SELECT nonexistent_col FROM sales');
    const reAuthor = vi.fn(() => Promise.resolve(bad)); // "repair" returns the same broken page
    const out = await qaDashboard({ db, client: fakeClient(), model: 'm', reAuthor }, bad, 'x');
    expect(out.issues.some((i) => i.kind === 'sql_error')).toBe(true);
    expect(out.rounds).toBe(1); // one repair attempt, then stop
  });

  it('never blocks the dashboard: a repair re-author failure returns the last HTML + issues', async () => {
    const empty = dash('SELECT * FROM sales WHERE 1=0');
    const reAuthor = vi.fn(() => Promise.reject(new Error('author down')));
    const out = await qaDashboard({ db, client: fakeClient(), model: 'm', reAuthor }, empty, 'x');
    expect(out.html).toBe(empty); // last good HTML shipped, no throw
    expect(out.issues.some((i) => i.kind === 'no_data')).toBe(true);
  });

  it('reports the model’s intent-mismatch judgment even when the query returns rows', async () => {
    const html = dash('SELECT region FROM sales'); // returns rows, but "wrong thing"
    const judge =
      '```json\n' +
      JSON.stringify([{ kind: 'intent_mismatch', detail: 'shows regions, not revenue' }]) +
      '\n```';
    // No repair (maxRounds 0) so we see the raw judgment.
    const out = await qaDashboard(
      { db, client: fakeClient(judge), model: 'm', reAuthor: vi.fn(), maxRounds: 0 },
      html,
      'total revenue',
    );
    expect(out.issues).toEqual([{ kind: 'intent_mismatch', detail: 'shows regions, not revenue' }]);
    expect(out.rounds).toBe(0);
  });

  it('does NOT flag a dashboard that reads live data via lattice.query (no lattice.sql)', async () => {
    const html = "<script>lattice.query('sales', { limit: 100 })</script>";
    const out = await qaDashboard(
      { db, client: fakeClient(), model: 'm', reAuthor: vi.fn(), maxRounds: 0 },
      html,
      'list sales',
    );
    expect(out.issues).toEqual([]); // reads data via query → no false no_query, no repair
  });

  it('runs an escaped-quote query correctly (no spurious SQL error / repair)', async () => {
    const html = "<script>lattice.sql('SELECT * FROM sales WHERE region = \\'East\\'')</script>";
    const out = await qaDashboard(
      { db, client: fakeClient(), model: 'm', reAuthor: vi.fn(), maxRounds: 0 },
      html,
      'east sales',
    );
    // region = 'East' matches the seeded row → rows returned, so no sql_error / no_data.
    expect(out.issues).toEqual([]);
  });

  it('flags a dashboard that runs no data query at all', async () => {
    const out = await qaDashboard(
      { db, client: fakeClient(), model: 'm', reAuthor: vi.fn(), maxRounds: 0 },
      '<html><body><h1>Sales: 42</h1></body></html>',
      'sales',
    );
    expect(out.issues.some((i) => i.kind === 'no_query')).toBe(true);
  });

  // ── The deterministic binding gate (Fix A) — always-on, LLM-free honesty check ──
  it('binding gate: flags a missing table read via lattice.query (missing_table)', async () => {
    const html = "<script>lattice.query('ghost_accounts', { limit: 10 })</script>";
    const issues = await verifyDashboardBinding(db, html, ['sales']);
    expect(issues.some((i) => i.kind === 'missing_table')).toBe(true);
  });

  it('binding gate: flags a ghost table in a TEMPLATED lattice.sql (which the QA loop skips)', async () => {
    const html = 'lattice.sql(`SELECT * FROM ghost_accounts WHERE id = ${x}`)';
    const issues = await verifyDashboardBinding(db, html, ['sales']);
    expect(issues.some((i) => i.kind === 'missing_table')).toBe(true);
  });

  it('binding gate: does NOT flag a same-statement CTE name as a missing table', async () => {
    const html =
      'lattice.sql(`WITH recent AS (SELECT * FROM sales) SELECT region FROM recent WHERE amount > ${n}`)';
    const issues = await verifyDashboardBinding(db, html, ['sales']);
    expect(issues).toEqual([]); // `recent` is a CTE, `sales` is real → nothing missing
  });

  it('binding gate: reports sql_error when a non-templated query hits a missing table', async () => {
    const html = dash('SELECT * FROM ghost_accounts');
    const issues = await verifyDashboardBinding(db, html, ['sales']);
    expect(issues.some((i) => i.kind === 'sql_error')).toBe(true);
  });

  it('binding gate: a well-bound dashboard produces NO hard issues', async () => {
    const html = dash('SELECT region, SUM(amount) AS total FROM sales GROUP BY region');
    const issues = await verifyDashboardBinding(db, html, ['sales']);
    expect(issues).toEqual([]);
  });

  it('binding gate: an empty (0-row) but well-bound query is NOT a hard issue (stays soft)', async () => {
    const html = dash('SELECT * FROM sales WHERE amount > 999999'); // valid, binds to sales, 0 rows
    const issues = await verifyDashboardBinding(db, html, ['sales']);
    expect(issues).toEqual([]); // 0 rows is a soft QA concern, never a hard binding block
  });

  it('bindingFailureMessage names the gap and forbids a blind retry', () => {
    const msg = bindingFailureMessage([
      {
        kind: 'missing_table',
        detail: 'The dashboard reads from a table "ghost" that does not exist in this workspace.',
      },
    ]);
    expect(msg).toMatch(/not created|not saved/i);
    expect(msg).toMatch(/try again/i); // present only to forbid it
    expect(msg.toLowerCase()).toContain('ghost');
  });
});

describe('qaIssuesNote', () => {
  it('is empty for no issues and lists details otherwise', () => {
    expect(qaIssuesNote([])).toBe('');
    expect(qaIssuesNote([{ kind: 'no_data', detail: 'chart X is empty' }])).toContain(
      'chart X is empty',
    );
  });
});
