/**
 * The mutating-route census: every way to CHANGE something must say whether it can
 * be done without a server.
 *
 * The sibling layering guard proves the arrows point the right way — a capability
 * never imports a route. That is necessary and it is not enough. Layering says
 * nothing about whether a capability EXISTS: a route can be perfectly layered, own
 * its logic outright, and still be the only door to it. Nothing goes red. The
 * feature simply cannot be used from a script, a command, or a job, and nobody
 * finds out until somebody tries.
 *
 * So this test walks every branch in every HTTP adapter that selects a request and
 * changes something, and requires each one to answer, in a comment directly above
 * it, exactly one question: what is the headless equivalent? There are four honest
 * answers.
 *
 *   @capability <id>                 — one exists. The id must resolve in
 *                                      `src/capabilities.ts`, and that manifest
 *                                      entry is itself checked: the symbol is real,
 *                                      exported, free of HTTP, and on the public
 *                                      surface.
 *   @gui-only <category>: <reason>   — none exists and none should. The category
 *                                      comes from a closed set, and the reason has
 *                                      to be written out, because "GUI-only" is the
 *                                      claim that is easiest to make and hardest to
 *                                      check.
 *   @headless-debt                   — none exists YET. Counted against a budget
 *                                      that can only go down.
 *   @not-a-route                     — the branch selects no operation (a shared
 *                                      predicate, a post-dispatch trigger).
 *
 * WHAT COUNTS AS A SITE, and why it is not just "a branch on POST".
 *
 *   1. Any branch comparing the request method to a state-changing verb. This is
 *      the ordinary shape and most routes have it.
 *   2. Any branch that selects a request by its PATH — an exact pathname, a
 *      membership test against a set of paths, a path-regex match — when it is
 *      either behind a gate that already restricted the method to a mutating one,
 *      or its body performs a write. Without this, two whole shapes escape: a
 *      dispatcher that hoists ONE `method !== 'POST'` gate above N paths would
 *      answer for all N with a single note, and a handler that never mentions the
 *      method at all — the natural shape when the only client is a browser sending
 *      one verb — would produce no site to annotate.
 *
 * A path branch whose body contains method branches is a CONTAINER, not an
 * operation: the operations inside it are censused individually, so counting the
 * wrapper too would double-count them.
 *
 * THE HONESTY PROBLEM, named out loud because it is the way this test fails while
 * staying green. Every unannotated site is a build failure, and the cheapest way to
 * clear one is to write `@gui-only` on it. That converts an unacknowledged gap into
 * a DOCUMENTED FALSE CLAIM — strictly worse, because the debt number then says the
 * work is done and the comment says a reviewer already thought about it. The budget
 * exists so the honest answer is also the easy one: `@headless-debt` costs nothing
 * today and is the only answer that keeps the number true. If a site is not
 * genuinely impossible to do headlessly, it is debt.
 *
 * Which is also why the three non-capability answers are pinned as LISTS OF ROUTES
 * and never as counts. A count cannot tell relabelling apart from progress: swap
 * `@gui-only` and `@headless-debt` between two routes in one file and every total
 * holds still, while the record now says a live capability is permanently
 * browser-only. Each pin below names the file and the route, so any movement is a
 * diff somebody has to read. The route, not the line number: a pin that churns on
 * every edit above it teaches people to re-paste it without looking, which is the
 * same failure one level up.
 *
 * WHAT THIS CANNOT DO. It proves a route has an ANSWER, not that the answer is
 * right — a mislabelled `@capability` pointing at a real but unrelated export
 * passes. And a branch that selects a request in none of the recognised ways AND
 * calls no recognised write is not seen at all; the write list below is checked to
 * name real functions, but it is a list, so an entirely new persistence helper
 * reaching the tree at the same moment as a path-only handler would slip through
 * until it is added. What it does close is the ordinary silent path: no new way to
 * change data can be added, in any of the shapes this tree actually uses, without
 * someone writing down whether a script can do the same thing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsForScan } from '../support/scan-text.js';
import { CAPABILITIES, capability, splitLibraryRef } from '../../src/capabilities.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC = join(ROOT, 'src');

// ── The budget ─────────────────────────────────────────────────────────────

/**
 * Sites that acknowledge a headless gap. SHRINK-ONLY, and exact in BOTH
 * directions: growing fails because the gap is widening, and shrinking fails
 * until the number here is lowered to match. A one-way ratchet would leave the
 * slack behind for the next regression to spend, which is how a budget becomes
 * a ceiling nobody is under.
 *
 * This is the release's progress metric. Driving it to zero is the work; the
 * number is only useful while it is honest, so it is the length of
 * {@link HEADLESS_DEBT} — the actual list of what is missing — and not a count
 * made comfortable by relabelling.
 */
const DEBT_BUDGET = 16;

/**
 * When a human last looked at the budget and agreed with it, and the release it
 * was agreed FOR — which runs ahead of package.json, because the version is bumped
 * at publish time and this was reviewed while building that release.
 *
 * A budget nobody revisits stops being a decision and becomes furniture: it sits at
 * whatever number the last mechanical edit left it at. More than two minor lines
 * past the review fails, which is roughly "you shipped twice without asking whether
 * this is still the plan".
 */
const BUDGET_REVIEWED = { date: '2026-07-29', version: '5.7.0' };

/**
 * Every acknowledged headless gap, as `<file> — <route>`, sorted.
 *
 * The inventory behind {@link DEBT_BUDGET}. Pinned as routes rather than counted
 * so that paying one down while adding another somewhere else cannot net out to
 * "no change": both show as diffs, one line removed and one added.
 */
