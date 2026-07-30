/**
 * Shared text scanning for the source-tree guards.
 *
 * Two guards read the source tree and count things in it — the layering guard
 * counts SQL an HTTP adapter still writes, and the route census counts branches
 * on a state-changing request method. Both have to look at CODE and not at prose
 * about code, and both have to keep line numbers intact so a failure can name the
 * line. That is one job, so it lives in one place: a second copy of a parser this
 * subtle would drift, and the drift would be silent in both directions (a guard
 * that stops matching reports a clean tree forever).
 */

/**
 * Blank out comments so a line that merely TALKS about a query is not counted as
 * one. This matters more than it sounds: several adapters explain, in prose,
 * which reads a scoped cloud member is not granted — and if that prose counted,
 * the debt number would be mostly comments, "paying it down" could mean
 * rewording one, and the guard would measure nothing.
 *
 * A regex cannot do this correctly, because `//` inside a string is not a
 * comment and a backtick inside a comment does not open a template. So this
 * walks the text tracking string / template / comment state, including brace
 * depth inside a template's interpolations. Comments are replaced with spaces
 * rather than removed, so line numbers survive.
 */
export function stripCommentsForScan(text: string): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'str' | 'tmpl' = 'code';
  let quote = '';
  const interpolationDepth: number[] = [];
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1] ?? '';
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        state = 'str';
        quote = c;
        out += c;
        i++;
        continue;
      }
      if (c === '`') {
        state = 'tmpl';
        out += c;
        i++;
        continue;
      }
      if (interpolationDepth.length > 0) {
        const top = interpolationDepth.length - 1;
        if (c === '{') interpolationDepth[top] = (interpolationDepth[top] ?? 0) + 1;
        else if (c === '}') {
          if ((interpolationDepth[top] ?? 0) === 0) {
            interpolationDepth.pop();
            state = 'tmpl';
            out += c;
            i++;
            continue;
          }
          interpolationDepth[top] = (interpolationDepth[top] ?? 0) - 1;
        }
      }
      out += c;
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      } else out += ' ';
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    if (state === 'str') {
      if (c === '\\') {
        out += c + next;
        i += 2;
        continue;
      }
      if (c === quote) state = 'code';
      out += c;
      i++;
      continue;
    }
    // inside a template literal
    if (c === '\\') {
      out += c + next;
      i += 2;
      continue;
    }
    if (c === '`') {
      state = 'code';
      out += c;
      i++;
      continue;
    }
    if (c === '$' && next === '{') {
      interpolationDepth.push(0);
      state = 'code';
      out += '${';
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
