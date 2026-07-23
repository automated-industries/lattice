// desktop/main.ts — `deno desktop` entrypoint for the Lattice desktop app.
//
// Serves the EXACT same GUI as the web (`startGuiServer`, version-stamped from
// the same build constant) in a native window, with a system-browser bridge for
// external links/OAuth and background auto-update (signed-bundle swap, installer
// fallback — see the Auto-update section below).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  startGuiServer,
  VERSION,
  ensureRootForGui,
  checkManifestForUpdate,
  chooseUpdateStrategy,
  resolveAppBundle,
  parseTeamIdentifier,
  sameSigningTeam,
  BUNDLE_SWAP_SH,
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

// ── Auto-update (frictionless bundle swap, installer fallback) ────────────────
// The compiled desktop app CANNOT self-patch: `Deno.autoUpdate` applies bsdiff
// DELTAS to the runtime dylib in place, which breaks the app's Developer-ID
// signature — macOS then SIGKILLs the tampered process (Code Signature Invalid),
// so it can never take effect on a notarized build.
//
// So the GUI's update service auto-DOWNLOADS the update in the background (byte
// progress streamed to the window) and, once staged, offers a one-click apply.
// Two staging paths, chosen by `chooseUpdateStrategy`:
//   • SWAP (frictionless, macOS + writable /Applications): download the signed
//     `.dmg`, verify the enclosed `.app` (codesign + Gatekeeper + SAME signing
//     team as the running app), and stage it next to the running bundle. Apply =
//     a detached helper swaps the whole signed bundle after we quit, then
//     relaunches — signature stays valid (nothing is patched in place). Zero
//     password for an admin user.
//   • INSTALLER (fallback: Windows, a non-admin/non-writable /Applications, or any
//     swap failure): download the signed `.pkg`/`.msi` and, on apply, launch it +
//     quit (the user completes the OS installer).
// Either way it is honest: a progress bar, an explicit apply, or a loud error —
// never a silent no-op or an endless spinner.
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

// Where downloads are staged, and what's staged once a download+verify succeeds.
const updateStageDir = join(homedir(), '.lattice', 'updates');
let stagedMode: 'swap' | 'installer' | null = null;
let stagedInstaller: string | null = null; // installer path (.pkg/.msi)
let stagedSwapApp: string | null = null; // verified new .app, sibling of the running bundle
let stagedRunningApp: string | null = null; // the running .app bundle the swap replaces

