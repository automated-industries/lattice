import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';
import { css } from '../../src/gui/app/css.js';

/**
 * Visibility indicators: a shared lock/eye component (visIndicator) with a hover
 * tooltip, reused on the entity-detail header AND the fs card tiles, plus the
 * Connect-with-Claude step in the onboarding wizard.
 */
describe('gui visibility indicators', () => {
  it('defines a shared visIndicator helper and reuses it on detail + cards', () => {
    expect(appJs).toContain('function visIndicator(access, extraClass)');
    // Entity-detail header reuses it (keeps the detail-vis-icon tint class).
    expect(appJs).toContain("visIndicator(a, 'detail-vis-icon')");
    // The fs card tiles reuse the SAME component, positioned in the corner.
    expect(appJs).toContain("visIndicator(r._access, 'fs-tile-vis')");
  });

  it('styles the shared indicator + the card-corner placement', () => {
    expect(css).toContain('.vis-indicator');
    expect(css).toContain('.fs-tile-vis');
    // The tile must be a positioning context for the absolute corner indicator.
    expect(css).toMatch(/\.fs-tile\s*\{[^}]*position:\s*relative/);
  });
});

/**
 * Behavioral test of the actual shipped helper: pull escapeHtml + the lock/eye
 * SVGs + visIndicator out of the appJs bundle and run it. Asserts the lock vs eye
 * choice, the state+ownership-aware tooltip text, the is-private modifier, the
 * caller-supplied extra class, and that it returns '' with no access summary (a
 * local / non-cloud workspace shows no indicator).
 */
function loadVisIndicator(): (access: unknown, extraClass?: string) => string {
  const eh = appJs.slice(appJs.indexOf('function escapeHtml'), appJs.indexOf('function truncate'));
  const blockStart = appJs.indexOf('var LOCK_SVG');
  const fnStart = appJs.indexOf('function visIndicator', blockStart);
  const blockEnd = appJs.indexOf('}', fnStart) + 1; // visIndicator has no inner braces
  if (blockStart < 0 || fnStart < 0 || blockEnd <= fnStart) {
    throw new Error('could not locate visIndicator in appJs');
  }
  const block = appJs.slice(blockStart, blockEnd);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(`${eh}\n${block}\n;return visIndicator;`) as () => (
    access: unknown,
    extraClass?: string,
  ) => string;
  return factory();
}

describe('visIndicator (shared lock/eye component)', () => {
  const vis = loadVisIndicator();
  // Distinctive path fragments from the two SVGs (see LOCK_SVG / EYE_SVG).
  const LOCK = 'd="M8 11V7a4 4 0 0 1 8 0v4"';
  const EYE = 'd="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"';

  it('returns empty when there is no access summary (local / non-cloud)', () => {
    expect(vis(null)).toBe('');
    expect(vis(undefined)).toBe('');
    expect(vis({})).toBe('');
  });

  it('shows a LOCK + private tooltip for a private row', () => {
    const out = vis({ visibility: 'private', ownedByMe: true });
    expect(out).toContain(LOCK);
    expect(out).not.toContain(EYE);
    expect(out).toContain('is-private');
    expect(out).toContain('title="Private');
    expect(out).toContain('only you can see this');
  });

  it('shows an EYE + everyone tooltip for an everyone-shared row', () => {
    const out = vis({ visibility: 'everyone', ownedByMe: true });
    expect(out).toContain(EYE);
    expect(out).not.toContain(LOCK);
    expect(out).not.toContain('is-private');
    expect(out).toContain('visible to everyone');
  });

  it('distinguishes a custom share by ownership (owner vs recipient)', () => {
    // An owner's custom share with ≥1 grantee reads as "specific people".
    const owned = { visibility: 'custom', ownedByMe: true, grantees: ['member-x'] };
    expect(vis(owned)).toContain('Shared with specific people');
    expect(vis({ visibility: 'custom', ownedByMe: false })).toContain('Shared with you');
    // Custom is "shared", so it uses the eye, never the lock.
    expect(vis(owned)).toContain(EYE);
  });

  it('renders an owner custom-with-0-grantees row as PRIVATE (effectively private)', () => {
    // A row "shared with specific people" but with nobody on the list is only
    // visible to the owner, so it must read as private — not "specific people (0)".
    const out = vis({ visibility: 'custom', ownedByMe: true, grantees: [] });
    expect(out).toContain(LOCK);
    expect(out).not.toContain(EYE);
    expect(out).toContain('is-private');
    expect(out).toContain('only you can see this');
  });

  it('appends the caller-supplied positioning class', () => {
    expect(vis({ visibility: 'everyone' }, 'fs-tile-vis')).toContain('vis-indicator fs-tile-vis');
    expect(vis({ visibility: 'private' }, 'detail-vis-icon')).toContain('detail-vis-icon');
  });
});

/**
 * Onboarding wizard gains an optional, skippable Connect-with-Claude step right
 * after the name/email (identity) step, reusing the same OAuth exchange flow as
 * the Settings panel.
 */
describe('gui onboarding — Connect with Claude step', () => {
  it('adds a connect step between identity and create/join', () => {
    expect(appJs).toContain("st.step === 'connect'");
    // Identity advances INTO the connect step…
    expect(appJs).toContain("st.step = 'connect';");
    // …and the connect step advances on to create (kind) or join.
    expect(appJs).toContain("st.step = mode === 'join' ? 'join' : 'kind';");
  });

  it('offers the Connect-with-Claude button and makes it skippable', () => {
    expect(appJs).toContain('id="ob-connect-btn"');
    expect(appJs).toContain('Connect with Claude');
    expect(appJs).toContain('Skip for now');
    // Reuses the existing subscription-OAuth exchange endpoint.
    expect(appJs).toContain("fetch('/api/assistant/oauth/exchange'");
    // Reflects an already-connected state instead of re-prompting.
    expect(appJs).toContain('Connected with Claude');
  });
});
