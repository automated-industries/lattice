import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRowContext, type RowContextLocator } from '../../src/gui/row-context.js';

/**
 * Secret columns must be masked in a row's rendered context BEFORE it crosses the
 * wire to the browser (the record Markdown view renders + edits this content). The
 * default renderer emits `- **col:** value` bold bullets, and the old redaction
 * regex (`^col:`) only matched a plain `col:` line — so secrets in the default
 * shape leaked in plaintext. These pin the broadened redaction.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeRendered(content: string): { outputDir: string; locator: RowContextLocator } {
  const outputDir = mkdtempSync(join(tmpdir(), 'lattice-ctxredact-'));
  dirs.push(outputDir);
  const dir = join(outputDir, 'notes', 'r1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'NOTE.md'), content, 'utf8');
  return { outputDir, locator: { directoryRoot: 'notes', slug: 'r1', fileNames: ['NOTE.md'] } };
}

describe('readRowContext secret redaction', () => {
  it('masks a secret value in the DEFAULT bold-bullet render (- **col:** value)', () => {
    const { outputDir, locator } = writeRendered(
      '# Row\n\n- **title:** Hello\n- **api_key:** sk-live-9f3secret\n',
    );
    const content = readRowContext(outputDir, locator, new Set(['api_key']))[0]!.content;
    expect(content).not.toContain('sk-live-9f3secret'); // the secret never crosses the wire
    expect(content).toContain('••••••••'); // masked
    expect(content).toContain('- **api_key:**'); // the label is preserved
    expect(content).toContain('Hello'); // non-secret fields are untouched
  });

  it('masks a secret value in the plain / frontmatter form (col: value)', () => {
    const { outputDir, locator } = writeRendered(
      '---\napi_key: sk-frontmatter-secret\n---\n\n# Row\n\napi_key: sk-plain-secret\n',
    );
    const content = readRowContext(outputDir, locator, new Set(['api_key']))[0]!.content;
    expect(content).not.toContain('sk-frontmatter-secret');
    expect(content).not.toContain('sk-plain-secret');
    expect(content.match(/••••••••/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves content untouched when no column is secret', () => {
    const { outputDir, locator } = writeRendered('# Row\n\n- **api_key:** visible\n');
    const content = readRowContext(outputDir, locator, new Set())[0]!.content;
    expect(content).toContain('visible');
  });

  it('masks a MULTI-LINE secret whole, including its indented continuation lines', () => {
    // A multi-line secret (e.g. a PEM key) renders as a bullet + 2-space-indented
    // continuation lines; every line must be masked, not just the first.
    const { outputDir, locator } = writeRendered(
      [
        '# Row',
        '',
        '- **title:** Hello',
        '- **private_key:** -----BEGIN KEY-----',
        '  bWlkZGxlLWJhc2U2NA==',
        '  c2Vjb25kLWxpbmU=',
        '  -----END KEY-----',
        '- **note:** after',
        '',
      ].join('\n'),
    );
    const content = readRowContext(outputDir, locator, new Set(['private_key']))[0]!.content;
    expect(content).not.toContain('BEGIN KEY'); // first line masked
    expect(content).not.toContain('bWlkZGxlLWJhc2U2NA=='); // continuation masked
    expect(content).not.toContain('c2Vjb25kLWxpbmU='); // continuation masked
    expect(content).not.toContain('END KEY'); // last continuation masked
    expect(content).toContain('- **private_key:** ••••••••'); // collapsed to the mask
    expect(content).toContain('Hello'); // neighbor above untouched
    expect(content).toContain('- **note:** after'); // neighbor below untouched
  });

  it('masks a multi-line secret that contains an INTERIOR BLANK line (no partial leak)', () => {
    // A multi-line secret whose value has a blank line between paragraphs renders
    // as a bullet + an empty line + more indented lines. The empty line must not
    // terminate the mask — everything after it must still be redacted.
    const { outputDir, locator } = writeRendered(
      [
        '# Row',
        '',
        '- **title:** Hello',
        '- **token:** PART-ONE-SECRET',
        '', // interior blank line inside the secret value
        '  PART-TWO-SECRET',
        '  PART-THREE-SECRET',
        '- **note:** after',
        '',
      ].join('\n'),
    );
    const content = readRowContext(outputDir, locator, new Set(['token']))[0]!.content;
    expect(content).not.toContain('PART-ONE-SECRET'); // first line masked
    expect(content).not.toContain('PART-TWO-SECRET'); // line after the blank masked
    expect(content).not.toContain('PART-THREE-SECRET'); // and the rest
    expect(content).toContain('- **token:** ••••••••');
    expect(content).toContain('Hello'); // neighbor above untouched
    expect(content).toContain('- **note:** after'); // neighbor below untouched (not swallowed)
  });

  it('does not let a similarly-named non-secret column trigger redaction', () => {
    // Only the exact secret column name is masked; `api_key_hint` stays visible.
    const { outputDir, locator } = writeRendered(
      '# Row\n\n- **api_key:** sk-secret\n- **api_key_hint:** ends in 42\n',
    );
    const content = readRowContext(outputDir, locator, new Set(['api_key']))[0]!.content;
    expect(content).not.toContain('sk-secret');
    expect(content).toContain('ends in 42');
  });
});