const HEADLESS_DEBT: string[] = [
  'src/gui/databases-routes.ts — POST /api/databases/create',
  'src/gui/databases-routes.ts — POST /api/databases/delete',
  'src/gui/dbconfig/cloud-settings-routes.ts — POST /api/cloud/s3-config',
  'src/gui/dbconfig/connection-routes.ts — POST /api/dbconfig/rename',
  'src/gui/dbconfig/connection-routes.ts — POST /api/dbconfig/test',
  'src/gui/question-routes.ts — POST answerMatch',
  'src/gui/question-routes.ts — POST dismissMatch',
  'src/gui/read-routes.ts — POST /api/analytics/sql',
  'src/gui/schema-routes.ts — DELETE /api/schema/entities/[^/]+/links/[^/]+$',
  'src/gui/schema-routes.ts — POST /api/schema/entities/[^/]+/links$',
  'src/gui/schema-routes.ts — PUT /api/gui-meta/columns/[^/]+/[^/]+$',
  'src/gui/server.ts — POST /api/update/apply',
  'src/gui/server.ts — POST /api/update/check',
  'src/gui/server.ts — POST /api/workspaces/delete',
  'src/gui/server.ts — PUT /api/gui-meta/*',
  'src/gui/workspaces-routes.ts — POST /api/workspaces/delete',
];

/**
 * Branches that are not routes at all, as `<file> — <route>`, sorted.
 *
 * Small, and pinned by route so it cannot quietly become the escape hatch:
 * `@not-a-route` is the one answer that costs nothing and admits nothing, so it
 * has to be as reviewable as the rest. A per-file count would let this tag and a
 * real gap trade places inside one file without moving a number.
 */
const NOT_A_ROUTE: string[] = [
  'src/gui/server.ts — DELETE|PATCH|POST|PUT const mutating',
  'src/gui/server.ts — POST /api/chat*',
  "src/gui/server.ts — POST connectorsHandled + !pathname.includes('sync-if-stale')",
  "src/gui/server.ts — POST dbSourcesHandled + !pathname.includes('sync-if-stale')",
  'src/gui/server.ts — POST importHandled',
  'src/gui/server.ts — POST ingestHandled',
  'src/gui/server.ts — POST sourcesHandled',
];

/**
 * Every site that claims to be permanently GUI-only, as
 * `<file> — <route> — <category>`, sorted. Compared exactly, so any movement — a
 * new claim, a recategorised one, a retired one, or one that swapped places with
 * an acknowledged gap — shows up as a diff in this list.
 */
const GUI_ONLY_SNAPSHOT: string[] = [
  'src/gui/assistant-routes.ts — GET /api/assistant/oauth/callback — interactive-consent',
  'src/gui/chat-routes.ts — POST stopMatch — session-state',
  'src/gui/databases-routes.ts — POST /api/databases/switch — session-state',
  'src/gui/dbconfig/connection-routes.ts — POST /api/dbconfig/connect — session-state',
  'src/gui/files-routes.ts — POST openMatch — desktop-shell',
  'src/gui/identity/routes.ts — GET /lattice/device-code — interactive-consent',
  'src/gui/sources-routes.ts — POST /api/sources/pick — local-file-picker',
  'src/gui/workspaces-routes.ts — POST /api/workspaces/reload — session-state',
];

/**
 * The only reasons a capability may be declared browser-only, forever.
 *
 * Closed on purpose. An open vocabulary lets each new claim invent the category
 * that justifies it, and the set stops describing anything. Each of these is a
 * property of the CLIENT, not of the operation: a person has to be asked, an
 * operating system dialog has to be opened, a desktop shell has to be told, the
 * server process holds state a direct caller would simply own, bytes are being
 * pushed to a live connection, or the result is a rendering rather than a change.
 */
const GUI_ONLY_CATEGORIES = new Set([
  'interactive-consent',
  'local-file-picker',
  'desktop-shell',
  'session-state',
  'stream',
  'presentation',
]);

/** A `@gui-only` reason shorter than this is not a reason. */
const MIN_GUI_ONLY_REASON = 40;

// ── Finding the sites ──────────────────────────────────────────────────────

/**
 * The three shapes a branch on a state-changing method takes in this tree.
 *
 * Kept as three named patterns rather than one clever alternation so a failure
 * says which shape it found, and so the fixture below can prove each one still
 * matches something. `REVERSED` currently matches nothing in the tree: it is here
 * because the day somebody writes the comparison the other way round is exactly
 * the day a route would otherwise slip past uncounted.
 */
const SITE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'equality', re: /(?:\b|\.)method\s*===?\s*'(?:POST|PUT|PATCH|DELETE)'/ },
  { name: 'inequality', re: /(?:\b|\.)method\s*!==?\s*'(?:POST|PUT|PATCH|DELETE)'/ },
  {
    name: 'reversed',
    re: /'(?:POST|PUT|PATCH|DELETE)'\s*[!=]==?\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?method\b/,
  },
];

/**
 * The shapes a branch takes when it selects a request by PATH instead of method.
 *
 * Negated forms are deliberately absent: `if (!m) return false` and
 * `if (pathname !== x)` are guards that reject requests, not branches that handle
 * one, and the handling branches they protect are matched on their own.
 */
