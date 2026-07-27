import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import {
  verifyDashboardBinding,
  verifyDashboardData,
  readRenderedValues,
  checkClaimAgainstRendered,
  checkDataReadiness,
  bindingFailureMessage,
} from '../../src/gui/ai/dashboard-qa.js';
import { classifyAuthoringRequest, generateHtmlFile } from '../../src/gui/ai/html-author.js';
import { handleComputed } from '../../src/gui/ai/handlers/computed.js';
import type { DispatchCtx } from '../../src/gui/ai/handlers/types.js';
import type { LlmClient } from '../../src/gui/ai/chat.js';

/**
 * A dashboard that renders nothing but zeros is BROKEN, not healthy.
 *
 * The binding-only gate proved the tables existed and the SQL parsed, so a page
 * whose headline number came back 0 shipped as "done" and the answer asserted a
 * figure that was never on the page. These cover the four halves of the fix:
 *   1. a PRIMARY query that returns no rows is a failure, not a pass;
 *   2. diagnosis reads the values the page will actually RENDER, and an asserted
 *      number that the page does not show is caught;
 *   3. "clean the data" is a row-mutation request, never a page re-author;
 *   4. before building, the dirt in the data (duplicate keys, no clean
 *      categorical column, the same status encoded several ways) is measured and
 *      put to the user as a question with counts — surfaced, never silently
 *      decided, and never a refusal.
 */

