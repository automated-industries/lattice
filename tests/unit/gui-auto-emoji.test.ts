import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { guiAppHtml } from '../../src/gui/app.js';

/**
 * #9 — auto-pick an apt emoji for an object whose name isn't in the built-in
 * DISPLAY map and has no user override. autoEmojiFor() keyword-matches the name
 * and returns null when nothing fits (so displayFor falls back to DEFAULT_ICON).
 * Logic is pulled verbatim from the shipped client script and executed.
 */
function extractDecl(src: string, name: string): string {
  let i = src.indexOf('function ' + name + '(');
  let opener = '{';
  if (i < 0) {
    i = src.indexOf('var ' + name + ' =');
    if (i < 0) throw new Error('declaration not found: ' + name);
    const brace = src.indexOf('{', i);
    const bracket = src.indexOf('[', i);
    opener = brace >= 0 && (bracket < 0 || brace < bracket) ? '{' : '[';
  }
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let k = src.indexOf(opener, i);
  for (; k < src.length; k++) {
    if (src[k] === opener) depth++;
    else if (src[k] === closer) {
      depth--;
      if (depth === 0) {
        k++;
        break;
      }
    }
  }
  return src.slice(i, k) + (src[i] === 'v' ? ';' : '');
}

const code = ['AUTO_EMOJI', 'autoEmojiFor'].map((n) => extractDecl(guiAppHtml, n)).join('\n');
const api = runInNewContext(
  code + '\n({ autoEmojiFor });',
  {},
  { filename: 'gui-client-script.js' },
) as {
  autoEmojiFor: (name: string) => string | null;
};

describe('#9 autoEmojiFor — name → apt emoji', () => {
  it('maps common entity names to apt emojis', () => {
    expect(api.autoEmojiFor('meetings')).toBe('📅');
    expect(api.autoEmojiFor('contacts')).toBe('👥');
    expect(api.autoEmojiFor('projects')).toBe('🚀');
    expect(api.autoEmojiFor('invoices')).toBe('🧾');
    expect(api.autoEmojiFor('files')).toBe('📄');
    expect(api.autoEmojiFor('secrets')).toBe('🔐');
  });

  it('matches a keyword embedded in a multi-word, underscored name', () => {
    // 'meetings' is earlier in the table than 'client', so it wins deterministically.
    expect(api.autoEmojiFor('client_meetings')).toBe('📅');
    // singular/plural both match.
    expect(api.autoEmojiFor('payment')).toBe('🧾');
    // a domain word from a real schema still resolves (insurance → shield).
    expect(api.autoEmojiFor('flood_insurance_policies')).toBeTruthy();
    expect(api.autoEmojiFor('canonical_aliases')).toBeTruthy();
  });

  it('returns null when no keyword is apt (caller falls back to DEFAULT_ICON)', () => {
    expect(api.autoEmojiFor('xyzzy')).toBeNull();
    expect(api.autoEmojiFor('quux_widget')).toBeNull();
    expect(api.autoEmojiFor('')).toBeNull();
  });
});
