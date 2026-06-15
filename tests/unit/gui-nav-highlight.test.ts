import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';

/**
 * Regression: the sidebar nav active-highlight must match a route exactly or on
 * a full path-segment boundary — never as a bare string prefix. A bare prefix
 * lit up every sibling whose name starts with the same word (clicking "Files"
 * also highlighted "Files Project" / "Files Projects"; "Contact" lit "Contact
 * Client").
 */
describe('gui nav highlight', () => {
  it('matches route on a segment boundary, not a bare prefix', () => {
    // The fixed comparison: exact OR route followed by a '/' separator.
    expect(appJs).toContain("hash === route || hash.indexOf(route + '/') === 0");
    // The buggy bare-prefix comparison must be gone.
    expect(appJs).not.toMatch(/hash\.indexOf\(route\)\s*===\s*0/);
  });
});