/** A page that runs the given queries in document order (quotes escaped as JS source). */
const dash = (...sql: string[]): string =>
  `<html><body><script>${sql
    .map((s) => `lattice.sql('${s.replace(/'/g, "\\'")}')`)
    .join(';')}</script></body></html>`;

const fakeClient = (): LlmClient =>
  ({
    runTurn: vi.fn(() =>
      Promise.resolve({
        stopReason: 'end_turn',
        text: '<!doctype html><html><body><h1>ok</h1></body></html>',
        toolUses: [],
      }),
    ),
  }) as unknown as LlmClient;

describe('dashboard data readiness', () => {
  let tmpDir: string;
  let db: Lattice;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-readiness-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    // Modelled on the real source data: rows are reporting RELATIONSHIPS (so a
    // person appears more than once), there is no employment-type column at all,
    // and "temp" is encoded inconsistently across two different columns.
    db.define('people', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        full_name: 'TEXT',
        job_title: 'TEXT',
        manager: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: '.p/people.md',
    });
    // Declared but never populated — the "nothing was imported yet" case.
    db.define('vacancies', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT' },
      render: () => '',
      outputFile: '.p/vacancies.md',
    });
    // A numeric column whose digits would text-match a concept if it were scanned.
    db.define('shifts', {
      columns: { id: 'TEXT PRIMARY KEY', code: 'TEXT', year_num: 'INTEGER' },
      render: () => '',
      outputFile: '.p/shifts.md',
    });
    await db.init();
    const rows = [
      ['p1', 'Ada Lovelace', 'Analyst', 'Grace'],
      ['p2', 'Ada Lovelace', 'Analyst', 'Alan'], // same person, second reporting line
      ['p3', 'Jane Roe (Temp)', 'Analyst', 'Grace'],
      ['p4', 'Bob Stone', 'Temporary Analyst', 'Grace'],
      ['p5', 'Cy Vance', 'Temp Analyst', 'Alan'],
      ['p6', 'Dee Fox', 'Senior Analyst', 'Alan'],
    ];
    for (const [id, full_name, job_title, manager] of rows) {
      await db.insert('people', { id, full_name, job_title, manager });
    }
    await db.insert('shifts', { id: 's1', code: 'S20', year_num: 2026 });
    await db.insert('shifts', { id: 's2', code: 'S20', year_num: 2026 });
    await db.insert('shifts', { id: 's3', code: 'X', year_num: 1999 });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. a primary query with no rows is a FAILURE ───────────────────────────
  describe('no_data on the primary query', () => {
    it('is reported as a hard failure, not a healthy dashboard', async () => {
      // Binds fine (real table, real column, valid SQL) but matches nothing.
      const html = dash("SELECT * FROM people WHERE job_title = 'Contractor'");
      const issues = await verifyDashboardBinding(db, html, ['people']);
      expect(issues.some((i) => i.kind === 'no_data')).toBe(true);
    });

    it('says the source data DOES have rows, so the fault is the query, not missing data', async () => {
      const html = dash("SELECT * FROM people WHERE job_title = 'Contractor'");
      const [issue] = (await verifyDashboardData(db, html)).filter((i) => i.kind === 'no_data');
      expect(issue?.detail).toMatch(/6 row/); // people holds 6 rows
      expect(issue?.detail).toMatch(/people/);
    });

    it('a primary query WITH rows is not flagged', async () => {
      const html = dash('SELECT full_name FROM people');
      expect(await verifyDashboardData(db, html)).toEqual([]);
    });

    it('the failure message names the gap, offers the choice, and forbids a blind retry', async () => {
      const html = dash("SELECT * FROM people WHERE job_title = 'Contractor'");
      const msg = bindingFailureMessage(await verifyDashboardBinding(db, html, ['people']));
      expect(msg).toMatch(/not created|not saved/i);
      expect(msg).toMatch(/try again/i); // present only to forbid it
      expect(msg).toMatch(/zero|no rows|empty/i);
    });
  });

  // ── 2. verify what the page RENDERS, not just that the SQL parses ──────────
  describe('rendered values', () => {
    it('reads the values the page will display, including a zero count', async () => {
      const rendered = await readRenderedValues(
        db,
        dash("SELECT COUNT(*) AS headcount FROM people WHERE job_title = 'Contractor'"),
      );
      expect(rendered.values).toEqual([expect.objectContaining({ label: 'headcount', value: 0 })]);
      expect(rendered.allZero).toBe(true);
    });

    it('flags an all-zeros page whose tables DO hold rows (binding-only would pass it)', async () => {
      // Every query parses, every table exists, every query returns a row — and
      // every number on the page is 0.
      const html = dash(
        "SELECT COUNT(*) AS headcount FROM people WHERE job_title = 'Contractor'",
        "SELECT COUNT(*) AS temps FROM people WHERE job_title = 'Temp'",
      );
      const issues = await verifyDashboardData(db, html);
      expect(issues.some((i) => i.kind === 'all_zeros')).toBe(true);
      // The diagnosis states what the page actually shows.
      expect(issues.map((i) => i.detail).join(' ')).toMatch(/headcount\s*=\s*0/);
    });

    it('does NOT flag a page with a real non-zero number', async () => {
      const html = dash('SELECT COUNT(*) AS headcount FROM people');
      expect(await verifyDashboardData(db, html)).toEqual([]);
    });

    it('the binding gate itself fails an all-zeros page (it is the wired path)', async () => {
      const html = dash("SELECT COUNT(*) AS headcount FROM people WHERE job_title = 'Contractor'");
      const issues = await verifyDashboardBinding(db, html, ['people']);
      expect(issues.some((i) => i.kind === 'all_zeros')).toBe(true);
      expect(bindingFailureMessage(issues)).toMatch(/headcount = 0/);
    });

    it('a page that binds and shows real numbers passes the gate untouched', async () => {
      const html = dash('SELECT COUNT(*) AS headcount FROM people', 'SELECT full_name FROM people');
      expect(await verifyDashboardBinding(db, html, ['people'])).toEqual([]);
    });

    it('an empty table reads as missing data, not as a mis-matched query', async () => {
      // `vacancies` is declared but never populated — the page is honestly all zeros
      // because nothing was imported, which is a different fix from a wrong query.
      const issues = await verifyDashboardData(db, dash('SELECT COUNT(*) AS n FROM vacancies'));
      expect(issues[0]?.kind).toBe('all_zeros');
      expect(issues[0]?.detail).toMatch(/no rows yet|not been brought in/i);
    });

    it('catches a claim of 314 against a page that renders 0', async () => {
      const rendered = await readRenderedValues(
        db,
        dash("SELECT COUNT(*) AS headcount FROM people WHERE job_title = 'Contractor'"),
      );
      const issues = checkClaimAgainstRendered('There are 314 temps in the org.', rendered);
      expect(issues.some((i) => i.kind === 'claim_unverified')).toBe(true);
      expect(issues[0]?.detail).toContain('314');
      expect(issues[0]?.detail).toMatch(/\b0\b/);
    });

    it('accepts a claim that matches what the page renders', async () => {
      const rendered = await readRenderedValues(
        db,
        dash('SELECT COUNT(*) AS headcount FROM people'),
      );
      expect(checkClaimAgainstRendered('The org has 6 reporting lines.', rendered)).toEqual([]);
    });

    it('does not flag a year or a percentage as an unverified figure', async () => {
      const rendered = await readRenderedValues(
        db,
        dash('SELECT COUNT(*) AS headcount FROM people'),
      );
      expect(checkClaimAgainstRendered('Since 2026, headcount is up 12%.', rendered)).toEqual([]);
    });
  });

  // ── 3. "clean the data" is a row mutation, not a dashboard edit ────────────
  describe('data-cleaning requests', () => {
    it('classifies "clean the data" as a row-mutation request', () => {
      const c = classifyAuthoringRequest('clean the data');
      expect(c.kind).toBe('data_cleaning');
      expect(c.kind === 'data_cleaning' && c.tools).toEqual(
        expect.arrayContaining(['update_row', 'bulk_update']),
      );
    });

    it('classifies de-duplication and value normalization as row mutations too', () => {
      expect(classifyAuthoringRequest('remove the duplicate rows in people').kind).toBe(
        'data_cleaning',
      );
      expect(classifyAuthoringRequest('standardize the job title values').kind).toBe(
        'data_cleaning',
      );
    });

    it('routes an unambiguous cleaning verb even without a data object', () => {
      expect(classifyAuthoringRequest('dedupe the customer list').kind).toBe('data_cleaning');
    });

    it('does NOT misread a page/layout request as data cleaning', () => {
      expect(classifyAuthoringRequest('clean up the chart layout').kind).toBe('authoring');
      expect(classifyAuthoringRequest('tidy up the dashboard tiles and colors').kind).toBe(
        'authoring',
      );
      expect(classifyAuthoringRequest('add a bar chart of headcount by title').kind).toBe(
        'authoring',
      );
      // Ambiguous verb + ambiguous object: could be page headers, so it authors.
      expect(classifyAuthoringRequest('fix the column names').kind).toBe('authoring');
      expect(classifyAuthoringRequest('remove the second tile').kind).toBe('authoring');
    });

    it('refuses to re-author a page for a data-cleaning instruction, naming the row tools', async () => {
      const client = fakeClient();
      await expect(
        generateHtmlFile({ client, schema: 'people(id, full_name)', spec: 'clean the data' }),
      ).rejects.toThrow(/update_row|bulk_update|dedup/);
      // The refusal happens BEFORE any model call — nothing was authored.
      expect(
        (client as unknown as { runTurn: ReturnType<typeof vi.fn> }).runTurn,
      ).not.toHaveBeenCalled();
    });

    it('still authors an ordinary page change', async () => {
      const client = fakeClient();
      const html = await generateHtmlFile({
        client,
        schema: 'people(id, full_name)',
        spec: 'add a bar chart of headcount by title',
      });
      expect(html).toContain('<html>');
    });
  });

  // ── 4. pre-build readiness: measure the dirt, ASK, never decide silently ───
  describe('checkDataReadiness', () => {
    it('detects duplicate keys and shows the offending values with counts', async () => {
      const report = await checkDataReadiness(db, { table: 'people', keyColumn: 'full_name' });
      const dup = report.findings.find((f) => f.kind === 'duplicate_keys');
      expect(dup?.column).toBe('full_name');
      expect(dup?.detail).toMatch(/6 row/);
      expect(dup?.detail).toMatch(/5 distinct/);
      expect(dup?.samples).toEqual(expect.arrayContaining([{ value: 'Ada Lovelace', count: 2 }]));
      expect(report.ready).toBe(false);
    });

    it('detects that there is NO clean categorical column for the requested grouping', async () => {
      const report = await checkDataReadiness(db, {
        table: 'people',
        groupBy: 'employment_type',
      });
      const cat = report.findings.find((f) => f.kind === 'no_clean_category');
      expect(cat?.column).toBe('employment_type');
      expect(cat?.detail).toMatch(/no .*employment_type.* column|does not exist/i);
      // The candidate columns it COULD mean are offered with their value counts.
      expect(cat?.samples.map((s) => s.value)).toEqual(expect.arrayContaining(['job_title']));
      expect(cat?.samples.every((s) => s.count > 0)).toBe(true);
    });

    it('surfaces the competing encodings of a concept with per-encoding counts', async () => {
      const report = await checkDataReadiness(db, { table: 'people', concept: 'temp' });
      const enc = report.findings.find((f) => f.kind === 'competing_encodings');
      expect(enc?.samples).toEqual(
        expect.arrayContaining([
          { value: 'job_title', count: 2 },
          { value: 'full_name', count: 1 },
        ]),
      );
    });

    it('asks the user how to define it instead of picking one silently', async () => {
      const report = await checkDataReadiness(db, {
        table: 'people',
        keyColumn: 'full_name',
        groupBy: 'employment_type',
        concept: 'temp',
      });
      expect(report.ready).toBe(false);
      expect(report.question).toBeTruthy();
      expect(report.question ?? '').toMatch(/\?/); // it is a question
      expect(report.question ?? '').toContain('job_title');
      expect(report.question ?? '').toMatch(/2\b/); // the counts are in the question
    });

    it('reports ready when the requested grouping is a clean category and keys are unique', async () => {
      const report = await checkDataReadiness(db, { table: 'people', groupBy: 'job_title' });
      expect(report.findings).toEqual([]);
      expect(report.ready).toBe(true);
      expect(report.question).toBeNull();
    });

    it('is honest, not a blocker: an unready report still returns findings, never throws', async () => {
      const report = await checkDataReadiness(db, { table: 'people', groupBy: 'nope' });
      expect(report.ready).toBe(false);
      expect(report.findings.length).toBeGreaterThan(0);
    });

    it('fails loudly on an unknown table rather than reporting a clean bill of health', async () => {
      await expect(checkDataReadiness(db, { table: 'ghosts' })).rejects.toThrow(/ghosts/);
    });

    it('never text-matches a NUMERIC column (portable: LOWER(number) is a cloud error)', async () => {
      // year_num holds 2026, whose digits contain "20" — scanning it would both
      // invent an encoding that does not exist and, on Postgres, raise
      // "function lower(integer) does not exist".
      const report = await checkDataReadiness(db, { table: 'shifts', concept: '20' });
      expect(report.findings.find((f) => f.kind === 'competing_encodings')).toBeUndefined();
    });
  });

  // ── the tool surface the assistant calls before building ──────────────────
  describe('check_data_readiness tool', () => {
    const ctx = (): DispatchCtx =>
      ({
        db,
        validTables: new Set(['people']),
      }) as unknown as DispatchCtx;

    it('returns the findings and the question to put to the user', async () => {
      const res = await handleComputed({
        ctx: ctx(),
        mctx: {} as never,
        name: 'check_data_readiness',
        args: { table: 'people', key_column: 'full_name', group_by: 'employment_type' },
      });
      expect(res).not.toBe('__not_handled__');
      const r = res as { ok: boolean; result?: Record<string, unknown> };
      expect(r.ok).toBe(true); // an inspection, never a refusal
      expect(r.result?.ready).toBe(false);
      expect(Array.isArray(r.result?.findings)).toBe(true);
      expect(String(r.result?.question)).toContain('full_name');
    });

    it('refuses an unknown table loudly', async () => {
      const res = (await handleComputed({
        ctx: ctx(),
        mctx: {} as never,
        name: 'check_data_readiness',
        args: { table: 'ghosts' },
      })) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/ghosts/);
    });
  });
});