// Run a command, capturing output; never throws (returns ok:false on spawn error).
async function run(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { code, stdout, stderr } = await new Deno.Command(cmd, {
      args,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    const dec = new TextDecoder();
    return { ok: code === 0, out: dec.decode(stdout), err: dec.decode(stderr) };
  } catch (e) {
    return { ok: false, out: '', err: (e as Error).message };
  }
}

// A real write test — the only reliable check that WE can write the bundle's
// parent (an admin user's /Applications is group-writable; a standard user's is not).
async function isDirWritable(dir: string): Promise<boolean> {
  try {
    const probe = await Deno.makeTempFile({ dir, prefix: '.lattice-w-' });
    await Deno.remove(probe);
    return true;
  } catch {
    return false;
  }
}

// Best-effort: the manifest's expected sha256 + size for a published artifact by
// filename. Absent/unreachable → nulls (download proceeds unverified-by-hash; the
// artifacts are themselves code-signed, and the swap path additionally re-verifies
// the extracted .app with codesign + Gatekeeper).
async function manifestAsset(
  filename: string,
): Promise<{ sha: string | null; size: number | null }> {
  try {
    const res = await fetch(new URL('latest.json', UPDATE_BASE_URL), {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const m = (await res.json()) as {
        assets?: Record<string, { name?: string; sha256?: unknown; sizeBytes?: unknown }>;
      };
      for (const asset of Object.values(m.assets ?? {})) {
        if (asset && asset.name === filename) {
          return {
            sha: typeof asset.sha256 === 'string' ? asset.sha256 : null,
            size: typeof asset.sizeBytes === 'number' ? asset.sizeBytes : null,
          };
        }
      }
    }
  } catch {
    /* manifest unreachable — proceed unverified-by-hash */
  }
  return { sha: null, size: null };
}

// Stream a download to `dest`, reporting byte progress and verifying size + sha256
// when known. THROWS on any failure so the GUI surfaces it (never a stuck spinner).
async function streamToFile(
  url: string,
  dest: string,
  expectedSize: number | null,
  expectedSha: string | null,
  onProgress: (done: number, total: number | null) => void,
): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = expectedSize ?? (Number(res.headers.get('content-length')) || null);
  await Deno.mkdir(dirname(dest), { recursive: true });
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
  await res.body.pipeThrough(meter).pipeTo(file.writable); // closes file on finish
  if (expectedSize != null && done !== expectedSize) {
    throw new Error(`download size mismatch: got ${done} bytes, expected ${expectedSize}`);
  }
  if (expectedSha && hash.digest('hex') !== expectedSha) {
    throw new Error('download checksum mismatch — refusing a tampered download');
  }
}

// Frictionless path: download the signed .dmg, extract + VERIFY the enclosed .app,
// and stage it next to the running bundle. Verification is a hard gate — any
// failure throws (the caller surfaces it), never a silent downgrade to the
// installer. Staging as `<runningApp>.new` keeps it on the same volume so the
// eventual swap is an atomic rename.
async function stageBundleSwap(
  runningApp: string,
  onProgress: (done: number, total: number | null) => void,
): Promise<void> {
  await Deno.mkdir(updateStageDir, { recursive: true });
  const dmgPath = join(updateStageDir, 'Lattice.dmg');
  const { sha, size } = await manifestAsset('Lattice.dmg');
  await streamToFile(
    new URL('Lattice.dmg', UPDATE_BASE_URL).toString(),
    dmgPath,
    size,
    sha,
    onProgress,
  );

  const mountPoint = await Deno.makeTempDir({ prefix: 'lattice-dmg-' });
  const att = await run('hdiutil', [
    'attach',
    '-nobrowse',
    '-readonly',
    '-mountpoint',
    mountPoint,
    dmgPath,
  ]);
  if (!att.ok) throw new Error('could not mount the update image: ' + att.err.trim());
  const stagedApp = runningApp + '.new';
  try {
    const srcApp = join(mountPoint, 'Lattice.app');
    if (!existsSync(srcApp)) throw new Error('update image does not contain Lattice.app');
    await Deno.remove(stagedApp, { recursive: true }).catch(() => {});
    const dt = await run('ditto', [srcApp, stagedApp]); // preserves the signature + xattrs
    if (!dt.ok) throw new Error('could not stage the update bundle: ' + dt.err.trim());
    // Signature-safe gate — only swap in a genuine, notarized, SAME-identity build.
    const verify = await run('codesign', ['--verify', '--deep', '--strict', stagedApp]);
    if (!verify.ok) throw new Error('staged update failed code-signature verification');
    const assess = await run('spctl', ['--assess', '--type', 'execute', stagedApp]);
    if (!assess.ok) throw new Error('staged update is not notarized (Gatekeeper rejected it)');
    const runTeam = parseTeamIdentifier((await run('codesign', ['-dvv', runningApp])).err);
    const newTeam = parseTeamIdentifier((await run('codesign', ['-dvv', stagedApp])).err);
    if (!sameSigningTeam(runTeam, newTeam)) {
      throw new Error('staged update has a different signing identity — refusing to swap');
    }
    stagedMode = 'swap';
    stagedSwapApp = stagedApp;
    stagedRunningApp = runningApp;
  } catch (err) {
    await Deno.remove(stagedApp, { recursive: true }).catch(() => {});
    throw err;
  } finally {
    await run('hdiutil', ['detach', mountPoint, '-force']);
    await Deno.remove(mountPoint).catch(() => {});
    await Deno.remove(dmgPath).catch(() => {});
  }
}

// Fallback path: download the signed OS installer (.pkg/.msi) for a later
// launch-and-quit apply.
async function downloadInstaller(
  onProgress: (done: number, total: number | null) => void,
): Promise<void> {
  const name = installerName();
  if (!name) throw new Error(`no desktop installer for platform "${Deno.build.os}"`);
  await Deno.mkdir(updateStageDir, { recursive: true });
  const dest = join(updateStageDir, name);
  const { sha, size } = await manifestAsset(name);
  await streamToFile(new URL(name, UPDATE_BASE_URL).toString(), dest, size, sha, onProgress);
  stagedMode = 'installer';
  stagedInstaller = dest;
}

// Auto-download the update in the background — the frictionless bundle swap when
// it's safe, else the OS installer. THROWS on failure so the GUI shows an error.
async function downloadUpdate(
  _version: string,
  onProgress: (done: number, total: number | null) => void,
): Promise<void> {
  stagedMode = null;
  stagedInstaller = null;
  stagedSwapApp = null;
  stagedRunningApp = null;

  const runningApp =
    Deno.env.get('LATTICE_NO_BUNDLE_SWAP') === '1' ? null : resolveAppBundle(Deno.execPath());
  const parentWritable = runningApp ? await isDirWritable(dirname(runningApp)) : false;
  const strategy = chooseUpdateStrategy({
    platform: Deno.build.os,
    bundleParentWritable: parentWritable,
  });

  if (strategy === 'swap' && runningApp) {
    await stageBundleSwap(runningApp, onProgress);
  } else {
    await downloadInstaller(onProgress);
  }
}

// Apply the staged update and quit so it can replace the running app.
//   • swap: spawn a DETACHED helper that waits for us to exit, atomically swaps
//     the verified bundle into place (with rollback), and relaunches.
//   • installer: launch the OS installer; the user completes it + re-opens.
function applyDownloadedUpdate(): void {
  if (stagedMode === 'swap' && stagedSwapApp && stagedRunningApp) {
    try {
      const scriptPath = join(updateStageDir, 'swap.sh');
      Deno.writeTextFileSync(scriptPath, BUNDLE_SWAP_SH);
      // stdio null so the helper outlives this process cleanly after we exit.
      new Deno.Command('sh', {
        args: [scriptPath, stagedRunningApp, stagedSwapApp, String(Deno.pid)],
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
      }).spawn();
    } catch (err) {
      console.error('[desktop] failed to launch the update swap helper:', (err as Error).message);
      return; // stay open so the GUI can surface the failure
    }
    setTimeout(() => Deno.exit(0), 400);
    return;
  }
  if (stagedMode === 'installer' && stagedInstaller) {
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
    return;
  }
  console.error('[desktop] apply requested but nothing is staged');
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
  // Escape hatch surfaced if a staged update is detected to have not installed
  // (e.g. a bundle swap that couldn't persist) — so the app shows a one-time
  // "download manually" error instead of re-downloading the same version forever.
  updateManualDownloadUrl: 'https://latticesql.com/install',
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
