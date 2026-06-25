// desktop/main.ts — `deno desktop` entrypoint for the Lattice desktop app.
//
// Serves the EXACT same GUI as the web (`startGuiServer`, version-stamped from
// the same build constant) in a native window, with a system-browser bridge for
// external links/OAuth and built-in upgrade-on-run via `Deno.autoUpdate()`.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGuiServer, VERSION, ensureRootForGui } from '../dist/desktop-entry.js';
import { openInSystemBrowser, LINK_INTERCEPTOR_JS } from './system-browser.ts';

// On-device voice assets (the Whisper worker bundle + ONNX-Runtime WASM) are
// embedded into the compiled app via `deno desktop --include dist/gui-assets`.
// At runtime deno extracts included files next to the bundled modules, so resolve
// them relative to this module (in `deno desktop` dev mode this is the real built
// `dist/gui-assets`). Absent (e.g. a build without the assets) → voice degrades.
function resolveGuiAssetsDir(): string | undefined {
  // Embedded via `deno desktop --include dist/gui-assets`; deno extracts included
  // files next to the bundled modules at runtime (in dev mode this is the real
  // built dir). Resolve relative to this module. NO trailing slash — the asset
  // route's containment check expects a bare directory path. The candidates cover
  // the few spots the bundle layout can place this module.
  const candidates = [
    '../dist/gui-assets',
    './dist/gui-assets',
    '../../dist/gui-assets',
    './gui-assets',
  ];
  for (const rel of candidates) {
    try {
      const dir = fileURLToPath(new URL(rel, import.meta.url));
      if (existsSync(dir)) return dir;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined; // absent → voice degrades gracefully
}

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
const home = homedir();
const root = join(home, '.lattice');
await Deno.mkdir(root, { recursive: true });

// Resolve the active workspace (if any) so the app opens it rather than always
// showing the welcome screen — the same resolution `lattice gui` uses. The
// desktop has no launch config file, so pass a non-existent path with
// explicitConfig:false; ensureRootForGui then resolves the active/first workspace
// from the root and returns a virgin boot (configPath:null → welcome) ONLY when
// there genuinely are no workspaces.
const boot = ensureRootForGui({
  startDir: home,
  configPath: join(root, 'lattice.config.yml'),
  explicitConfig: false,
});

const guiAssetsDir = resolveGuiAssetsDir();

const handle = await startGuiServer({
  latticeRoot: boot.root,
  configPath: boot.configPath, // an existing workspace → opens it; null → welcome
  outputDir: boot.contextDir,
  openBrowser: false, // the native window replaces the system-browser launch
  autoRender: true,
  version: VERSION, // same version the web GUI shows
  selfUpdate: false, // desktop uses Deno.autoUpdate, not the npm supervisor
  // Serve the embedded on-device voice assets when present (omit when absent so
  // the server falls back to its default resolution).
  ...(guiAssetsDir ? { guiAssetsDir } : {}),
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

// Window vs. system browser.
//
// On some Windows machines the embedded WebView2 host fails to create its
// environment and aborts the process natively — before any window appears —
// even though the GUI server above is already serving. That native abort throws
// no JS exception, so it can't be caught here; we cannot try-the-window-then-
// recover in-process. Instead, on Windows the GUI opens in the user's default
// browser (it renders the exact same server, reliably on every machine); macOS
// and Linux keep the native window. Override with an env var:
//   LATTICE_DESKTOP_BROWSER=1  → force the system browser on any OS
//   LATTICE_DESKTOP_WEBVIEW=1  → force the native window (e.g. once the Windows
//                                webview host is fixed upstream)
const forceBrowser = Deno.env.get('LATTICE_DESKTOP_BROWSER') === '1';
const forceWebview = Deno.env.get('LATTICE_DESKTOP_WEBVIEW') === '1';
const useBrowser = forceBrowser || (!forceWebview && Deno.build.os === 'windows');

if (!BrowserWindow || useBrowser) {
  const reason = !BrowserWindow
    ? 'native window backend unavailable'
    : forceBrowser
      ? 'LATTICE_DESKTOP_BROWSER=1'
      : 'Windows (set LATTICE_DESKTOP_WEBVIEW=1 to force the native window)';
  console.log(`[desktop] Opening Lattice in your default browser — ${reason}: ${handle.url}`);
  openInSystemBrowser(handle.url);
  // No native window owns the process lifetime now; keep the GUI server (and the
  // upgrade-on-run check) alive until the user quits.
  setTimeout(() => void runAutoUpdate(), 4000);
  await new Promise<void>(() => {});
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