const PATH_EQUALITY = /(?:\b|\.)pathname\s*===\s*['"]/;
const PATH_SET = /\.has\s*\(\s*(?:[\w$]+\.)?pathname\s*\)/;
/** `const m = RE.exec(pathname)` — the variable named here selects a path later. */
const PATH_MATCH_ASSIGN =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*\.(?:exec|match)\s*\(\s*(?:[\w$]+\.)?pathname\s*\)/;

/**
 * Functions whose presence in a branch means that branch CHANGES something.
 *
 * Needed because a handler can mutate without ever naming a method: the browser
 * only ever sends one verb, so the check feels redundant to whoever writes it.
 * Every name here is checked below to still exist — a marker list that quietly
 * stopped naming anything would report a clean tree forever.
 *
 * Reading a request body counts. Nothing sends a body to be told a fact; a branch
 * that parses one is receiving an instruction, and if it turns out to be read-only
 * the annotation says so in one line.
 */
const WRITE_HELPERS = [
  'readJson',
  'createRow',
  'updateRow',
  'deleteRow',
  'linkRows',
  'unlinkRows',
  'undoLast',
  'redoLast',
  'undoGroup',
  'revertEntry',
  'createUserEntity',
  'createUserJunction',
  'softDeleteUserEntity',
  'renameUserEntity',
  'addUserColumn',
  'renameUserColumn',
  'purgeUserEntity',
  'aiDeleteEntity',
  'createComputedTable',
  'updateComputedTable',
  'deleteComputedTable',
  'refreshComputedTable',
  'applyPlanOp',
  'recordDismissal',
  'secureCloud',
  'migrateLatticeData',
  'provisionMemberRole',
  'revokeMemberRole',
  'setRowVisibility',
  'setTableDefaultVisibility',
  'setTableNeverShare',
  'setCloudSetting',
  'addWorkspace',
  'removeWorkspace',
  'setActiveWorkspace',
  'writeIdentity',
  'writePreferences',
  'materializeImport',
  'syncConnector',
  'syncStaleConnectors',
  'disconnectConnector',
  'setAssistantCredential',
  'completeAccountSignIn',
  'startSubscriptionSignIn',
  'completeSubscriptionSignIn',
  'ingestTextAsFile',
  'recordSchemaAudit',
  'upsertColumnMeta',
  'saveConfigDoc',
  'execSql',
];

/** The same idea for the filesystem: these are `node:fs`, verified against it. */
const FS_WRITERS = [
  'writeFileSync',
  'appendFileSync',
  'mkdirSync',
  'rmSync',
  'unlinkSync',
  'renameSync',
  'cpSync',
  'copyFileSync',
];

const WRITES = new RegExp(`\\b(?:${[...WRITE_HELPERS, ...FS_WRITERS].join('|')})\\s*[(<]`);

/**
 * A line that continues the statement on the line below it. Used to walk from a
 * match back to the line the statement STARTS on, so a multi-line condition is one
 * site and its annotation goes where a reader would put it — above the `if (`, not
 * wedged inside the condition.
 */
const CONTINUES = /[(&|=,?:]$/;

/** Does this line open or continue a comment? Read from the ORIGINAL text. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function isSiteLine(line: string): boolean {
  return SITE_PATTERNS.some((p) => p.re.test(line));
}

/**
 * Resolve a matching line to the line its statement starts on.
 *
 * Walks up while the line above continues into this one, using the
 * COMMENT-STRIPPED text: a comment line blanks to whitespace and stops the walk,
 * so a comment that happens to end in a comma can never drag the anchor past it.
 */
function anchorFor(stripped: string[], matchIdx: number): number {
  let i = matchIdx;
  while (i > 0) {
    const prev = stripped[i - 1]!.trim();
    if (prev === '' || !CONTINUES.test(prev)) break;
    i -= 1;
  }
  return i;
}

/** The contiguous comment block immediately above `anchor`, as one string. */
function annotationBlock(lines: string[], anchor: number): string {
  const out: string[] = [];
  let i = anchor - 1;
  while (i >= 0 && isCommentLine(lines[i]!)) {
    out.unshift(lines[i]!);
    i -= 1;
  }
  return out.join('\n');
}

/** Brace depth at the START of each line, from the comment-stripped text. */
function braceDepths(stripped: string[]): number[] {
  let d = 0;
  return stripped.map((line) => {
    const start = d;
    for (const c of line) {
      if (c === '{') d += 1;
      else if (c === '}') d -= 1;
    }
    return start;
  });
}

/** The line range a branch's body spans: from its statement to its closing brace. */
function bodyRange(stripped: string[], anchor: number): [number, number] {
  let d = 0;
  let opened = false;
  for (let j = anchor; j < stripped.length && j < anchor + 800; j++) {
    for (const c of stripped[j]!) {
      if (c === '{') {
        d += 1;
        opened = true;
      } else if (c === '}') d -= 1;
    }
    if (opened && d <= 0) return [anchor, j];
    // A braceless branch (`if (x) return y;`) is at most its own statement.
    if (!opened && j >= anchor + 2) return [anchor, j];
  }
  return [anchor, Math.min(anchor + 40, stripped.length - 1)];
}

/** The whole statement a branch opens with, as one line of text. */
function statementAt(stripped: string[], anchor: number): string {
  const out: string[] = [];
  for (let j = anchor; j < stripped.length && j < anchor + 8; j++) {
    out.push(stripped[j]!);
    if (/[{;]/.test(stripped[j]!)) break;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

const VERB_LITERAL = /'(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)'/g;

/** The text inside a branch's `if ( … )`, or the whole statement if it is not one. */
function conditionOf(stmt: string): string {
  const open = stmt.indexOf('(');
  if (!stmt.startsWith('if') || open < 0) return stmt;
  let depth = 0;
  for (let i = open; i < stmt.length; i++) {
    if (stmt[i] === '(') depth += 1;
    else if (stmt[i] === ')') {
      depth -= 1;
      if (depth === 0) return stmt.slice(open + 1, i);
    }
  }
  return stmt.slice(open + 1);
}

/**
 * What a branch tests, minus the method comparisons (already reported as verbs).
 * The last resort for naming a site that recognises its request some other way —
 * a handled-flag, a sub-resource — and readable enough to review in a pinned list.
 */
function conditionDigest(stmt: string): string {
  return conditionOf(stmt)
    .split(/\s*(?:&&|\|\|)\s*/)
    .map((part) =>
      part
        .replace(/!?\(?\s*(?:[\w$]+\.)?\bmethod\s*[!=]==?\s*'[A-Z]+'\s*\)?/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((part) => /[A-Za-z0-9_$]/.test(part))
    .join(' + ')
    .replace(/[=(&|+.\s]+$/, '')
    .slice(0, 60);
}

/** How a branch recognises the request it handles, in the reader's own words. */
function selectorFor(stmt: string, matchVars: Set<string>): string {
  const prefix = /pathname\.startsWith\s*\(\s*['"]([^'"]+)['"]/.exec(stmt);
  const literal = /['"](\/[A-Za-z0-9_\-./]*)['"]/.exec(stmt);
  const regex = /\/\^?\\\/([A-Za-z0-9_\-\\/.^$()[\]+*?|]*)\//.exec(stmt);
  const set = /([A-Za-z_$][\w$]*)\.has\s*\(\s*(?:[\w$]+\.)?pathname\s*\)/.exec(stmt);
  // A sub-resource selector (`action === 'connect'`). The method comparison is
  // already reported as the verb, so it is explicitly not this.
  const sub = /\b(?!method\b)([A-Za-z_$][\w$]*)\s*===\s*'([\w-]+)'/.exec(stmt);
  const matchVar = [...matchVars].find((v) => new RegExp(`\\b${v}\\b`).test(stmt));

  if (prefix) return `${prefix[1]!}*`;
  if (literal) return literal[1]!;
  if (regex) return `/${regex[1]!.replace(/\\\//g, '/')}`;
  if (set) return set[1]!;
  if (matchVar) return matchVar;
  if (sub) return `${sub[1]!} === (${sub[2]!})`;
  return conditionDigest(stmt);
}

/**
 * A stable name for the route a site handles: the methods it accepts and the way
 * it recognises the path. Deliberately derived from the branch itself rather than
 * from its position, so the pinned lists above survive an edit ten lines higher
 * and still fail the moment two sites trade annotations.
 *
 * A branch that only says `method === 'POST'` recognises nothing on its own — it
 * is one arm of a dispatcher that already matched the path — so it is named after
 * the branch that DID match, which is how a reader would describe it too.
 */
function siteKey(
  stripped: string[],
  anchor: number,
  matchVars: Set<string>,
  gateVerbs: string[],
  scope: string,
): string {
  const stmt = statementAt(stripped, anchor);
  const own = [...new Set([...stmt.matchAll(VERB_LITERAL)].map((m) => m[1]!))];
  const verbs = (own.length > 0 ? own : gateVerbs).sort();
  const selector = selectorFor(stmt, matchVars) || scope || conditionOf(stmt).slice(0, 60);
  return `${verbs.join('|') || '-'} ${selector}`;
}

interface Site {
  file: string;
  line: number; // 1-based anchor
  block: string;
  key: string;
}

/** Every mutating branch in one file, one entry per statement. */
function sitesIn(file: string, text: string): Site[] {
  const lines = text.split('\n');
  const stripped = stripCommentsForScan(text).split('\n');
  const depth = braceDepths(stripped);

  // Branches on a state-changing method, plus the ones that are early-return
  // GATES: a gate restricts everything after it in its block to that method, so
  // the paths it fans out to are mutating even where they never say so.
  const methodAnchors = new Set<number>();
  const methodLines = new Set<number>();
  const gates: { depth: number; line: number; verbs: string[] }[] = [];
  for (let i = 0; i < stripped.length; i++) {
    if (!isSiteLine(stripped[i]!)) continue;
    const anchor = anchorFor(stripped, i);
    methodAnchors.add(anchor);
    methodLines.add(i);
    const stmt = statementAt(stripped, anchor);
    if (/\)\s*return\b/.test(stmt)) {
      const verbs = [...new Set([...stmt.matchAll(VERB_LITERAL)].map((m) => m[1]!))];
      gates.push({ depth: depth[anchor]!, line: i, verbs });
    }
  }

  const matchVars = new Set<string>();
  for (const line of stripped) {
    const m = PATH_MATCH_ASSIGN.exec(line);
    if (m) matchVars.add(m[1]!);
  }
  const pathMatch =
    matchVars.size > 0 ? new RegExp(`\\bif\\s*\\(\\s*(?:${[...matchVars].join('|')})\\b`) : null;

  /** The gate this line sits under, if any: still open at this depth. */
  const openGate = (i: number): { verbs: string[] } | null => {
    for (const g of gates) {
      if (i <= g.line) continue;
      let open = true;
      for (let k = g.line + 1; k <= i; k++) {
        if (depth[k]! < g.depth) {
          open = false;
          break;
        }
      }
      if (open) return g;
    }
    return null;
  };

  const anchors = new Map<number, string[]>();
  for (const a of methodAnchors) anchors.set(a, []);
  /** Path branches that wrap other branches — the dispatchers a site sits inside. */
  const dispatchers: { from: number; to: number; selector: string }[] = [];

  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i]!;
    const selectsPath =
      PATH_EQUALITY.test(line) || PATH_SET.test(line) || (pathMatch?.test(line) ?? false);
    if (!selectsPath) continue;
    const anchor = anchorFor(stripped, i);
    if (methodAnchors.has(anchor)) continue;

    const [from, to] = bodyRange(stripped, anchor);
    // A branch that contains method branches is a dispatcher, and the operations
    // inside it are censused on their own — but it is what NAMES them.
    let container = false;
    for (const ml of methodLines) {
      if (ml > from && ml <= to) {
        container = true;
        break;
      }
    }
    if (container) {
      dispatchers.push({
        from,
        to,
        selector: selectorFor(statementAt(stripped, anchor), matchVars),
      });
      continue;
    }

    const gate = openGate(i);
    if (gate === null && !WRITES.test(stripped.slice(from, to + 1).join('\n'))) continue;
    anchors.set(anchor, gate?.verbs ?? []);
  }

  /** The innermost dispatcher a site sits inside, for naming it. */
  const scopeOf = (anchor: number): string => {
    let best: { from: number; to: number; selector: string } | null = null;
    for (const d of dispatchers) {
      if (anchor <= d.from || anchor > d.to) continue;
      if (best === null || d.to - d.from < best.to - best.from) best = d;
    }
    return best?.selector ?? '';
  };

  return [...anchors.keys()]
    .sort((a, b) => a - b)
    .map((a) => ({
      file,
      line: a + 1,
      block: annotationBlock(lines, a),
      key: siteKey(stripped, a, matchVars, anchors.get(a) ?? [], scopeOf(a)),
    }));
}

// ── Reading the source tree ────────────────────────────────────────────────

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

const FILES = allTsFiles(SRC)
  .sort()
  .map((f) => ({ rel: rel(f), abs: f, text: readFileSync(f, 'utf8') }));

const BY_PATH = new Map(FILES.map((f) => [f.rel, f]));

/**
 * The HTTP adapters — DERIVED, not copied.
 *
 * The layering guard pins this exact set against a reviewed, checked-in list, so
 * deriving it here is safe AND better than a second copy: a new adapter is covered
 * by this census the moment it exists, and it cannot appear at all without the
 * layering guard making somebody approve it first. Two hand-maintained lists would
 * drift, and the drift would show up as this test quietly scanning less.
 */
const ADAPTERS = FILES.filter((f) => /from\s*['"]node:http['"]/.test(f.text)).map((f) => f.rel);

const SITES = ADAPTERS.flatMap((r) => sitesIn(r, BY_PATH.get(r)!.text));

/** `<file> — <route>`, the identity the pinned lists are written in. */
function siteId(site: Site): string {
  return `${site.file} — ${site.key}`;
}

// ── Annotation grammar ─────────────────────────────────────────────────────

const TAGS = ['@capability', '@gui-only', '@headless-debt', '@not-a-route'] as const;
type Tag = (typeof TAGS)[number];

function tagsIn(block: string): Tag[] {
  return TAGS.filter((t) => block.includes(t));
}

// ── Resolving the public surface ───────────────────────────────────────────

/** Every module specifier in an `export … from '…'` clause, with its names. */
function reExports(text: string): { names: string[] | 'all'; spec: string }[] {
  const clean = stripCommentsForScan(text);
  const out: { names: string[] | 'all'; spec: string }[] = [];
  const named = /export\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(clean)) !== null) {
    if (m[1]) continue; // `export type { … }` is not a value
    const names = m[2]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('type '))
      // `a as b` publishes b
      .map((s) => (s.includes(' as ') ? s.split(/\s+as\s+/)[1]!.trim() : s));
    out.push({ names, spec: m[3]! });
  }
  const star = /export\s+\*\s+from\s*['"]([^'"]+)['"]/g;
  while ((m = star.exec(clean)) !== null) out.push({ names: 'all', spec: m[1]! });
  return out;
}

/** Names a module declares with `export function|const|class|…`. */
function ownExports(text: string): string[] {
  const clean = stripCommentsForScan(text);
  const out: string[] = [];
  const re =
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) out.push(m[1]!);
  return out;
}

function resolveSpec(fromRel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  return rel(resolve(dirname(join(ROOT, fromRel)), spec.replace(/\.js$/, '.ts')));
}

/**
 * Every value name the package entry point publishes, following `export *` so a
 * barrel re-export counts. Without that, anything reached through
 * `export * from './connectors/index.js'` would look absent and the manifest would
 * be forced to under-claim.
 */
function publicSurface(entry: string, depth = 0, seen = new Set<string>()): Set<string> {
  const names = new Set<string>();
  if (depth > 4 || seen.has(entry)) return names;
  seen.add(entry);
  const file = BY_PATH.get(entry);
  if (!file) return names;
  if (depth > 0) for (const n of ownExports(file.text)) names.add(n);
  for (const { names: ns, spec } of reExports(file.text)) {
    const target = resolveSpec(entry, spec);
    if (ns === 'all') {
      if (target) for (const n of publicSurface(target, depth + 1, seen)) names.add(n);
      continue;
    }
    for (const n of ns) names.add(n);
  }
  return names;
}

const PUBLIC_SURFACE = publicSurface('src/index.ts');

// ── The census ─────────────────────────────────────────────────────────────

describe('mutating routes declare their headless equivalent', () => {
  it('finds a real census of mutating branches across the adapters', () => {
    // Guards the guard, first and hardest: a scanner that matched nothing would
    // report a perfectly annotated tree forever, and every assertion below would
    // pass vacuously. Both floors are far under the real numbers, so ordinary
    // churn never trips them — only a scanner that stopped working.
    expect(ADAPTERS.length, 'no HTTP adapters found — the derivation broke').toBeGreaterThan(15);
    expect(SITES.length, 'no mutating branches found — the site scan broke').toBeGreaterThan(100);
  });

  it('every route the pins name is a distinct route', () => {
    // Guards the pins: two sites in one file sharing a key would let them trade
    // annotations without the lists below noticing, which is the exact hole the
    // route-keyed pins exist to close.
    const seen = new Map<string, number>();
    for (const site of SITES) seen.set(siteId(site), (seen.get(siteId(site)) ?? 0) + 1);
    const collisions = [...seen]
      .filter(([, n]) => n > 1)
      .map(([id, n]) => `${id} (${String(n)} sites)`);
    expect(
      collisions,
      `These sites resolve to the same route key:\n${collisions.join('\n')}\n\n` +
        `Give one of them a distinguishable branch (an explicit pathname is best), or ` +
        `teach siteKey() to tell them apart. Until then the pinned lists cannot see a ` +
        `swap between them.`,
    ).toEqual([]);
  });

  it('every mutating branch carries exactly one annotation', () => {
    const missing: string[] = [];
    const ambiguous: string[] = [];
    for (const site of SITES) {
      const tags = tagsIn(site.block);
      if (tags.length === 0) missing.push(`${site.file}:${String(site.line)} — ${site.key}`);
      else if (tags.length > 1) {
        ambiguous.push(`${site.file}:${String(site.line)} — ${tags.join(' + ')}`);
      }
    }

    expect(
      missing,
      `These routes change something and do not say whether a script could do the same:\n` +
        `${missing.join('\n')}\n\n` +
        `Add ONE line to the comment block directly above each:\n` +
        `  // @capability <id>        a headless equivalent exists (id from src/capabilities.ts)\n` +
        `  // @gui-only <category>: <reason>   it never can, and here is why\n` +
        `  // @headless-debt <note>    it should, and does not yet\n` +
        `  // @not-a-route <note>      this branch selects no operation\n\n` +
        `If you are unsure, it is @headless-debt. Reaching for @gui-only to clear the ` +
        `failure turns a gap nobody had noticed into a claim somebody will believe.`,
    ).toEqual([]);

    expect(
      ambiguous,
      `These routes carry more than one annotation, so they answer the question twice:\n` +
        ambiguous.join('\n'),
    ).toEqual([]);
  });

  it('every @capability names an entry in the manifest', () => {
    const unresolved: string[] = [];
    for (const site of SITES) {
      const m = /@capability\s+(\S+)/.exec(site.block);
      if (!m) continue;
      if (!capability(m[1]!)) unresolved.push(`${site.file}:${String(site.line)} — "${m[1]!}"`);
    }
    expect(
      unresolved,
      `These routes claim a capability that does not exist in src/capabilities.ts:\n` +
        `${unresolved.join('\n')}\n\n` +
        `Either the id is a typo, or the manifest entry was removed while the claim ` +
        `stayed behind — which would leave a route asserting a headless path that is gone.`,
    ).toEqual([]);
  });

  it('every @gui-only uses a known category and gives a real reason', () => {
    const bad: string[] = [];
    for (const site of SITES) {
      const m = /@gui-only\s+([a-z-]+)\s*:\s*([\s\S]*)$/.exec(site.block);
      const where = `${site.file}:${String(site.line)}`;
      if (!m) {
        if (site.block.includes('@gui-only'))
          bad.push(`${where} — expected "@gui-only <category>: <reason>"`);
        continue;
      }
      const [, category, rest] = m;
      if (!GUI_ONLY_CATEGORIES.has(category!)) {
        bad.push(`${where} — unknown category "${category!}"`);
      }
      // The reason may wrap across comment lines; judge the whole tail.
      const reason = rest!
        .split('\n')
        .map((l) => l.replace(/^\s*(?:\/\/|\*)\s?/, '').trim())
        .join(' ')
        .trim();
      if (reason.length < MIN_GUI_ONLY_REASON) {
        bad.push(
          `${where} — reason is ${String(reason.length)} chars, needs ${String(MIN_GUI_ONLY_REASON)}`,
        );
      }
    }
    expect(
      bad,
      `These permanent browser-only claims are not reviewable as written:\n` +
        `${bad.join('\n')}\n\n` +
        `The category has to come from the closed set (${[...GUI_ONLY_CATEGORIES].join(', ')}) ` +
        `and the reason has to say why no caller outside a browser could ever want this. ` +
        `If the honest answer is "it could, we just have not built it", the tag is ` +
        `@headless-debt.`,
    ).toEqual([]);
  });

  it('the set of permanently browser-only routes matches the reviewed snapshot', () => {
    const measured = SITES.flatMap((site) => {
      const m = /@gui-only\s+([a-z-]+)\s*:/.exec(site.block);
      return m ? [`${siteId(site)} — ${m[1]!}`] : [];
    }).sort();
    const expected = [...GUI_ONLY_SNAPSHOT].sort();

    expect(
      measured,
      `The permanently-browser-only set changed.\n` +
        `measured:\n${measured.join('\n')}\n\nsnapshot:\n${expected.join('\n')}\n\n` +
        `This list is snapshotted per route, rather than counted, so that every addition ` +
        `is a line somebody has to read and agree with — and so that moving a claim from ` +
        `one route to another cannot cancel out. Update GUI_ONLY_SNAPSHOT in the same ` +
        `change that adds or retires a claim.`,
    ).toEqual(expected);
  });

  it('branches that are not routes match the reviewed list', () => {
    const measured = SITES.filter((s) => s.block.includes('@not-a-route'))
      .map(siteId)
      .sort();
    const expected = [...NOT_A_ROUTE].sort();
    expect(
      measured,
      `The "not a route" set changed.\n` +
        `measured:\n${measured.join('\n')}\n\nreviewed:\n${expected.join('\n')}\n\n` +
        `That tag admits nothing and costs nothing, so it is pinned per branch. A genuine ` +
        `new shared predicate or post-dispatch trigger is fine — record it here.`,
    ).toEqual(expected);
  });

  it('acknowledged headless gaps match the reviewed inventory', () => {
    const measured = SITES.filter((s) => s.block.includes('@headless-debt'))
      .map(siteId)
      .sort();
    const expected = [...HEADLESS_DEBT].sort();

    expect(
      measured,
      `The acknowledged-gap list changed.\n` +
        `measured:\n${measured.join('\n')}\n\nreviewed:\n${expected.join('\n')}\n\n` +
        `An added line is a new way to change data that a script cannot reach: extract ` +
        `the work into a capability module, add it to src/capabilities.ts, and point the ` +
        `route at it rather than recording it here. A removed line is progress — delete ` +
        `it here and lower DEBT_BUDGET in the same change. Pinning the routes rather ` +
        `than the total is what stops one gap being paid down while another appears.`,
    ).toEqual(expected);
  });

  it('the budget equals the inventory it summarises', () => {
    expect(
      HEADLESS_DEBT.length,
      `DEBT_BUDGET says ${String(DEBT_BUDGET)} but HEADLESS_DEBT lists ` +
        `${String(HEADLESS_DEBT.length)} routes. The number is the headline metric and the ` +
        `list is what it is made of; they move together or the number means nothing.`,
    ).toBe(DEBT_BUDGET);
  });

  it('the budget has been reviewed recently enough to mean something', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    const parse = (v: string): [number, number] => {
      const [maj, min] = v.split('.');
      return [Number(maj), Number(min)];
    };
    const [curMaj, curMin] = parse(pkg.version);
    const [revMaj, revMin] = parse(BUDGET_REVIEWED.version);
    const stale = curMaj !== revMaj || curMin - revMin > 2;

    expect(
      stale,
      `The headless-debt budget was last reviewed at ${BUDGET_REVIEWED.version} on ` +
        `${BUDGET_REVIEWED.date}; this is ${pkg.version}. Look at the remaining gaps, decide ` +
        `whether the plan to close them still holds, then update BUDGET_REVIEWED. A budget ` +
        `nobody revisits is not a decision — it is whatever the last mechanical edit left ` +
        `behind.`,
    ).toBe(false);
  });
});

// ── The manifest itself ────────────────────────────────────────────────────

describe('the capability manifest describes things that really exist', () => {
  it('ids are unique and shaped like <area>.<operation>', () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size, `duplicate capability ids: ${ids.join(', ')}`).toBe(ids.length);
    const malformed = ids.filter((id) => !/^[a-z][a-z-]*\.[a-z][a-z-]*$/.test(id));
    expect(
      malformed,
      `these ids do not read as <area>.<operation>: ${malformed.join(', ')}`,
    ).toEqual([]);
  });

  it('every entry names a symbol its module really exports', () => {
    // Guards the guard, the same shape the security-helper registry uses: a renamed
    // or deleted function must not leave an entry that keeps passing because some
    // unrelated file happens to mention the name.
    const broken: string[] = [];
    for (const c of CAPABILITIES) {
      const { module, symbol } = splitLibraryRef(c.library);
      const file = BY_PATH.get(`src/${module}`);
      if (!file) {
        broken.push(`${c.id}: src/${module} does not exist`);
        continue;
      }
      const declared = ownExports(file.text).includes(symbol);
      const reExported = reExports(file.text).some(
        (r) => r.names !== 'all' && r.names.includes(symbol),
      );
      if (!declared && !reExported) {
        broken.push(`${c.id}: "${symbol}" is not exported from src/${module}`);
      }
    }
    expect(
      broken,
      `The manifest points at symbols that are not there:\n${broken.join('\n')}\n\n` +
        `An entry that names nothing is worse than a missing entry — it reads as a ` +
        `promise that the capability is reachable.`,
    ).toEqual([]);
  });

  it('every entry lives in a module free of HTTP', () => {
    // The whole claim is "you can do this without a server". A capability module
    // that imports node:http drags one into the caller's process and makes the
    // claim false while looking true.
    const serving = CAPABILITIES.filter((c) => {
      const { module } = splitLibraryRef(c.library);
      const file = BY_PATH.get(`src/${module}`);
      return file !== undefined && /from\s*['"]node:http['"]/.test(file.text);
    }).map((c) => `${c.id} -> src/${splitLibraryRef(c.library).module}`);

    expect(
      serving,
      `These capabilities live in modules that speak HTTP:\n${serving.join('\n')}\n\n` +
        `Move the work into a module that takes plain arguments and returns plain ` +
        `values, so the same code runs for a request, a command, and a library call.`,
    ).toEqual([]);
  });

  it('every entry is reachable from the package entry point', () => {
    // Exported from its own module is not enough: a consumer imports the package,
    // not a deep path. A symbol that is not re-exported from src/index.ts is, for
    // anyone outside this repo, not a capability at all.
    const unreachable = CAPABILITIES.filter(
      (c) => !PUBLIC_SURFACE.has(splitLibraryRef(c.library).symbol),
    ).map((c) => `${c.id} -> ${c.library}`);

    expect(
      unreachable,
      `These capabilities are not re-exported from src/index.ts:\n${unreachable.join('\n')}\n\n` +
        `Add the export, or drop the entry and record the routes that referenced it as ` +
        `@headless-debt. Claiming a headless path a library consumer cannot import is ` +
        `the exact failure this manifest exists to prevent.`,
    ).toEqual([]);
  });

  it('the surface resolver actually resolves the surface', () => {
    // Guards the guard: if `publicSurface` silently returned an empty set, or
    // stopped following `export *`, the check above would pass for anything (an
    // empty set makes `unreachable` everything) or fail for everything. Pin one
    // directly-named export and one that is only reachable through a barrel.
    expect(PUBLIC_SURFACE.size, 'the public surface resolved to nothing').toBeGreaterThan(100);
    expect(PUBLIC_SURFACE.has('createRow'), 'a directly re-exported symbol').toBe(true);
    expect(PUBLIC_SURFACE.has('syncConnector'), 'a symbol reached through `export *`').toBe(true);
    expect(PUBLIC_SURFACE.has('definitelyNotExported'), 'an invented name').toBe(false);
  });

  it('every named command verb exists in the command dispatcher', () => {
    const cli = readFileSync(join(SRC, 'cli.ts'), 'utf8');
    const missing = CAPABILITIES.filter(
      (c) => c.cli !== undefined && !cli.includes(`case '${c.cli}'`),
    ).map((c) => `${c.id} -> ${c.cli ?? ''}`);
    expect(
      missing,
      `These capabilities claim a command that the dispatcher does not have:\n` +
        missing.join('\n'),
    ).toEqual([]);
  });

  it('every named assistant tool exists in the function registry', () => {
    const registry = readFileSync(join(SRC, 'gui', 'ai', 'registry.ts'), 'utf8');
    const missing = CAPABILITIES.filter(
      (c) => c.ai !== undefined && !registry.includes(`name: '${c.ai}'`),
    ).map((c) => `${c.id} -> ${c.ai ?? ''}`);
    expect(
      missing,
      `These capabilities claim an assistant tool that the registry does not have:\n` +
        missing.join('\n'),
    ).toEqual([]);
  });
});

// ── The scanner ────────────────────────────────────────────────────────────

describe('the census scanner reads code and not prose', () => {
  const sample = [
    "  // A POST to this path used to be handled here; if (method === 'POST') moved away.",
    "  /* method === 'DELETE' is documented in the guide, not implemented. */",
    "  if (method === 'POST' && pathname === '/api/x') {",
    "  if (ctx.method !== 'PUT') return false;",
    "  if ('PATCH' === req.method) return true;",
    "  const outbound = { method: 'POST', body };",
    "  if (op === 'delete' || op === 'DELETE') return 'delete';",
    "  if (method === 'GET') return readOnly();",
  ].join('\n');

  it('counts the real branches and ignores the prose about them', () => {
    const found = sitesIn('sample.ts', sample);
    expect(
      found.map((f) => f.line),
      'three real branches: the equality, the inequality, and the reversed form',
    ).toEqual([3, 4, 5]);
  });

  it('each shape is matched by exactly the pattern that names it', () => {
    // Without this, one pattern could rot to match nothing and the alternation
    // would still look healthy because a sibling covered its cases.
    const byName = new Map(SITE_PATTERNS.map((p) => [p.name, p.re]));
    expect(byName.get('equality')!.test("if (method === 'POST') {")).toBe(true);
    expect(byName.get('equality')!.test("if (ctx.method === 'DELETE') {")).toBe(true);
    expect(byName.get('inequality')!.test("if (req.method !== 'POST') return false;")).toBe(true);
    expect(byName.get('reversed')!.test("if ('PATCH' === req.method) {")).toBe(true);
    // A non-method comparison against the same words is not a route branch.
    expect(isSiteLine("if (op === 'DELETE') return 'delete';")).toBe(false);
    // An outbound request's method is a property, not a branch.
    expect(isSiteLine("const init = { method: 'POST' };")).toBe(false);
  });

  it('a multi-line condition is one site, anchored at the statement', () => {
    const wrapped = [
      '  // leading note',
      '  if (',
      "    method === 'POST' &&",
      '    /^\\/api\\/x$/.test(pathname)',
      '  ) {',
    ].join('\n');
    const found = sitesIn('wrapped.ts', wrapped);
    expect(found).toHaveLength(1);
    expect(found[0]!.line, 'anchored at the `if (`, not the condition line').toBe(2);
    expect(found[0]!.block, 'the comment above the statement is the annotation block').toContain(
      'leading note',
    );
  });

  it('a comment ending in a comma cannot drag the anchor past it', () => {
    // The anchor walk uses the stripped text precisely so this stays true; on the
    // raw text, the trailing comma would read as a continuation and the annotation
    // would be looked for one line too high.
    const tricky = ['  // a note about x, y,', "  if (method === 'DELETE') {"].join('\n');
    const found = sitesIn('tricky.ts', tricky);
    expect(found[0]!.line).toBe(2);
    expect(found[0]!.block).toContain('a note about');
  });

  it('one hoisted method gate does not answer for the paths behind it', () => {
    // The shape that hides N operations behind one annotation: check the method
    // once at the top, then fan out on the path. Each path has to answer for
    // itself, or extracting one of them could never move the number.
    const hoisted = [
      'export function handle(ctx) {',
      "  if (ctx.method !== 'POST' || !PATHS.has(ctx.pathname)) return false;",
      "  if (ctx.pathname === '/api/a') { return doA(); }",
      "  if (ctx.pathname === '/api/b') { return doB(); }",
      '  return doFallthrough();',
      '}',
    ].join('\n');
    const found = sitesIn('hoisted.ts', hoisted);
    expect(
      found.map((f) => f.line),
      'the gate and both paths behind it',
    ).toEqual([2, 3, 4]);
    expect(found.map((f) => f.key)).toEqual(['POST PATHS', 'POST /api/a', 'POST /api/b']);
  });

  it('a handler that never mentions the method is still censused when it writes', () => {
    // The natural shape when the only client is a browser that sends one verb:
    // nobody writes the method check, so a method-only scan sees nothing at all.
    const silent = [
      'export function handle(req, res, pathname) {',
      "  if (pathname === '/api/pin-layout') {",
      '    const body = await readJson(req);',
      '    return save(body);',
      '  }',
      "  if (pathname === '/api/pin-layout/report') {",
      '    return render();',
      '  }',
      '}',
    ].join('\n');
    const found = sitesIn('silent.ts', silent);
    expect(
      found.map((f) => f.line),
      'the writing branch, not the rendering one',
    ).toEqual([2]);
  });

  it('a write on a read method is censused', () => {
    // A callback or webhook that persists something on GET changes data just as
    // much as a POST does, and a method-verb scan would never look at it.
    const onGet = [
      "  if (method === 'GET' && pathname === '/api/oauth/callback') {",
      '    setAssistantCredential(kind, JSON.stringify(tokens));',
      '  }',
    ].join('\n');
    const found = sitesIn('callback.ts', onGet);
    expect(found.map((f) => f.key)).toEqual(['GET /api/oauth/callback']);
  });

  it('a dispatcher wrapping method branches is not counted as an operation too', () => {
    const nested = [
      '  const rowsMatch = ROWS_PATH.exec(pathname);',
      '  if (rowsMatch) {',
      "    if (method === 'POST') { return create(await readJson(req)); }",
      "    if (method === 'DELETE') { return remove(); }",
      '  }',
    ].join('\n');
    const found = sitesIn('nested.ts', nested);
    expect(
      found.map((f) => f.line),
      'the two operations, not the wrapper',
    ).toEqual([3, 4]);
  });

  it('a guard that rejects requests is not a branch that handles one', () => {
    const guards = [
      "  if (!pathname.startsWith('/api/x')) return false;",
      '  if (!m) return false;',
      "  if (pathname !== '/api/stream') return false;",
    ].join('\n');
    expect(sitesIn('guards.ts', guards)).toEqual([]);
  });

  it('two annotations trading places moves both pins instead of cancelling out', () => {
    // The failure the route-keyed pins exist to stop: relabel a real gap as
    // permanently browser-only, relabel a browser-only route as a gap, and every
    // total holds still while the record now says the opposite of the truth.
    const reason = 'a reason long enough to be a reason, written out in full.';
    const file = (first: string, second: string): string =>
      [
        `  // ${first}`,
        "  if (method === 'POST' && pathname === '/api/a') {",
        '  }',
        `  // ${second}`,
        "  if (method === 'POST' && pathname === '/api/b') {",
        '  }',
      ].join('\n');
    const label = (text: string): string[] =>
      sitesIn('f.ts', text).map((s) => `${s.key} — ${tagsIn(s.block).join('')}`);

    const before = file(`@gui-only session-state: ${reason}`, '@headless-debt not yet');
    const after = file('@headless-debt not yet', `@gui-only session-state: ${reason}`);

    const countTags = (text: string): string =>
      sitesIn('f.ts', text)
        .flatMap((s) => tagsIn(s.block))
        .sort()
        .join(',');
    expect(countTags(before), 'a count-based pin sees no difference at all').toBe(countTags(after));
    expect(label(before), 'the route-keyed pin sees the swap').not.toEqual(label(after));
  });

  it('every write marker names something that still exists', () => {
    // Guards the guard: the marker list is what makes a method-less handler
    // visible, so a renamed helper left behind here would silently shrink the
    // census — and the shrink would look like a clean tree.
    const declared = new Set<string>();
    for (const f of FILES) for (const n of ownExports(f.text)) declared.add(n);
    const gone = WRITE_HELPERS.filter((h) => !declared.has(h));
    expect(
      gone,
      `These write markers are not exported by anything in src/: ${gone.join(', ')}\n\n` +
        `Rename them here to whatever replaced them. Left as they are, a handler that ` +
        `calls the new name and nothing else looks read-only to this census.`,
    ).toEqual([]);

    const notInFs = FS_WRITERS.filter(
      (n) => typeof (nodeFs as unknown as Record<string, unknown>)[n] !== 'function',
    );
    expect(notInFs, `these are not functions on node:fs: ${notInFs.join(', ')}`).toEqual([]);
  });
});
