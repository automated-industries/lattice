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
// modal), and the 4.4 inline-HTML-file feature: the file preview renders an
// `artifact_type='html'` file live in a sandboxed `srcdoc` frame (with an injected
// CSP + the bundled chart library decoded from a window global), plus the bundled
// minified Chart.js itself (assigned to `window.__LATTICE_CHART_LIB__`), which is
// the bulk of the size jump. The HTML file renders in a null-origin sandboxed frame
// (no allow-same-origin) with no network (CSP connect-src 'none'); a parent-side
// read-only postMessage broker mediates all data reads, and an injected
// `window.lattice` bridge is how an authored page asks for them. Recapture the
// length + hash on any intended change.
const ORIGINAL_LENGTH = 697300;
const ORIGINAL_SHA256 = 'f7128159ff14fc7690d454d246baddf7e69162f34d4d8d7933e42be2787a1bd4';

describe('appJs composition', () => {
  it('matches the original length exactly', () => {
    expect(appJs.length).toBe(ORIGINAL_LENGTH);
  });

  it('matches the original sha256 exactly (byte-identical)', () => {
    const hash = createHash('sha256').update(appJs).digest('hex');
    expect(hash).toBe(ORIGINAL_SHA256);
  });
});
