// desktop/main.ts — `deno desktop` entrypoint for the Lattice desktop app.
//
// Serves the EXACT same GUI as the web (`startGuiServer`, version-stamped from
// the same build constant) in a native window, with a system-browser bridge for
// external links/OAuth and built-in upgrade-on-run via `Deno.autoUpdate()`.
import { homedir } from 'node:os';
import { join } from 'node:path';
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
// Data dir lives under the user's home directory. `HOME` is Unix-only and is
// unset on Windows, where the old `Deno.cwd()` fallback resolved to the app's
// install directory (read-only for a normal user), so the mkdir failed and the
// app never opened a window. `homedir()` resolves the correct, writable per-user
// home on every platform; `join` keeps the path separator native.
const root = join(homedir(), '.lattice');
await Deno.mkdir(root, { recursive: true });

const handle = await startGuiServer({
  latticeRoot: root,
  configPath: null, // virgin boot → welcome screen; workspace created in-UI
  outputDir: null,
  openBrowser: false, // the native window replaces the system-browser launch
  autoRender: true,
  version: VERSION, // same version the web GUI shows
  selfUpdate: false, // desktop uses Deno.autoUpdate, not the npm supervisor
  // The webview's injected link-interceptor POSTs external URLs to
  // /api/desktop/open, which calls this — routing target=_blank / OAuth to the
  // OS default browser (a webview has no tabs).
  desktopOpenExternal: (url: string) => {
    console.log('[desktop] opening external link in system browser:', url);
    openInSystemBrowser(url);
  },
});
console.log(`[desktop] Lattice ${VERSION} serving at ${handle.url}`);

// ── Native window + system-browser bridge ────────────────────────────────────
type Win = {
  navigate(url: string): void;
  executeJs(code: string): void;
};
const BrowserWindow = (
  Deno as unknown as { BrowserWindow?: new (o: Record<string, unknown>) => Win }
).BrowserWindow;

if (!BrowserWindow) {
  console.error('[desktop] Deno.BrowserWindow unavailable — launch via `deno desktop`.');
} else {
  const win = new BrowserWindow({ title: 'Lattice', width: 1280, height: 860 });
  win.navigate(handle.url);

  // Keep the link bridge installed. The GUI reloads the document on some actions
  // (e.g. creating a workspace), which drops any injected listener — and there's
  // no host-side page-load event to hook — so re-inject on an interval. The script
  // is idempotent (it guards on a window flag), so re-runs are no-ops until a
  // reload clears the flag and it re-installs on the fresh document.
  const injectBridge = () => {
    try {
      win.executeJs(LINK_INTERCEPTOR_JS);
    } catch {
      /* page mid-navigation — the next tick lands it */
    }
  };
  injectBridge();
  setInterval(injectBridge, 1000);

  // Check for updates shortly after launch (don't block first paint).
  setTimeout(() => void runAutoUpdate(), 4000);
}
