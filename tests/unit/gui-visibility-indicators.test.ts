import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';
import { css } from '../../src/gui/app/css.js';

/**
 * Visibility indicators: a shared lock/eye component (visIndicator) with a hover
 * tooltip, reused on the entity-detail header AND the fs card tiles, plus the
 * Connect-with-Claude step in the onboarding wizard.
 */
describe('gui visibility indicators', () => {
  it('defines a shared visIndicator helper and reuses it on the detail header', () => {
    expect(appJs).toContain('function visIndicator(access, extraClass)');
    // Entity-detail header reuses it (keeps the detail-vis-icon tint class).
    expect(appJs).toContain("visIndicator(a, 'detail-vis-icon')");
  });

  it('styles the shared indicator', () => {
    expect(css).toContain('.vis-indicator');
  });
});

/**
 * External-DB tables are stored under a machine-namespaced physical name
 * (db_<database>_<connid>_<table>) that title-cases into noise. displayFor honors
 * a server-supplied clean label (entityLabel) for those, via a memoized map.
 */
describe('gui displayFor — clean labels for machine-namespaced connected tables', () => {
  it('builds a memoized entity-label map keyed on the entities payload identity', () => {
    expect(appJs).toContain('function entityLabelMap()');
    // Rebuilds only when the tables array reference changes (not every render).
    expect(appJs).toContain('_entityLabelCache.src !== tables');
    expect(appJs).toContain('t.entityLabel');
  });

  it('displayFor prefers a built-in label, then the server label, then the raw name', () => {
    // The server label is title-cased; the raw de-underscored name is the last resort.
    expect(appJs).toContain('var serverLabel = entityLabelMap()[name];');
    expect(appJs).toContain('serverLabel ? titleCase(serverLabel) : titleCase(name)');
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
 * The onboarding wizard has NO connect step. A connected Claude subscription is
 * enforced globally by the boot connect wall (before any workspace loads), so by
 * the time the create/join wizard runs the assistant is already connected — the
 * per-wizard connect step was removed to avoid a redundant second prompt.
 */
describe('gui onboarding — no in-wizard connect step (handled by the boot wall)', () => {
  it('advances identity straight to create (kind) or join — no connect step', () => {
    // Identity → kind/join directly; there is no intermediate 'connect' step.
    expect(appJs).toContain("st.step = mode === 'join' ? 'join' : 'kind';");
    expect(appJs).not.toContain("st.step === 'connect'");
    expect(appJs).not.toContain("st.step = 'connect';");
  });

  it('does not render an in-wizard Connect-with-Claude affordance', () => {
    // The skippable in-wizard button + its inline OAuth-code exchange are gone.
    expect(appJs).not.toContain('id="ob-connect-btn"');
    expect(appJs).not.toContain('id="ob-connect-finish"');
    expect(appJs).not.toContain('Skip for now');
  });
});
