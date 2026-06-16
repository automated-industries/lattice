import { describe, it, expect } from 'vitest';
import { guiAppHtml } from '../../src/gui/app.js';

/**
 * Regression: clicking "Specific people…" on a row, selecting nobody, then
 * refreshing showed "Shared with specific people (0)". A row shared with nobody
 * is effectively private (RLS shows it only to the owner) and must read as such.
 *
 * Two parts, both asserted against the served SPA:
 *  1. Opening the share panel no longer eagerly persists `visibility='custom'`
 *     (that left the row stuck at custom-0). The first grant flips it to custom
 *     server-side; opening the panel is now a no-op.
 *  2. A shared `effectiveVisibility` helper renders an owner's custom-with-0-
 *     grantees row as private everywhere the sharing state is shown.
 */
describe('row sharing display — custom-with-0-grantees reads as private', () => {
  it('opening the share panel does not pre-flip the row to custom', () => {
    expect(guiAppHtml).toContain('var ensure = Promise.resolve();');
    // the old eager pre-flip is gone
    expect(guiAppHtml).not.toContain(
      "postVisibility('custom').then(function () { access.visibility = 'custom'; })",
    );
  });

  it('defines a shared effectiveVisibility helper that collapses owner custom-0 to private', () => {
    expect(guiAppHtml).toContain('function effectiveVisibility');
    expect(guiAppHtml).toContain('function visInfoLabel');
    // Only collapse for the owner's own view (a member viewing a row shared WITH
    // them keeps 'custom' → "Shared with you").
    expect(guiAppHtml).toContain("access.visibility === 'custom' && access.ownedByMe");
  });
});
