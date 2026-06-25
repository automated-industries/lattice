import { createInterface } from 'node:readline';
import { getAssistantCredential, setAssistantCredential } from '../framework/user-config.js';

/**
 * Non-coder onboarding for `lattice connect`. The only thing a user must supply
 * is their Claude (Anthropic) API key — Lattice uses it to read uploaded files
 * and auto-organize them against the connected data. The key is stored in the
 * machine-local encrypted credential store (the same place the assistant reads
 * via `resolveClaudeAuth` / `getAnthropicApiKey`); it is never written into the
 * connected database and never leaves the machine.
 *
 * The pieces are split so the storage logic is unit-testable without a TTY:
 * {@link saveClaudeKey} / {@link hasClaudeKey} are pure-ish, and the interactive
 * flow takes an injectable {@link WizardIo}.
 */

/** Machine-local credential kind for the Claude API key. Matches the kind the
 *  assistant resolves, so a key saved here is immediately usable for ingest
 *  enrichment. */
export const ANTHROPIC_KEY_KIND = 'anthropic_api_key';

/**
 * Save the Claude API key into the machine-local encrypted credential store.
 * Trims surrounding whitespace and rejects an empty value (fail loudly rather
 * than silently storing a blank key that would later look "connected").
 */
export function saveClaudeKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('Claude API key is empty.');
  setAssistantCredential(ANTHROPIC_KEY_KIND, trimmed);
}

/**
 * Whether a Claude key is already available — either the stored credential or
 * the `ANTHROPIC_API_KEY` environment variable (same precedence the assistant
 * uses). Used to skip the prompt when the user is already connected.
 */
export function hasClaudeKey(): boolean {
  return Boolean(getAssistantCredential(ANTHROPIC_KEY_KIND) ?? process.env.ANTHROPIC_API_KEY);
}

/**
 * Minimal console I/O, injectable so {@link onboardClaudeKey} can be driven by a
 * test without a real terminal.
 */
export interface WizardIo {
  /** Print a line to the user. */
  print: (line: string) => void;
  /** Prompt the user and resolve with their (untrimmed) answer. */
  ask: (question: string) => Promise<string>;
  /** Release any underlying resource (e.g. the readline interface). Optional. */
  close?: () => void;
}

/**
 * The step-by-step the wizard prints before asking for the key. Kept as data so
 * tests can assert it and the docs can reuse the exact wording.
 */
export const CLAUDE_KEY_STEPS: readonly string[] = [
  'Lattice uses your own Claude API key to read and auto-organize what you upload.',
  'To get a key (about a minute):',
  '  1. Open https://console.anthropic.com/settings/keys in your browser.',
  '  2. Sign in, or create a free account.',
  '  3. Click "Create Key", name it, and copy the value (it starts with "sk-ant-").',
  'Paste it below. It is stored encrypted on THIS computer only — never uploaded,',
  'and never written into your database.',
];

/**
 * Interactive Claude-key onboarding. Returns whether a key is configured at the
 * end. If a key is already available it returns immediately. The user may press
 * Enter to skip: files still upload, but without auto-categorization — and that
 * is surfaced explicitly, never hidden.
 */
export async function onboardClaudeKey(io: WizardIo): Promise<boolean> {
  if (hasClaudeKey()) {
    io.print('* Claude key already connected.');
    return true;
  }
  for (const line of CLAUDE_KEY_STEPS) io.print(line);
  const answer = await io.ask('Paste your Claude API key (or press Enter to skip): ');
  if (!answer.trim()) {
    io.print('! Skipped. Files will be saved but NOT auto-categorized until a key is added.');
    io.print('  Re-run `lattice connect` any time to add it.');
    return false;
  }
  saveClaudeKey(answer);
  io.print('* Claude key saved (encrypted, on this computer only).');
  return true;
}

/** Build a readline-backed {@link WizardIo} for real CLI use. Call `close()`
 *  when done so the process can exit. */
export function createReadlineIo(): WizardIo {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    print: (line: string) => {
      console.log(line);
    },
    ask: (question: string) =>
      new Promise<string>((resolveAnswer) => {
        rl.question(question, resolveAnswer);
      }),
    close: () => {
      rl.close();
    },
  };
}
