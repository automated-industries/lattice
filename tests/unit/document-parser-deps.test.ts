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

/**
 * Regression guard for the packaged-desktop document-extraction bug.
 *
 * The parsers are lazy-loaded so a missing one degrades only that one format. The
 * lazy load MUST use a LITERAL `import('<name>')`: the packaged desktop app is a
 * `deno desktop` bundle with no node_modules, and its static bundler only includes
 * dynamic imports whose specifier is a string literal. A runtime *variable*
 * specifier (the old `loadParser(specifier: string)` → `await import(specifier)`)
 * is invisible to that bundler, so EVERY parser was silently dropped from the
 * desktop app and every dragged Office document extracted nothing (docx showed
 * "No inline preview"; pdf was masked only because it has an iframe fallback).
 *
 * This locks in the literal-import form so a refactor back to a variable specifier
 * fails loudly here instead of shipping a desktop app that can't read documents.
 */
const PARSER_FILES: Record<string, string[]> = {
  'src/gui/ai/doc/ooxml.ts': ['mammoth', 'unpdf', 'word-extractor'],
  'src/gui/ai/doc/helpers.ts': ['fflate'],
};

describe('document parsers are bundleable by the desktop static bundler', () => {
  for (const [rel, parsers] of Object.entries(PARSER_FILES)) {
    const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    for (const name of parsers) {
      it(`${rel} loads "${name}" via a LITERAL import() (bundled into the desktop app)`, () => {
        // Accept single or double quotes; the point is a string-literal specifier.
        const literal = src.includes(`import('${name}')`) || src.includes(`import("${name}")`);
        expect(
          literal,
          `${rel} must load "${name}" via a literal import('${name}') so the ` +
            `\`deno desktop\` bundler includes it — a variable specifier ships a ` +
            `desktop app that silently extracts nothing from documents`,
        ).toBe(true);
      });
    }
  }

  it('loadParser takes a literal-import thunk, never a runtime string specifier', () => {
    const helpers = readFileSync(resolve(REPO_ROOT, 'src/gui/ai/doc/helpers.ts'), 'utf8');
    // The thunk signature — proves callers pass `() => import('x')`, not a bare name.
    expect(helpers).toContain('load: () => Promise<unknown>');
    // The old, un-bundleable form must be gone.
    expect(
      helpers.includes('import(specifier)'),
      'loadParser must not `await import(specifier)` a variable — invisible to the desktop bundler',
    ).toBe(false);
  });
});
