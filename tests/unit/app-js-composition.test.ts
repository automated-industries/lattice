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
// the offline-retry self-heal, and most recently the 3.4.1 merge's workspace-switch
// logo refresh (the switch path now re-fetches /api/dbconfig + re-points the header
// logo, matching the boot path). Recapture the length + hash on any intended change.
const ORIGINAL_LENGTH = 388149;
const ORIGINAL_SHA256 = 'be2ae5c987bcbdef32ce3245af34ba1069876c8ace3a67a3720636aba778332a';

describe('appJs composition', () => {
  it('matches the original length exactly', () => {
    expect(appJs.length).toBe(ORIGINAL_LENGTH);
  });

  it('matches the original sha256 exactly (byte-identical)', () => {
    const hash = createHash('sha256').update(appJs).digest('hex');
    expect(hash).toBe(ORIGINAL_SHA256);
  });
});
