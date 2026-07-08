import type { Lattice } from '../lattice.js';
import { allAsyncOrSync } from '../db/adapter.js';

/**
 * The deterministic "Welcome to Lattice!" onboarding dashboard.
 *
 * Every NEW workspace is seeded (once) with this standard dashboard so the app opens
 * on something useful in the Analytics view instead of an empty canvas: a plain-English
 * tour of what Lattice does, a prompt to ask the assistant anything, one-click buttons to
 * bring in data (Files / Connector / Database) or open Configure, and a list of things you
 * can do. It is an ordinary `dashboards` row — the user can edit or delete it like any
 * other — rendered in the same sandboxed iframe as every dashboard, so its buttons use the
 * navigation-only `window.lattice.act(...)` bridge (a null-origin iframe cannot navigate
 * the host app with plain links).
 */

/** Stable id so the row is recognisable across workspaces (e.g. open-by-default). */
export const WELCOME_DASHBOARD_ID = 'welcome-lattice';
/** One-time seed marker — seeds exactly once per workspace, even if later deleted. */
const WELCOME_SEED_SENTINEL = 'internal:seed:welcome-dashboard:v1';
export const WELCOME_DASHBOARD_TITLE = 'Welcome to Lattice!';
const WELCOME_DESCRIPTION =
  'Your starting point — what Lattice does and how to bring in your data.';

/** A non-executable summary of the page (what the assistant sees instead of `html`). */
export function welcomeDashboardSpec(): string {
  return [
    'The standard first-run "Welcome to Lattice!" onboarding dashboard, seeded into every',
    'new workspace. Explains in plain language what Lattice does, invites the user to ask',
    'the assistant a question, and offers one-click buttons to connect data (Files,',
    'Connector, Database), open the Configure view, and see what they can do. Static',
    'content — it reads no tables.',
  ].join(' ');
}

/**
 * The standalone HTML page for the Welcome dashboard. Self-contained (inline CSS +
 * one inline script), theme-aware via `prefers-color-scheme`, and wired to the
 * host through `window.lattice.act(...)` (navigation only). No network, no data reads.
 */
export function welcomeDashboardHtml(): string {
  return `<style>
  :root { color-scheme: light dark; --bg: #ffffff; --card: #f8fafc; --text: #0f172a; --muted: #64748b; --border: #e2e8f0; --accent: #4f46e5; --accent-soft: #eef2ff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0b1220; --card: #131c2e; --text: #e8eefc; --muted: #94a3b8; --border: #24304a; --accent: #818cf8; --accent-soft: #1c2740; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 40px 28px 64px; }
  .hero { text-align: center; margin-bottom: 8px; }
  .hero h1 { font-size: 30px; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 8px; }
  .hero p { font-size: 16px; color: var(--muted); margin: 0 auto; max-width: 56ch; }
  .section { margin-top: 32px; }
  .section h2 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 12px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 20px 22px; }
  .ask { text-align: center; padding: 26px 22px; }
  .ask p { margin: 0 0 16px; font-size: 15px; color: var(--muted); }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
  .chip { border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 999px; padding: 8px 14px; font-size: 13.5px; cursor: pointer; }
  .chip:hover { border-color: var(--accent); color: var(--accent); }
  .sources { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .src { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: left; background: var(--bg); border: 1px solid var(--border); border-radius: 12px; padding: 16px; cursor: pointer; font: inherit; color: inherit; }
  .src:hover { border-color: var(--accent); box-shadow: 0 1px 0 var(--accent); }
  .src .ic { font-size: 22px; }
  .src .t { font-weight: 700; font-size: 14.5px; }
  .src .d { font-size: 12.5px; color: var(--muted); }
  .btn-row { margin-top: 14px; text-align: center; }
  .btn { display: inline-block; background: var(--accent); color: #fff; border: none; border-radius: 10px; padding: 11px 20px; font: inherit; font-weight: 600; cursor: pointer; }
  .btn:hover { filter: brightness(1.06); }
  .todo { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; }
  .todo .item { display: flex; gap: 12px; align-items: flex-start; }
  .todo .ic { font-size: 20px; line-height: 1.4; }
  .todo .t { font-weight: 700; font-size: 14.5px; margin: 0 0 2px; }
  .todo .d { font-size: 13px; color: var(--muted); margin: 0; }
  .foot { margin-top: 36px; text-align: center; font-size: 12.5px; color: var(--muted); }
</style>
<div class="wrap">
  <div class="hero">
    <h1>Welcome to Lattice!</h1>
    <p>Lattice turns your company's documents, spreadsheets, and connected tools into one place you can search, organise, and simply <em>ask questions about</em> — in plain English.</p>
  </div>

  <div class="section">
    <h2>Ask your company anything</h2>
    <div class="card ask">
      <p>Type a question into the assistant on the right and get an answer drawn from your own data — no formulas, no query language.</p>
      <div class="chips">
        <button class="chip" data-ask="What does my company do, in a nutshell?">"What does my company do?"</button>
        <button class="chip" data-ask="Summarise everything we have on our biggest customer.">"Summarise our biggest customer"</button>
        <button class="chip" data-ask="What are the key numbers from my latest financials?">"Key numbers from our financials"</button>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Bring in your data</h2>
    <div class="sources">
      <button class="src" data-act="add-file"><span class="ic">📄</span><span class="t">Files</span><span class="d">Drop in documents, PDFs, spreadsheets, notes.</span></button>
      <button class="src" data-act="add-connector"><span class="ic">🔌</span><span class="t">Connector</span><span class="d">Pull from the tools your team already uses.</span></button>
      <button class="src" data-act="add-database"><span class="ic">🗄️</span><span class="t">Database</span><span class="d">Connect an existing database, read-only.</span></button>
    </div>
    <div class="btn-row"><button class="btn" data-act="configure">Open Configure to set things up</button></div>
  </div>

  <div class="section">
    <h2>Things you can do with Lattice</h2>
    <div class="card">
      <div class="todo">
        <div class="item"><span class="ic">🔎</span><div><p class="t">Find anything instantly</p><p class="d">Search across every file and source at once, by meaning — not just keywords.</p></div></div>
        <div class="item"><span class="ic">🧩</span><div><p class="t">Organise on its own</p><p class="d">Lattice sorts what you add into people, companies, projects, and more.</p></div></div>
        <div class="item"><span class="ic">📊</span><div><p class="t">Build a dashboard by asking</p><p class="d">Ask a question that's best shown as a chart and the assistant builds one.</p></div></div>
        <div class="item"><span class="ic">🔒</span><div><p class="t">Keep it private</p><p class="d">Your files stay on your machine; you choose what, if anything, to share.</p></div></div>
      </div>
    </div>
  </div>

  <p class="foot">This page is yours — edit or remove it any time. Start by bringing in some data or asking a question. 👉</p>
</div>
<script>
  (function () {
    function act(name, arg) { try { if (window.lattice && lattice.act) lattice.act(name, arg); } catch (e) {} }
    var i, n;
    var acts = document.querySelectorAll('[data-act]');
    for (i = 0; i < acts.length; i++) {
      (function (el) { el.addEventListener('click', function () { act(el.getAttribute('data-act')); }); })(acts[i]);
    }
    var asks = document.querySelectorAll('[data-ask]');
    for (n = 0; n < asks.length; n++) {
      (function (el) { el.addEventListener('click', function () { act('ask', el.getAttribute('data-ask')); }); })(asks[n]);
    }
  })();
</script>`;
}

