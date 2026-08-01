/**
 * No test may pop open a browser tab on the developer running it.
 *
 * `startGuiServer()` opens the URL it just bound in the system browser unless it
 * is told not to — the right default for `lattice gui` and the desktop shell,
 * where launching the interface IS the command. In a test it is pure collateral:
 * the suite binds an ephemeral port, the tab that gets opened is dead by the time
 * it paints, and a run that touches N such tests leaves N stray
 * `http://127.0.0.1:<random>` tabs behind. It is silent — nothing in the run
 * output says a tab was opened — so it survives review and only surfaces as the
 * developer's browser jumping to the foreground mid-suite.
 *
 * Remembering `openBrowser: false` at every call site is not a guard; forgetting
 * it once is what this test exists to catch. Every `startGuiServer(` under
 * `tests/` must pass it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = fileURLToPath(new URL('..', import.meta.url));

function everyTsFileUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...everyTsFileUnder(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Blanks out comments and string/template literals, preserving offsets and line
 * structure so what is left is executable code only.
 *
 * Without this the scan reads its own prose: several test files describe
 * `startGuiServer(...)` in a comment, and a comment's parens balance just as
 * happily as a real call's do — every one of them would be reported as a call
 * site that opens a browser, and the guard would be noise instead of a signal.
 */
function codeOnly(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  for (let i = 0; i < src.length; i++) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop - 1;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i];
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === '\\') j++;
        else if (src[j] === quote) break;
      }
      blank(i, Math.min(j + 1, src.length));
      i = j;
    }
  }
  return out.join('');
}

/**
 * Returns the source of each `startGuiServer(...)` call in `src`, from the
 * opening paren to its match, so a multi-line options object is inspected whole.
 */
function guiServerCalls(source: string): string[] {
  const src = codeOnly(source);
  const calls: string[] = [];
  const CALL = /startGuiServer\(/g;
  let m: RegExpExecArray | null;
  while ((m = CALL.exec(src))) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) {
          calls.push(src.slice(m.index, i + 1));
          break;
        }
      }
    }
  }
  return calls;
}

describe('a test run never opens a browser tab', () => {
  it('passes openBrowser: false at every startGuiServer call under tests/', () => {
    const offenders: string[] = [];
    for (const file of everyTsFileUnder(TESTS_DIR)) {
      const src = readFileSync(file, 'utf8');
      // This file quotes the call in its own prose; it starts no server.
      if (file === fileURLToPath(import.meta.url)) continue;
      for (const call of guiServerCalls(src)) {
        if (!/openBrowser\s*:/.test(call)) {
          offenders.push(
            `${relative(TESTS_DIR, file)}: ${call.replace(/\s+/g, ' ').slice(0, 120)}`,
          );
        }
      }
    }
    expect(
      offenders,
      'these test call sites let startGuiServer fall through to its default and open a ' +
        'real browser tab on whoever runs the suite — add `openBrowser: false`:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
