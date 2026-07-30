/**
 * Layering guard: the HTTP server is ONE client, never a requirement.
 *
 * Everything Lattice can do, it must be able to do without starting a server —
 * from a command line, from a library call, from a background job. That only
 * stays true if the code that DOES the work is reachable without the code that
 * SERVES it. The moment a capability lives inside a route handler, the only way
 * to reach it is to boot an HTTP server and send yourself a request; a headless
 * caller either can't use it or has to import a route module and drag a server
 * into a process that never listens on a port.
 *
 * So the source tree has two layers and the arrows only point one way:
 *
 *   adapters    translate HTTP into a capability call and a response back out.
 *               They own request parsing, status codes, headers, streaming.
 *               They are named so you can see them: `*routes.ts`, plus the
 *               server itself and the shared HTTP helpers.
 *
 *   everything  the actual product. Never mentions a request or a response,
 *   else      never imports an adapter.
 *
 * A route may import a capability. A capability may NEVER import a route. When
 * that inverts, the capability is only callable through a server, and headless
 * support quietly rots — which is exactly how it rotted before this test
 * existed.
 *
 * The three checks below correspond to the three ways the layering breaks:
 *   1. a new file starts speaking HTTP without anyone noticing;
 *   2. an adapter is created that isn't recognizable as one by name;
 *   3. a capability reaches back into an adapter for a helper that should have
 *      been extracted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsForScan } from '../support/scan-text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC = join(ROOT, 'src');

/**
 * Every file allowed to speak HTTP. Checked in deliberately: adding a file here
 * is a reviewed decision ("yes, this is a new HTTP adapter"), whereas a bare
 * grep would let one appear silently. Removing a file from the list is equally
 * deliberate — it means an adapter stopped being one.
 */
const ADAPTERS: string[] = [
  'src/gui/assistant-routes.ts',
  'src/gui/chat-routes.ts',
  'src/gui/computed-routes.ts',
  'src/gui/connectors-routes.ts',
  'src/gui/data-model-routes.ts',
  'src/gui/databases-routes.ts',
  'src/gui/db-sources-routes.ts',
  'src/gui/dbconfig-routes.ts',
  'src/gui/dbconfig/cloud-settings-routes.ts',
  'src/gui/dbconfig/cloud-state-routes.ts',
  'src/gui/dbconfig/connection-routes.ts',
  'src/gui/files-routes.ts',
  'src/gui/history-routes.ts',
  'src/gui/http.ts',
  'src/gui/identity/routes.ts',
  'src/gui/import-routes.ts',
  'src/gui/ingest-routes.ts',
  'src/gui/question-routes.ts',
  'src/gui/read-routes.ts',
  'src/gui/schema-routes.ts',
  'src/gui/server.ts',
  'src/gui/sources-routes.ts',
  'src/gui/tables-routes.ts',
  'src/gui/userconfig-routes.ts',
  'src/gui/workspaces-routes.ts',
];

/**
 * The two adapters that are not route modules, and why each is allowed to exist
 * under a different name. Anything else that speaks HTTP has to be a `*routes.ts`
 * so its role is obvious from the file listing alone.
 */
const NAMED_ADAPTERS: Record<string, string> = {
  'src/gui/server.ts': 'the server itself — it creates the listener and dispatches to the routes',
  'src/gui/http.ts': 'the shared request/response helpers every route module uses',
};

/**
 * Files allowed to import the server module, and nothing else in the adapter
 * layer. These are process entry points: someone has to be able to START the
 * server. Importing `startGuiServer` to launch it is the opposite of the problem
 * this test guards — the problem is reaching INTO an adapter for logic.
 */
const SERVER_LAUNCHERS: string[] = [
  'src/cli.ts', // `lattice gui` starts the server
  'src/index.ts', // the published library re-exports startGuiServer
  'src/desktop-entry.ts', // the desktop shell boots the same server behind a webview
];

/**
 * Capability-imports-adapter violations that are known and accepted, as
 * `<importer> -> <adapter>` strings.
 *
 * SHRINK-ONLY. The assertion below is an EXACT match, in both directions:
 *   - a new entry (the list grew) fails, because that is the layering inverting
 *     again;
 *   - a removed entry (the list shrank) also fails, and tells you to delete the
 *     line. Paying one down without recording it here would let the next
 *     regression slip back in under the old budget.
 *
 * It is currently empty: the four assistant-config imports and the text-ingest
 * import were extracted into `src/ops/` rather than grandfathered. Keep it that
 * way — an entry here should be a short-lived note, not a parking space.
 */
