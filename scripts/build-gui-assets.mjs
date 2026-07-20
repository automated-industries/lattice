#!/usr/bin/env node
/**
 * Build the GUI voice-dictation client assets:
 *   - dist/gui-assets/transcriber.worker.mjs  (the module worker + speech library)
 *   - dist/gui-assets/ort/*.wasm              (ONNX-Runtime WASM binaries)
 *
 * These power keyless, on-device dictation: the worker runs an in-browser WASM
 * speech model so audio never leaves the machine and no API key is needed. The
 * model weights are NOT bundled (download-on-first-use, cached in the browser),
 * which keeps the npm tarball small.
 *
 * FAIL-SOFT BY DESIGN. This runs as a follow-on step after the main `tsup` build.
 * If the build-time speech library is absent or the bundle errors, this script
 * logs a warning and exits 0 — the core package still builds and publishes, and
 * on-device voice simply degrades gracefully (the GUI hides the mic or falls back
 * to a configured cloud provider). NEVER let this step fail the core build.
 *
 * Run unconditionally from `npm run build`; the speech library is a devDependency
 * (bundled here at build time, not required at runtime).
 */

import { mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(repoRoot, 'dist', 'gui-assets');
const ortDir = join(assetsDir, 'ort');
const workerEntry = join(repoRoot, 'src', 'gui', 'app', 'worker', 'transcriber.worker.ts');
const graphEntry = join(repoRoot, 'src', 'gui', 'app', 'graph', 'force-graph.ts');

/**
 * Walk up from a resolved module entry to the directory that holds the package's
 * `package.json` (its install root). `pkgName` may be scoped (`@scope/name`), in
 * which case the root is the `.../name` directory under the scope.
 */
function locatePackageDir(modulePath, pkgName) {
  const marker = join('node_modules', ...pkgName.split('/'));
  const idx = modulePath.lastIndexOf(marker);
  if (idx >= 0) return modulePath.slice(0, idx + marker.length);
  return dirname(modulePath);
}

/** Log a fail-soft skip and exit 0 — voice is optional, the build must not fail. */
function skip(reason) {
  console.warn(
    `[gui-assets] skipping on-device voice assets — ${reason}. ` +
      `The build still succeeds; voice dictation degrades gracefully.`,
  );
  process.exit(0);
}

async function main() {
  // 1. Resolve the bundler (esbuild ships transitively with tsup). Missing ⇒ skip.
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch {
    skip('esbuild is not resolvable');
    return;
  }

  // 1b. Bundle the force-directed graph renderer (dependency-free) into an ESM
  //     module loaded out-of-band by the GUI via dynamic import. Unlike the voice
  //     assets below this is CORE, not optional — all three graph surfaces import
  //     it — so a failure here is BUILD-FATAL: never ship (or publish, via
  //     prepublishOnly) a package missing the renderer.
  mkdirSync(assetsDir, { recursive: true });
  try {
    await esbuild.build({
      entryPoints: [graphEntry],
      outfile: join(assetsDir, 'force-graph.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      logLevel: 'warning',
    });
    console.log('[gui-assets] built dist/gui-assets/force-graph.mjs');
  } catch (e) {
    console.error(
      `[gui-assets] FATAL: core graph renderer bundle failed: ${e && e.message ? e.message : String(e)}`,
    );
    throw e; // core asset — fail the build rather than ship a broken GUI
  }

  // 2. Locate the speech library (a devDependency, build-time only). Absent ⇒ skip.
  //    Resolve the main entry rather than `/package.json` (which the package's
  //    `exports` map doesn't expose), then walk up to the package directory.
  let transformersMain;
  try {
    transformersMain = require.resolve('@huggingface/transformers');
  } catch {
    skip('@huggingface/transformers is not installed');
    return;
  }

  // 3. Bundle the worker (+ inlined speech library) into a single ESM module.
  mkdirSync(assetsDir, { recursive: true });
  try {
    await esbuild.build({
      entryPoints: [workerEntry],
      outfile: join(assetsDir, 'transcriber.worker.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      // The worker fetches `.wasm` from `/gui-assets/ort/` at runtime, so the ORT
      // node bindings must not be pulled into the browser bundle.
      external: ['onnxruntime-node', 'sharp', 'fs', 'path', 'url', 'module'],
      logLevel: 'silent',
    });
  } catch (e) {
    skip(`worker bundle failed: ${e && e.message ? e.message : String(e)}`);
    return;
  }

  // 4. Copy the ONNX-Runtime web WASM binaries next to the worker so nothing is
  //    fetched from a CDN (offline / air-gap friendly). They live under the
  //    speech library's onnxruntime-web dist. Best-effort: a missing set still
  //    leaves a usable worker (the runtime can fetch its own default at runtime),
  //    so we warn but do not fail. `onnxruntime-web` exposes no `/package.json`
  //    subpath, so search the candidate node_modules locations directly.
  try {
    const transformersPkgDir = locatePackageDir(transformersMain, '@huggingface/transformers');
    const searchDirs = [transformersPkgDir, repoRoot].filter(Boolean);
    let distDir = '';
    for (const base of searchDirs) {
      const candidate = join(base, 'node_modules', 'onnxruntime-web', 'dist');
      if (existsSync(candidate)) {
        distDir = candidate;
        break;
      }
    }
    if (distDir) {
      mkdirSync(ortDir, { recursive: true });
      // The runtime `.wasm` binaries AND their matching `.mjs` backend modules.
      // onnxruntime-web loads its wasm backend via a RUNTIME dynamic `import()` of
      // `ort-wasm-simd-threaded*.mjs` — esbuild does NOT inline a dynamic import, so
      // the `.mjs` must ship next to the `.wasm` under `/gui-assets/ort/`. Without
      // them the worker fails with "no available backend found — [wasm] TypeError:
      // Importing a module script failed" (the import 404s). The CPU path needs the
      // simd-threaded core + its asyncify variant; the jsep build is the WebGPU path
      // (kept so `device:'webgpu'` works offline). The Chrome-flag-only jspi variant
      // is skipped.
      const WANTED = new Set([
        'ort-wasm-simd-threaded.wasm',
        'ort-wasm-simd-threaded.asyncify.wasm',
        'ort-wasm-simd-threaded.jsep.wasm',
        'ort-wasm-simd-threaded.mjs',
        'ort-wasm-simd-threaded.asyncify.mjs',
        'ort-wasm-simd-threaded.jsep.mjs',
      ]);
      let copied = 0;
      for (const f of readdirSync(distDir)) {
        if (WANTED.has(f)) {
          copyFileSync(join(distDir, f), join(ortDir, f));
          copied += 1;
        }
      }
      console.log(
        `[gui-assets] vendored ${copied} ONNX-Runtime WASM binary(ies) into dist/gui-assets/ort/`,
      );
    } else {
      console.warn(
        '[gui-assets] onnxruntime-web dist not found — worker will fetch ORT at runtime',
      );
    }
  } catch (e) {
    console.warn(
      `[gui-assets] could not vendor ONNX-Runtime WASM (${e && e.message ? e.message : String(e)}); ` +
        `worker will fetch ORT at runtime`,
    );
  }

  console.log('[gui-assets] built dist/gui-assets/transcriber.worker.mjs');
}

main().catch((e) => {
  // A genuinely unexpected error in this optional step still must not fail the
  // core build — log loudly and exit 0.
  skip(`unexpected error: ${e && e.message ? e.message : String(e)}`);
});
