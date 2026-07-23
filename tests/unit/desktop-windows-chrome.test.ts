import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hideWindowsStartupChrome } from '../../desktop/windows-chrome.ts';

const REPO_ROOT = resolve(__dirname, '..', '..');

// The shim hides the stray console + blank phantom window the Windows raw-backend
// build allocates. It must be a strict no-op — never touching FFI — on every other
// platform and under Node/vitest, and both suppressions must stay wired in.
describe('hideWindowsStartupChrome — platform guard', () => {
  const g = globalThis as unknown as { Deno?: unknown };
  const orig = g.Deno;
  afterEach(() => {
    g.Deno = orig;
  });

  for (const os of ['darwin', 'linux'] as const) {
    it(`is a no-op on ${os} and never opens an FFI library`, () => {
      let dlopenCalled = false;
      g.Deno = {
        build: { os },
        dlopen: () => {
          dlopenCalled = true;
          throw new Error('dlopen must not be called off Windows');
        },
      };
      expect(() => {
        hideWindowsStartupChrome();
      }).not.toThrow();
      expect(dlopenCalled).toBe(false);
    });
  }

  it('is a no-op when Deno is undefined (Node/vitest)', () => {
    g.Deno = undefined;
    expect(() => {
      hideWindowsStartupChrome();
    }).not.toThrow();
  });
});

describe('Windows startup-chrome wiring + completeness', () => {
  it('desktop/main.ts imports and calls hideWindowsStartupChrome', () => {
    const main = readFileSync(resolve(REPO_ROOT, 'desktop/main.ts'), 'utf8');
    expect(main).toContain("from './windows-chrome.ts'");
    expect(main).toMatch(/hideWindowsStartupChrome\(\)\s*;/);
  });

  it('the shim suppresses BOTH the console and the phantom window', () => {
    const shim = readFileSync(resolve(REPO_ROOT, 'desktop/windows-chrome.ts'), 'utf8');
    // Neither suppression may be dropped without failing this guard.
    expect(shim).toContain('GetConsoleWindow');
    expect(shim).toContain('EnumWindows');
    expect(shim).toContain('ShowWindow');
  });
});
