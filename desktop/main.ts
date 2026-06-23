// desktop/main.ts — `deno desktop` entrypoint for the Lattice desktop app.
//
// Serves the EXACT same GUI as the web (`startGuiServer`, version-stamped from
// the same build constant) in a native window, with a system-browser bridge for
// external links/OAuth and built-in upgrade-on-run via `Deno.autoUpdate()`.
import { startGuiServer, VERSION } from '../dist/desktop-entry.js';
import { openInSystemBrowser, LINK_INTERCEPTOR_JS } from './system-browser.ts';

// ── Auto-update (upgrade-on-run) ─────────────────────────────────────────────
// `deno desktop` ships a built-in updater: it polls <baseUrl>/latest.json, applies
// the bsdiff patch, relaunches, and auto-rolls-back on a failed launch. We point
// it at the GitHub Releases "latest" path. Overridable via env for staging.
const UPDATE_BASE_URL =
  Deno.env.get('LATTICE_DESKTOP_UPDATE_URL') ??
  'https://github.com/automated-industries/lattice/releases/latest/download/';

async function runAutoUpdate(): Promise<void> {
  const autoUpdate = (
    Deno as unknown as { autoUpdate?: (o: { baseUrl: string }) => Promise<unknown> }
  ).autoUpdate;
  if (typeof autoUpdate !== 'function') return; // not in a compiled desktop build
  try {
    await autoUpdate({ baseUrl: UPDATE_BASE_URL });
  } catch (err) {
    // Loud, never silent — but a failed update must not block launch.
    console.error('[desktop] auto-update check failed:', (err as Error).message);
  }
}

// ── Boot the GUI server ──────────────────────────────────────────────────────
const root = `${Deno.env.get('HOME') ?? Deno.cwd()}/.lattice`;
await Deno.mkdir(root, { recursive: true });

const handle = await startGuiServer({
  latticeRoot: root,
  configPath: null, // virgin boot → welcome screen; workspace created in-UI
  outputDir: null,
  openBrowser: false, // the native window replaces the system-browser launch
  autoRender: true,
  version: VERSION, // same version the web GUI shows
  selfUpdate: false, // desktop uses Deno.autoUpdate, not the npm supervisor
});
console.log(`[desktop] Lattice ${VERSION} serving at ${handle.url}`);

// ── Native window + system-browser bridge ────────────────────────────────────
type Win = {
  navigate(url: string): void;
  bind(name: string, fn: (...a: unknown[]) => unknown): void;
  executeJs(code: string): void;
};
const BrowserWindow = (
  Deno as unknown as { BrowserWindow?: new (o: Record<string, unknown>) => Win }
).BrowserWindow;

if (!BrowserWindow) {
  console.error('[desktop] Deno.BrowserWindow unavailable — launch via `deno desktop`.');
} else {
  const win = new BrowserWindow({ title: 'Lattice', width: 1280, height: 860 });
  // Bind BEFORE navigate so the page's interceptor can call it on first paint.
  win.bind('openExternal', (url: unknown) => {
    if (typeof url === 'string') openInSystemBrowser(url);
  });
  win.navigate(handle.url);

  // The GUI is a SPA with no load event we can hook here; inject the idempotent
  // interceptor a few times so it lands once the document exists.
  for (const delay of [400, 1200, 2500]) {
    setTimeout(() => {
      try {
        win.executeJs(LINK_INTERCEPTOR_JS);
      } catch {
        /* page not ready yet — a later attempt will land */
      }
    }, delay);
  }

  // Check for updates shortly after launch (don't block first paint).
  setTimeout(() => void runAutoUpdate(), 4000);
}
