import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { appJs } from '../../src/gui/app/script.js';

// `src/gui/app/script.ts` (a single 7319-line template literal) was split into
// per-subsystem segments under `src/gui/app/modules/`, composed back into `appJs`
// in the original order via `modules/index.ts`. The split is a pure source-
// organization refactor: the composed string MUST equal the original byte-for-byte,
// which is what proves the inlined `<script>${appJs}</script>` is unchanged.
//
// These constants pin the composed `appJs`. They are re-captured whenever `appJs`
// changes intentionally (the modules are edited together as the source of truth):
// the offline-retry self-heal, the 3.4.1 merge's workspace-switch logo refresh
// (the switch path now re-fetches /api/dbconfig + re-points the header logo,
// matching the boot path), the manual-upgrade link (the version chip's
// "Update available — Upgrade" affordance: checkUpdateAvailable + wireUpdateLink,
// wired at boot and refreshed on each reconnect version check), and the FOUC fix
// that softens the two background in-place re-renders (advanced-mode toggle +
// workspace-switch reload now pass {soft:true} so they never paint the loading
// frame), and the 4.2 structured-source-importer GUI, reachable only by dropping a
// JSON/xlsx file into the assistant chat: the upload returns a proposal and an
// inline confirm card renders into the assistant rail (no top-bar button, no
// modal). The 4.3 release adds the Connectors settings panel + inline HTML files
// (the file preview renders an `artifact_type='html'` file live in a sandboxed,
// null-origin `srcdoc` frame — no network, a read-only postMessage broker + an
// injected `window.lattice` bridge — with the bundled minified Chart.js assigned
// to `window.__LATTICE_CHART_LIB__`, the bulk of the size), the 4.3 GUI layout
// redesign (tab strip + center brain graph, Sources sidebar, single top-right
// status, live ingest animation, file two-view/history/remove), plus 4.2.4's
// desktop build + the shared `claudeAuth()` single-source-of-truth pass merged
// from main, and the on-device voice-dictation host glue (the voice-local segment:
// a module Web Worker runs an in-browser speech model so dictation works with NO
// API key and audio never leaves the machine). The GUI uses on-device dictation
// ONLY — there is no voice-provider choice in settings and the mic always shows;
// rec.onstop always transcribes on-device. The keyed/cloud transcribe route stays
// reachable to API callers for backward compatibility, but the GUI never calls it.
// The update-visibility pass makes the existing upgrade pill surface-aware
// (checkUpdateAvailable now branches on status.action: "Upgrade" for npm,
// "Restart to update" for the desktop app, hidden otherwise), badges a dev/linked
// or auto-update-disabled build on the version chip, and re-polls availability on
// a slow interval so a long-open window still notices a new version.
// Recapture the length + hash on any intended change.
const ORIGINAL_LENGTH = 790854;
const ORIGINAL_SHA256 = '29604450efcbe2b40fdd7bdcffcfd46be25ca1f3ee3f864d517a1aee1126977d';

describe('appJs composition', () => {
  // Normalize line endings before pinning: a Windows checkout may materialize the
  // source modules with CRLF, which would change the byte length/hash without
  // changing the inlined script's meaning. Pin the LF-canonical form.
  const normalized = appJs.replace(/\r\n/g, '\n');
  it('matches the original length exactly', () => {
    expect(normalized.length).toBe(ORIGINAL_LENGTH);
  });

  it('matches the original sha256 exactly (byte-identical)', () => {
    const hash = createHash('sha256').update(normalized).digest('hex');
    expect(hash).toBe(ORIGINAL_SHA256);
  });
});