/** SQLite string literal — the only escaping SQLite needs is doubling single quotes. */
function sqliteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Seed the Welcome dashboard into a workspace — ONCE, guarded by a `db.migrate`
 * sentinel so it is created for new workspaces and never re-created if the user
 * deletes it. Owner-side only (callers skip it on a cloud-member open). Idempotent
 * and best-effort: any failure is the caller's to log, never fatal to the open.
 */
export async function seedWelcomeDashboard(db: Lattice): Promise<void> {
  // The dashboards table must exist (native schema applied) before we insert.
  const exists =
    db.getDialect() === 'postgres'
      ? (
          (await allAsyncOrSync(
            db.adapter,
            `SELECT to_regclass('dashboards') IS NOT NULL AS ok`,
          )) as { ok: boolean }[]
        )[0]?.ok
      : (
          (await allAsyncOrSync(
            db.adapter,
            `SELECT name FROM sqlite_master WHERE type='table' AND name='dashboards'`,
          )) as unknown[]
        ).length > 0;
  if (!exists) return; // schema hasn't landed yet — retry on the next open

  const html = welcomeDashboardHtml();
  const spec = welcomeDashboardSpec();
  const pg = db.getDialect() === 'postgres';
  // created_at / updated_at default in-DB (dialect-translated); do not set them here.
  const sql = pg
    ? // Postgres: dollar-quote each value so the HTML's quotes/backslashes need no
      // escaping. The tags below cannot appear in the content.
      `INSERT INTO dashboards (id, title, html, spec, description)
       VALUES ('${WELCOME_DASHBOARD_ID}', $wtitle$${WELCOME_DASHBOARD_TITLE}$wtitle$,
               $whtml$${html}$whtml$, $wspec$${spec}$wspec$, $wdesc$${WELCOME_DESCRIPTION}$wdesc$)
       ON CONFLICT (id) DO NOTHING`
    : `INSERT OR IGNORE INTO dashboards (id, title, html, spec, description)
       VALUES ('${WELCOME_DASHBOARD_ID}', ${sqliteLiteral(WELCOME_DASHBOARD_TITLE)},
               ${sqliteLiteral(html)}, ${sqliteLiteral(spec)}, ${sqliteLiteral(WELCOME_DESCRIPTION)})`;

  await db.migrate([{ version: WELCOME_SEED_SENTINEL, sql }]);
}
