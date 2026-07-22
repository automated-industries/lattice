// desktop/main.ts — `deno desktop` entrypoint for the Lattice desktop app.
//
// Serves the EXACT same GUI as the web (`startGuiServer`, version-stamped from
// the same build constant) in a native window, with a system-browser bridge for
// external links/OAuth and built-in upgrade-on-run via `Deno.autoUpdate()`.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  startGuiServer,
  VERSION,
  ensureRootForGui,
  checkManifestForUpdate,
} from '../dist/desktop-entry.js';
import { openInSystemBrowser, LINK_INTERCEPTOR_JS } from './system-browser.ts';

// Trust the OS certificate store, not just Deno's bundled Mozilla roots. On a
// managed/corporate device behind a TLS-inspecting proxy (Zscaler, Netskope, a
// SWG, …), HTTPS to Anthropic (OAuth token exchange, model calls) is re-signed by
// a corporate root CA that IS in the macOS keychain / Windows store but is INVISIBLE
// to Deno's default trust store — so the connection fails TLS with an opaque error.
// Defaulting DENO_TLS_CA_STORE to "system,mozilla" makes those OS-trusted roots
// honored (Mozilla kept as a fallback). This runs before any TLS connection is
// made (the GUI server binds loopback; the first outbound TLS is a user action or
// the deferred auto-update check). An explicit operator value always wins, and a
// custom CA bundle can still be pointed at with DENO_CERT=/path/to/root.pem.
// (The signed macOS .pkg also sets this via the app's Info.plist LSEnvironment, so
// it is honored even before this line runs; see scripts/build-mac-pkg.sh.)
if (!Deno.env.get('DENO_TLS_CA_STORE')) {
  Deno.env.set('DENO_TLS_CA_STORE', 'system,mozilla');
}

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

// The canonical Lattice docs (docs/*.md) power the assistant's `lattice_help`
// tool. Embedded via `deno desktop --include docs`; deno extracts them relative
// to this module (same model as gui-assets). Resolve EXPLICITLY — the lib's
// findDocsDir() walks up from its own bundled module, which isn't guaranteed to
// reach the extracted docs dir — and hand the path to the lib via
// LATTICE_DOCS_DIR so it uses this directly. `cloud.md` is the sentinel guide.
function resolveDocsDir(): string | undefined {
  const candidates = ['../docs', './docs', '../../docs', '../../../docs'];
  for (const rel of candidates) {
    try {
      const dir = fileURLToPath(new URL(rel, import.meta.url));
      if (existsSync(join(dir, 'cloud.md'))) return dir;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined; // absent → assistant help degrades to model-only knowledge
}

// ── Auto-update (background installer download) ───────────────────────────────
// The compiled desktop app CANNOT self-patch: it is not an npm package, and
// Deno's built-in `Deno.autoUpdate` only applies bsdiff DELTAS to a deno-desktop
// dylib — it can't consume our full, code-signed OS installers, and it never
// relaunches in the same run. So instead the GUI's update service (which knows
// this is the `desktop` surface) auto-DOWNLOADS the newer signed installer in the
// background via `downloadUpdate` below — streaming byte progress to the window —
// and, once it is staged, offers a one-click "Install & restart" that calls
// `applyDownloadedUpdate`. This is user-visible + honest: a progress bar, then an
// explicit install, or a loud error — never a silent no-op or an endless spinner.
const UPDATE_BASE_URL =
  Deno.env.get('LATTICE_DESKTOP_UPDATE_URL') ??
  'https://github.com/automated-industries/lattice/releases/latest/download/';

// Master switch (default on). LATTICE_NO_AUTO_UPDATE=1 pins the app to its
// current version: no manifest probe, no download. Mirrors the CLI's
// --no-auto-update for the desktop (which has no CLI args).
const AUTO_UPDATE_ENABLED = Deno.env.get('LATTICE_NO_AUTO_UPDATE') !== '1';

// The signed installer we publish per platform (the same artifact the website
// links to). `releases/latest/download/<name>` always resolves to the newest
// release, so the URL needs no version interpolation. Linux has no installer
// artifact → no desktop auto-download there (the GUI still reports the version).
function installerName(): string | null {
  if (Deno.build.os === 'darwin') return 'Lattice.pkg';
  if (Deno.build.os === 'windows') return 'Lattice.msi';
  return null;
}

// Where a downloaded installer is staged, and the path once a download succeeds.
const updateStageDir = join(homedir(), '.lattice', 'updates');
let stagedInstaller: string | null = null;

// Download + verify the signed installer for `version`, streaming byte progress.
// THROWS on any failure (network, HTTP error, size/hash mismatch) so the GUI
// surfaces it loudly instead of spinning forever.
async function downloadUpdate(
  version: string,
  onProgress: (done: number, total: number | null) => void,
): Promise<void> {
  const name = installerName();
  if (!name) throw new Error(`no desktop installer for platform "${Deno.build.os}"`);

  // Best-effort: read the manifest's expected size + sha256 for this platform so
  // the download can be verified. If the manifest is unreachable or doesn't list
  // this installer, download anyway — the installer is itself code-signed +
  // notarized (Gatekeeper enforces that at launch) — but verify when we can.
  let expectedSha: string | null = null;
  let expectedSize: number | null = null;
  try {
    const mres = await fetch(new URL('latest.json', UPDATE_BASE_URL), {
      signal: AbortSignal.timeout(10_000),
    });
    if (mres.ok) {
      const m = (await mres.json()) as {
        assets?: Record<string, { name?: string; sha256?: unknown; sizeBytes?: unknown }>;
      };
      const osKey = Deno.build.os === 'darwin' ? 'darwin' : 'windows';
      const asset = m.assets?.[osKey];
      if (asset && asset.name === name) {
        expectedSha = typeof asset.sha256 === 'string' ? asset.sha256 : null;
        expectedSize = typeof asset.sizeBytes === 'number' ? asset.sizeBytes : null;
      }
    }
  } catch {
    /* manifest unreachable — proceed with an unverified (but signed) download */
  }

  const res = await fetch(new URL(name, UPDATE_BASE_URL).toString(), {
    signal: AbortSignal.timeout(600_000), // 10-minute ceiling for a large installer
  });
  if (!res.ok || !res.body) throw new Error(`installer download failed: HTTP ${res.status}`);
  const total = expectedSize ?? (Number(res.headers.get('content-length')) || null);

  await Deno.mkdir(updateStageDir, { recursive: true });
  const dest = join(updateStageDir, name);
  const file = await Deno.open(dest, { write: true, create: true, truncate: true });
  const hash = createHash('sha256');
  let done = 0;
  onProgress(0, total);
  const meter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk);
      done += chunk.byteLength;
      onProgress(done, total);
      controller.enqueue(chunk);
    },
  });
  // pipeTo closes `file` when the stream finishes (on success or error).
  await res.body.pipeThrough(meter).pipeTo(file.writable);

  if (expectedSize != null && done !== expectedSize) {
    throw new Error(`installer size mismatch: got ${done} bytes, expected ${expectedSize}`);
  }
  if (expectedSha && hash.digest('hex') !== expectedSha) {
    throw new Error('installer checksum mismatch — refusing to stage a tampered download');
  }
  stagedInstaller = dest;
}

