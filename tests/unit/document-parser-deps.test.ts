import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression guard for the 2.2.3 → 2.3.0 document-extraction bug.
 *
 * 2.2.3 shipped the native document parsers (`mammoth`, `unpdf`, `word-extractor`,
 * `fflate`), the `file-type` sniffer, and `@anthropic-ai/sdk` as
 * `optionalDependencies`. Any install that omitted optionals — `npm install
 * --omit=optional`, `npm ci --omit=optional`, a Docker layer that prunes them, or
 * an optional native build such as `sharp` failing and taking the whole optional
 * group down with it — shipped WITHOUT them, and a dragged document silently
 * extracted nothing: the parser import was caught and degraded to a `skip` with no
 * error surfaced.
 *
 * 2.3.0 makes them regular `dependencies` so document ingest works on every
 * install. This test locks that in — it fails loudly if any of them slides back to
 * optional. `pg` / `playwright` / `sharp` stay optional ON PURPOSE (a Postgres
 * backend, browser crawling, and native image scaling are genuinely opt-in and
 * already degrade gracefully), so we also assert those were NOT promoted.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/** Must be regular dependencies — they ARE the document-analysis engine. */
const REQUIRED = ['@anthropic-ai/sdk', 'mammoth', 'unpdf', 'word-extractor', 'fflate', 'file-type'];
/** Must stay optional — genuinely opt-in, degrade gracefully when absent. */
const STAY_OPTIONAL = ['pg', 'playwright', 'sharp'];

describe('document-parser dependencies (2.3.0 regression guard)', () => {
  for (const name of REQUIRED) {
    it(`ships "${name}" as a regular dependency, never optional`, () => {
      expect(pkg.dependencies?.[name], `${name} must be in "dependencies"`).toBeTruthy();
      expect(
        pkg.optionalDependencies?.[name],
        `${name} must NOT be in "optionalDependencies" — an --omit=optional install ` +
          `would drop it and dragged documents would silently extract nothing`,
      ).toBeUndefined();
    });
  }

  for (const name of STAY_OPTIONAL) {
    it(`keeps "${name}" optional (opt-in, degrades gracefully)`, () => {
      expect(pkg.optionalDependencies?.[name], `${name} should stay optional`).toBeTruthy();
      expect(pkg.dependencies?.[name], `${name} should not be a hard dependency`).toBeUndefined();
    });
  }

  it('externalizes every promoted parser in BOTH tsup builds (kept out of the bundle)', () => {
    const tsup = readFileSync(resolve(REPO_ROOT, 'tsup.config.ts'), 'utf8');
    const externalArrays = tsup.match(/external:\s*\[[^\]]*\]/g) ?? [];
    expect(externalArrays.length).toBeGreaterThanOrEqual(2);
    for (const arr of externalArrays) {
      for (const name of REQUIRED) {
        expect(arr, `${name} must be external in every build`).toContain(`'${name}'`);
      }
    }
  });
});
