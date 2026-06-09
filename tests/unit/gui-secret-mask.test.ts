import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { guiAppHtml } from '../../src/gui/app.js';

/**
 * Encrypted-value masking, pulled from the shipped client script and executed.
 *
 * The native `secrets` table stores its `value` column encrypted-at-rest with an
 * `enc:` sentinel prefix. The GUI must render that ciphertext as the secret mask
 * (••••••••), never the raw `enc:<base64>` string. `looksEncrypted` is the pure
 * predicate every cell-render path consults alongside the operator-flagged
 * `isSecretColumn`. Guarding it here because the template-literal source has a
 * history of escape-collapse bugs silently disabling string matches.
 */

function extractDecl(src: string, name: string): string {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('declaration not found: ' + name);
  let depth = 0;
  let k = src.indexOf('{', i);
  for (; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) {
        k++;
        break;
      }
    }
  }
  return src.slice(i, k);
}

const code = extractDecl(guiAppHtml, 'looksEncrypted');
const api = runInNewContext(
  code + '\n({ looksEncrypted });',
  {},
  { filename: 'gui-client-script.js' },
) as { looksEncrypted: (v: unknown) => boolean };

describe('looksEncrypted (native secret value masking)', () => {
  it('treats an enc:-prefixed ciphertext as encrypted', () => {
    expect(api.looksEncrypted('enc:eyJpdiI6ImFiYyJ9')).toBe(true);
    expect(api.looksEncrypted('enc:')).toBe(true);
  });

  it('leaves plaintext, empty, and non-strings alone', () => {
    expect(api.looksEncrypted('sk-ant-plaintext')).toBe(false);
    expect(api.looksEncrypted('encore')).toBe(false); // prefix must be exactly "enc:"
    expect(api.looksEncrypted('')).toBe(false);
    expect(api.looksEncrypted(null)).toBe(false);
    expect(api.looksEncrypted(undefined)).toBe(false);
    expect(api.looksEncrypted(42)).toBe(false);
  });
});
