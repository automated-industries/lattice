import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { appJs } from '../../src/gui/app/script.js';

// `src/gui/app/script.ts` (a single 7319-line template literal) was split into
// per-subsystem segments under `src/gui/app/modules/`, composed back into `appJs`
// in the original order via `modules/index.ts`. The split is a pure source-
// organization refactor: the composed string MUST equal the original byte-for-byte,
// which is what proves the inlined `<script>${appJs}</script>` is unchanged.
//
// These constants were captured from the pre-split `appJs` value. If `appJs` is
// ever changed intentionally, recapture the length + hash and update them here.
const ORIGINAL_LENGTH = 387781;
const ORIGINAL_SHA256 = 'b8978131a4f8f14fc0e02cc6903e1785f42b9496b408c85d2b4d09db798aeac1';

describe('appJs composition', () => {
  it('matches the original length exactly', () => {
    expect(appJs.length).toBe(ORIGINAL_LENGTH);
  });

  it('matches the original sha256 exactly (byte-identical)', () => {
    const hash = createHash('sha256').update(appJs).digest('hex');
    expect(hash).toBe(ORIGINAL_SHA256);
  });
});
