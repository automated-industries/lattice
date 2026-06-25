import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAssistantCredential } from '../../src/framework/user-config.js';
import {
  ANTHROPIC_KEY_KIND,
  CLAUDE_KEY_STEPS,
  hasClaudeKey,
  onboardClaudeKey,
  saveClaudeKey,
  type WizardIo,
} from '../../src/connect/onboarding.js';

/** A scripted {@link WizardIo}: returns `answer` to every prompt and records output. */
function fakeIo(answer: string): { io: WizardIo; printed: string[]; asked: string[] } {
  const printed: string[] = [];
  const asked: string[] = [];
  return {
    printed,
    asked,
    io: {
      print: (line) => {
        printed.push(line);
      },
      ask: (q) => {
        asked.push(q);
        return Promise.resolve(answer);
      },
    },
  };
}

describe('connect onboarding (Claude key)', () => {
  let tmpDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-connect-'));
    saved.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
    saved.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    // Isolate the machine credential store + ensure no ambient key leaks in.
    process.env.LATTICE_CONFIG_DIR = tmpDir;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (saved.LATTICE_CONFIG_DIR === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = saved.LATTICE_CONFIG_DIR;
    if (saved.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saveClaudeKey stores a trimmed key; hasClaudeKey reflects it', () => {
    expect(hasClaudeKey()).toBe(false);
    saveClaudeKey('  sk-ant-example  ');
    expect(getAssistantCredential(ANTHROPIC_KEY_KIND)).toBe('sk-ant-example');
    expect(hasClaudeKey()).toBe(true);
  });

  it('saveClaudeKey rejects an empty value (no silent blank key)', () => {
    expect(() => {
      saveClaudeKey('   ');
    }).toThrow();
    expect(hasClaudeKey()).toBe(false);
  });

  it('hasClaudeKey honors the ANTHROPIC_API_KEY env var', () => {
    expect(hasClaudeKey()).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    expect(hasClaudeKey()).toBe(true);
  });

  it('onboardClaudeKey prints the steps and saves a pasted key', async () => {
    const { io, printed, asked } = fakeIo('sk-ant-pasted');
    const ok = await onboardClaudeKey(io);
    expect(ok).toBe(true);
    expect(asked).toHaveLength(1);
    // The console.anthropic.com step is shown so a non-coder knows where to go.
    expect(printed.some((l) => l.includes('console.anthropic.com'))).toBe(true);
    expect(printed).toEqual(expect.arrayContaining([CLAUDE_KEY_STEPS[0]]));
    expect(getAssistantCredential(ANTHROPIC_KEY_KIND)).toBe('sk-ant-pasted');
  });

  it('onboardClaudeKey treats an empty answer as a surfaced skip', async () => {
    const { io, printed } = fakeIo('');
    const ok = await onboardClaudeKey(io);
    expect(ok).toBe(false);
    expect(getAssistantCredential(ANTHROPIC_KEY_KIND)).toBeNull();
    expect(printed.some((l) => l.toLowerCase().includes('not auto-categorized'))).toBe(true);
  });

  it('onboardClaudeKey short-circuits when a key is already connected', async () => {
    saveClaudeKey('sk-ant-existing');
    const { io, asked, printed } = fakeIo('ignored');
    const ok = await onboardClaudeKey(io);
    expect(ok).toBe(true);
    expect(asked).toHaveLength(0); // never prompted
    expect(printed.some((l) => l.toLowerCase().includes('already connected'))).toBe(true);
  });
});