// Launch the staged installer and quit so it can replace the running app (macOS
// won't overwrite a running .app). `open` hands the signed .pkg to the Installer;
// Windows `msiexec /i` runs the .msi. The user completes the install and re-opens
// onto the new version.
function applyDownloadedUpdate(): void {
  if (!stagedInstaller) {
    console.error('[desktop] apply requested but no installer is staged');
    return;
  }
  try {
    const cmd =
      Deno.build.os === 'windows'
        ? new Deno.Command('msiexec', { args: ['/i', stagedInstaller] })
        : new Deno.Command('open', { args: [stagedInstaller] });
    cmd.spawn();
  } catch (err) {
    console.error('[desktop] failed to launch installer:', (err as Error).message);
    return; // stay open so the GUI can surface the failure
  }
  // Give the detached installer a beat to start, then quit so it can overwrite us.
  setTimeout(() => Deno.exit(0), 800);
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

// Point the lib's docs lookup at the embedded copy (if present) before the server
// boots, so the assistant's `lattice_help` answers from the canonical docs on the
// packaged desktop app — not just under `lattice gui` from an installed package.
const docsDir = resolveDocsDir();
if (docsDir) Deno.env.set('LATTICE_DOCS_DIR', docsDir);

const handle = await startGuiServer({
  latticeRoot: boot.root,
  configPath: boot.configPath, // an existing workspace → opens it; null → welcome
  outputDir: boot.contextDir,
  openBrowser: false, // the native window replaces the system-browser launch
  autoRender: true,
  version: VERSION, // same version the web GUI shows
  selfUpdate: false, // desktop uses Deno.autoUpdate, not the npm supervisor
  autoUpdate: AUTO_UPDATE_ENABLED, // honor LATTICE_NO_AUTO_UPDATE
  // Tell the update service this is the desktop surface (not npm-installable, but
  // self-updatable via the bundled binary updater) so the GUI offers a "Restart
  // to update" pill instead of the npm "Upgrade in place" action.
  updateContext: {
    kind: 'desktop',
    installable: false,
    cwd: home,
    packageRoot: null,
    reason: 'desktop app — updates via the bundled binary updater',
  },
  // Probe the release manifest for the newest published version (read-only — the
  // version the auto-download would fetch). The update service uses this to
  // decide when to start a background installer download.
  updateCheck: () => checkManifestForUpdate(UPDATE_BASE_URL, VERSION),
  // The update service auto-calls this in the background when a newer version is
  // found, streaming byte progress to the window; and calls applyDownloadedUpdate
  // when the user clicks "Install & restart" on the staged download.
  downloadUpdate,
  applyDownloadedUpdate,
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
// The heap ceiling is baked into the compiled runtime by the build scripts'
// --v8-flags; log the effective limit so a memory-starved build is visible at
// a glance instead of only as a mid-ingest crash. Diagnostic only.
let heapNote = '';
try {
  const { getHeapStatistics } = await import('node:v8');
  heapNote = ` (V8 heap limit ${String(Math.round(getHeapStatistics().heap_size_limit / 1048576))} MB)`;
} catch {
  // node:v8 unavailable in this runtime — skip the note rather than block launch.
}
console.log(`[desktop] Lattice ${VERSION} serving at ${handle.url}${heapNote}`);

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
  // No native window owns the process lifetime now; keep the GUI server alive
  // until the user quits. The update service (started inside startGuiServer)
  // runs the background version-check + installer download on its own.
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
  // The update service (started inside startGuiServer) runs the background
  // version-check + installer download on its own — no separate timer here.
}