const ACCEPTED_VIOLATIONS: string[] = [];

/**
 * SQL an adapter still writes for itself, as `<file> -> <count of lines>`.
 *
 * Talking to the database is the product; translating HTTP is not. When a route
 * writes its own query, that query has exactly one caller and exactly one way to
 * reach it — send yourself a request. Every other caller (a command, a job, a
 * library user) either re-writes the same query or does without. So the SQL
 * belongs in the capability module that owns that data, and the route calls it.
 *
 * SHRINK-ONLY, and exact in both directions, for the same reason as
 * {@link ACCEPTED_VIOLATIONS}: a file that gains SQL fails, and a file that
 * sheds it fails too until the number here is lowered to match — otherwise the
 * budget stays open for the next regression to spend.
 *
 * Both maps are currently EMPTY. That is the real state of the tree, not a
 * grandfathered zero: the queries that used to live in these files were moved
 * into the modules that own their data — lineage reads into the lineage store,
 * table statistics into the counting helper, the internals browser and the
 * cloud member directory into their own capability modules, the connector
 * item-count into the connector layer, the import file lookup into the file-row
 * helpers — and the two schema routes now call the library's own add-column
 * method instead of emitting the statement themselves.
 */
const SQL_IN_ADAPTERS_BASELINE: Record<string, number> = {};

/**
 * Raw database EXECUTION an adapter still performs, as `<file> -> <count>`.
 *
 * The companion to the map above, and the reason that one can't be satisfied by
 * sleight of hand: moving a query string into a constant, or importing it from
 * elsewhere, changes nothing if the route is still the thing that runs it. What
 * matters is which layer talks to the database.
 *
 * This counts only the raw escape hatches — the run/get/all helpers and direct
 * calls on a storage adapter. The typed data API (`db.get`, `db.query`,
 * `db.count`, …) is NOT counted: it is the ordinary way anything reads Lattice,
 * it carries no SQL, and a route using it is not the problem this guards.
 *
 * SHRINK-ONLY, exact in both directions.
 */
const RAW_SQL_EXECUTION_BASELINE: Record<string, number> = {};

/**
 * A line that contains a SQL statement — the keywords that start one.
 *
 * Uppercase for the single-word forms, because `select` and `update` are ordinary
 * identifiers in this language and a case-insensitive match on them would flag
 * every file that has a variable by that name. The multi-word forms are
 * unambiguous, so those are matched either way. `SELECT` is matched as a bare word
 * rather than `SELECT ` so a query split across the lines of a template literal —
 * the shape a long query actually takes — is still seen.
 */
const SQL_KEYWORDS = [
  /\bSELECT\b|INSERT\s+INTO|UPDATE\s+["'`$\w]|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX|VIEW|SCHEMA|ROLE|POLICY|TRIGGER|FUNCTION)|ALTER\s+(?:TABLE|ROLE|SCHEMA)|DROP\s+(?:TABLE|INDEX|VIEW|SCHEMA|ROLE|POLICY|COLUMN)|TRUNCATE\b|GRANT\s|REVOKE\s|\bWITH\s+["\w]+\s+AS\s*\(/,
  // Case-insensitive only where the phrase cannot be anything but SQL.
  /\b(?:insert\s+into|delete\s+from|create\s+table|alter\s+table|drop\s+table|create\s+index|create\s+view|truncate\s+table)\b/i,
];

/**
 * A line that RUNS raw SQL: one of the run/get/all helpers, the DDL helper, or a
 * method called straight on a storage adapter or a database connection.
 *
 * The named helpers are matched wherever they APPEAR, not only where they are
 * called — importing one under another name would otherwise slip straight past,
 * and the import line is the one place the real name always has to be written.
 * The receiver form is matched as a call so probing what an adapter supports —
 * `typeof adapter.allAsync === 'function'` — is not mistaken for using it, and
 * the call may be optional (`adapter.allAsync?.(…)`), which is how this tree
 * writes it wherever the method is not guaranteed to exist. Missing that one form
 * would have left the check matching almost nothing while looking healthy.
 *
 * The receivers include the raw connection names (`pool`, `client`, a
 * transaction handle) as well as anything ending in `adapter`: reaching past the
 * adapter to the driver is the same escape hatch with a shorter name. The typed
 * data API is deliberately absent — `db.get` / `db.query` / `db.count` carry no
 * SQL and are the ordinary way anything reads Lattice.
 */
const RAW_SQL_EXECUTION =
  /\b(?:allAsyncOrSync|getAsyncOrSync|runAsyncOrSync|execSql)\b|\b(?:[\w$]*[Aa]dapter|pool|client|tx|trx|conn|connection)\s*\.\s*(?:query|all|get|run|exec|allAsync|getAsync|runAsync|execAsync|prepare|prepareAsync|withClient)\s*(?:\?\.)?\s*\(/;

/** Lines of `text` (comments already blanked) that match any of `patterns`. */
function countMatchingLines(text: string, patterns: RegExp | RegExp[]): number {
  const all = Array.isArray(patterns) ? patterns : [patterns];
  return stripCommentsForScan(text)
    .split('\n')
    .filter((line) => all.some((p) => p.test(line))).length;
}

/**
 * Compare a measured per-file map against a checked-in baseline, and describe
 * every difference in both directions.
 */
function baselineDiff(
  measured: Map<string, number>,
  baseline: Record<string, number>,
): { over: string[]; under: string[] } {
  const over: string[] = [];
  const under: string[] = [];
  for (const [file, count] of measured) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) over.push(`${file}: ${String(count)} (baseline ${String(allowed)})`);
    else if (count < allowed) under.push(`${file}: ${String(count)} (baseline ${String(allowed)})`);
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    if (!measured.has(file)) under.push(`${file}: 0 (baseline ${String(allowed)})`);
  }
  return { over, under };
}

function allTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return relative(ROOT, file).split('\\').join('/');
}

/** Every module specifier a file imports: static, re-export, and dynamic forms. */
function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|[\s;])(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m[1]!);
  }
  return out;
}

/** Resolve a relative specifier to a repo-relative `.ts` path, or null. */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  return rel(resolve(dirname(fromFile), spec.replace(/\.js$/, '.ts')));
}

const FILES = allTsFiles(SRC)
  .sort()
  .map((f) => ({ rel: rel(f), abs: f, text: readFileSync(f, 'utf8') }));

const ADAPTER_SET = new Set(ADAPTERS);

describe('headless layering — the server is one client, not a requirement', () => {
  it('the set of files that speak HTTP is exactly the checked-in adapter list', () => {
    const speaksHttp = FILES.filter((f) => /from\s*['"]node:http['"]/.test(f.text))
      .map((f) => f.rel)
      .sort();
    const added = speaksHttp.filter((f) => !ADAPTER_SET.has(f));
    const removed = ADAPTERS.filter((f) => !speaksHttp.includes(f));

    expect(
      added,
      `These files import node:http but are not in the checked-in adapter list:\n` +
        `${added.join('\n')}\n\n` +
        `If one is genuinely a new HTTP adapter, add it to ADAPTERS (and name it ` +
        `*routes.ts). If it is not, the logic belongs in a capability module that ` +
        `a headless caller can reach without a server.`,
    ).toEqual([]);

    expect(
      removed,
      `These files are listed as adapters but no longer import node:http:\n` +
        `${removed.join('\n')}\n\n` +
        `Delete them from ADAPTERS so the list keeps describing reality.`,
    ).toEqual([]);
  });

  it('every adapter is recognizable as one from its name', () => {
    // A reader scanning the tree should be able to tell which files serve HTTP
    // without opening them. Two exceptions are named explicitly and justified.
    const misnamed = ADAPTERS.filter((f) => !f.endsWith('routes.ts') && !(f in NAMED_ADAPTERS));
    expect(
      misnamed,
      `These adapters are neither *routes.ts nor a documented exception:\n` +
        `${misnamed.join('\n')}\n\n` +
        `Rename to *routes.ts, or add an entry to NAMED_ADAPTERS explaining why ` +
        `this file speaks HTTP under a different name.`,
    ).toEqual([]);
  });

  it('no capability module imports an adapter', () => {
    const launchers = new Set(SERVER_LAUNCHERS);
    const found: string[] = [];

    for (const f of FILES) {
      if (ADAPTER_SET.has(f.rel)) continue; // adapter → adapter is the allowed direction
      for (const spec of importSpecifiers(f.text)) {
        const target = resolveLocal(f.abs, spec);
        if (target === null || !ADAPTER_SET.has(target)) continue;
        // An entry point may import the server module in order to START it.
        // It may not reach into any other adapter.
        if (launchers.has(f.rel) && target === 'src/gui/server.ts') continue;
        found.push(`${f.rel} -> ${target}`);
      }
    }

    const unique = [...new Set(found)].sort();
    const accepted = [...ACCEPTED_VIOLATIONS].sort();
    const added = unique.filter((v) => !accepted.includes(v));
    const paidDown = accepted.filter((v) => !unique.includes(v));

    expect(
      added,
      `A capability module is importing an HTTP adapter:\n` +
        `${added.join('\n')}\n\n` +
        `That inverts the layering: the imported logic now needs a route file ` +
        `loaded to be used at all, so a command-line or background caller cannot ` +
        `reach it without pulling in a server. Move the shared part into a ` +
        `capability module under src/ops/ and re-export it from the route file ` +
        `so existing importers keep working.`,
    ).toEqual([]);

    expect(
      paidDown,
      `These accepted violations are fixed — remove them from ACCEPTED_VIOLATIONS:\n` +
        `${paidDown.join('\n')}\n\n` +
        `The list is shrink-only, and a shrink has to be recorded or the budget ` +
        `stays open for the next regression to fill.`,
    ).toEqual([]);
  });

  it('the checked-in lists name real files', () => {
    // Guards the guard: a renamed or deleted file must not leave a stale entry
    // that keeps the test green by simply never matching anything.
    const known = new Set(FILES.map((f) => f.rel));
    for (const f of [...ADAPTERS, ...Object.keys(NAMED_ADAPTERS), ...SERVER_LAUNCHERS]) {
      expect(known.has(f), `${f} is listed in this test but does not exist in src/`).toBe(true);
    }
    for (const f of Object.keys(NAMED_ADAPTERS)) {
      expect(ADAPTER_SET.has(f), `${f} is a named adapter but is missing from ADAPTERS`).toBe(true);
    }
    for (const entry of ACCEPTED_VIOLATIONS) {
      const [importer, target] = entry.split(' -> ');
      expect(known.has(importer ?? ''), `accepted violation names a missing file: ${entry}`).toBe(
        true,
      );
      expect(
        ADAPTER_SET.has(target ?? ''),
        `accepted violation names a non-adapter: ${entry}`,
      ).toBe(true);
    }
  });

  it('no adapter writes its own SQL', () => {
    const measured = new Map<string, number>();
    for (const f of FILES) {
      if (!ADAPTER_SET.has(f.rel)) continue;
      const n = countMatchingLines(f.text, SQL_KEYWORDS);
      if (n > 0) measured.set(f.rel, n);
    }
    const { over, under } = baselineDiff(measured, SQL_IN_ADAPTERS_BASELINE);

    expect(
      over,
      `These HTTP adapters contain SQL:\n` +
        `${over.join('\n')}\n\n` +
        `A query in a route file can only be run by sending an HTTP request, so ` +
        `no command, job, or library caller can reach the same data without ` +
        `starting a server. Move the query into the module that owns that data ` +
        `— the cloud modules for cloud state, the ops modules for the rest — and ` +
        `call it from the route.`,
    ).toEqual([]);

    expect(
      under,
      `These adapters now contain LESS SQL than the baseline records:\n` +
        `${under.join('\n')}\n\n` +
        `Lower (or delete) the entry in SQL_IN_ADAPTERS_BASELINE. The baseline is ` +
        `shrink-only: leaving it high keeps room for the next query to be added ` +
        `back without failing anything.`,
    ).toEqual([]);
  });

  it('no adapter runs raw SQL, whatever the query string is built from', () => {
    // Without this, the check above is satisfiable by moving the string out of
    // the file while leaving the route as the thing that talks to the database.
    const measured = new Map<string, number>();
    for (const f of FILES) {
      if (!ADAPTER_SET.has(f.rel)) continue;
      const n = countMatchingLines(f.text, RAW_SQL_EXECUTION);
      if (n > 0) measured.set(f.rel, n);
    }
    const { over, under } = baselineDiff(measured, RAW_SQL_EXECUTION_BASELINE);

    expect(
      over,
      `These HTTP adapters execute raw SQL:\n` +
        `${over.join('\n')}\n\n` +
        `Where the query text is written does not matter — running it from a ` +
        `route still means the only way to that data is an HTTP request. Move ` +
        `the read or write into a capability module and call that instead. The ` +
        `typed data API (db.get / db.query / db.count) is fine here and is not ` +
        `counted.`,
    ).toEqual([]);

    expect(
      under,
      `These adapters now run LESS raw SQL than the baseline records:\n` +
        `${under.join('\n')}\n\n` +
        `Lower (or delete) the entry in RAW_SQL_EXECUTION_BASELINE.`,
    ).toEqual([]);
  });

  it('the SQL scanner finds real queries and ignores prose about them', () => {
    // Guards the guard. A scanner that silently matched nothing would report a
    // clean tree forever, and a scanner that counted comments would report debt
    // that could be "paid down" by rewording a sentence. Both failures are
    // invisible from the assertions above, so they are pinned here directly.
    const sample = [
      '// A scoped member has no SELECT grant on this table, so the read is skipped.',
      '/* DELETE FROM is never issued here; rows are soft-deleted. */',
      'const url = "https://example.test/x"; // not a comment start inside the string',
      'const q = `SELECT "id" FROM "widgets" WHERE "deleted_at" IS NULL`;',
      'const t = `${prefix} plain text`;',
      'await execSql(db, dropView);',
      "const probe = typeof adapter.allAsync === 'function';",
    ].join('\n');

    expect(countMatchingLines(sample, SQL_KEYWORDS), 'exactly the one real query line').toBe(1);
    expect(countMatchingLines(sample, RAW_SQL_EXECUTION), 'exactly the one execution call').toBe(1);

    // The forms a real query takes in this tree, each pinned so none of them can
    // stop matching. Every one of these was a way past the pair of checks: an
    // optional call is how this codebase invokes a method an adapter may not
    // have, a driver handle skips the adapter entirely, and a long query is
    // written across the lines of a template with the verb alone on one of them.
    const evasions = [
      'const rows = await adapter.allAsync?.(sql);',
      'await pool.query(text, values);',
      'const r = await client.query(text);',
      'tx.run(statement);',
      'const sql =',
      '  `SELECT',
      '     "id", "name"',
      '   FROM "widgets"`;',
      'const drop = `DROP TABLE "old_widgets"`;',
      'const wipe = `TRUNCATE "audit"`;',
      'const make = `create table "x" ("id" text)`;',
    ].join('\n');
    expect(
      countMatchingLines(evasions, RAW_SQL_EXECUTION),
      'the optional call, the pool, the client, and the transaction handle',
    ).toBe(4);
    expect(
      countMatchingLines(evasions, SQL_KEYWORDS),
      'the wrapped SELECT, the DROP, the TRUNCATE, and the lowercase CREATE',
    ).toBe(4);

    // …and the ordinary language these keywords share a spelling with is not SQL.
    const notSql = [
      'const select = options.select;',
      'if (select && update) return;',
      "import { readFileSync } from 'node:fs';",
      'const updated = await db.update(table, id, patch);',
      'const one = await db.get(table, id);',
    ].join('\n');
    expect(countMatchingLines(notSql, SQL_KEYWORDS), 'no SQL here').toBe(0);
    expect(countMatchingLines(notSql, RAW_SQL_EXECUTION), 'the typed data API is not raw').toBe(0);

    // The stripper must not eat code: a template interpolation returns to
    // template state at its closing brace, and an apostrophe in a comment does
    // not open a string that swallows the rest of the file.
    const stripped = stripCommentsForScan(sample);
    expect(stripped.split('\n')).toHaveLength(sample.split('\n').length);
    expect(stripped).toContain('https://example.test/x');
    expect(stripped).toContain('plain text');
    expect(stripped).not.toContain('no SELECT grant');
    expect(stripped).not.toContain('soft-deleted');
  });

  it('the SQL baselines only name real adapters', () => {
    // Guards the guard: a stale entry for a renamed or deleted file would sit in
    // the baseline forever, never matching anything and never failing.
    for (const file of [
      ...Object.keys(SQL_IN_ADAPTERS_BASELINE),
      ...Object.keys(RAW_SQL_EXECUTION_BASELINE),
    ]) {
      expect(ADAPTER_SET.has(file), `${file} is in a SQL baseline but is not an adapter`).toBe(
        true,
      );
    }
    for (const count of [
      ...Object.values(SQL_IN_ADAPTERS_BASELINE),
      ...Object.values(RAW_SQL_EXECUTION_BASELINE),
    ]) {
      expect(count, 'a baseline entry must record a positive count').toBeGreaterThan(0);
    }
  });

  it('no file uses the HTTP request/response types without being an adapter', () => {
    // Closes the obvious dodge: re-exporting IncomingMessage/ServerResponse from
    // a non-adapter module would hide a handler from the node:http scan above.
    const offenders = FILES.filter(
      (f) => !ADAPTER_SET.has(f.rel) && /\b(IncomingMessage|ServerResponse)\b/.test(f.text),
    ).map((f) => f.rel);
    expect(
      offenders,
      `These non-adapter files reference the HTTP request/response types:\n` +
        `${offenders.join('\n')}\n\n` +
        `A capability must take plain arguments and return plain values, so the ` +
        `same code runs for a request, a command line, and a library call.`,
    ).toEqual([]);
  });
});
