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
