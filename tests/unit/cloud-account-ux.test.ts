import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appJs } from '../../src/gui/app/script.js';
import { accountMenuJs } from '../../src/gui/app/modules/account-menu.js';
import { bootJs } from '../../src/gui/app/modules/boot.js';
import { DEFAULT_MODEL } from '../../src/ai/llm-client.js';

/**
 * The cloud-account surfaces in the GUI client: what the header account menu says
 * about the model that is actually answering turns, and how boot behaves when the
 * signed-in cloud account has no balance left to spend.
 *
 * These pin the composed client bundle because the client is emitted as template
 * -literal strings, not a bundled app — so the module string IS the artifact.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

describe('header account menu — the active model source', () => {
  it('is part of the composed client bundle', () => {
    expect(appJs).toContain(accountMenuJs);
  });

  it('names the cloud account as the active source when it is the active provider', () => {
    expect(accountMenuJs).toContain("cfg.activeProvider === 'lattice_cloud'");
    expect(accountMenuJs).toContain('Connected with your Lattice Cloud account');
  });

  it('still names the other two sources, so the line always says which one is live', () => {
    expect(accountMenuJs).toContain('Connected with Claude');
    expect(accountMenuJs).toContain("'Connected to ' + (oai.model");
  });

  it('shows the cloud balance and a top-up link', () => {
    expect(accountMenuJs).toContain('account-menu-balance');
    expect(accountMenuJs).toContain('Lattice tokens');
    expect(accountMenuJs).toContain('account-menu-topup');
    expect(accountMenuJs).toContain('Add tokens');
  });

  it('says the balance is unavailable rather than rendering a zero or a stale number', () => {
    // The honesty requirement: a balance that could not be read is reported as
    // unreadable. Rendering "$0.00" there would tell the user they are out of
    // money when we simply do not know. So the row renders when a number came
    // back OR when the server reported the read as failed — and stays absent
    // when there is no balance to speak of at all.
    expect(accountMenuJs).toContain('cfg.balanceUnavailable !== true');
    expect(accountMenuJs).toContain('Balance unavailable');
    // The amount is only formatted when a number actually came back.
    expect(accountMenuJs).toContain("typeof cfg.balanceCents === 'number'");
  });

  it('offers a disconnect affordance for the cloud account', () => {
    expect(accountMenuJs).toContain('Disconnect Lattice Cloud');
    expect(accountMenuJs).toContain("'/api/assistant/provider/lattice-cloud'");
  });

  it('keeps the menu reachable when the cloud account is configured but out of balance', () => {
    // connected flips to false once the balance is spent, and the menu is where the
    // top-up link lives — hiding it on !connected would hide the way out.
    expect(accountMenuJs).toContain('cfg.latticeCloud && cfg.latticeCloud.configured');
  });
});

describe('boot gate — a spent cloud balance is NOT connected', () => {
  it('is part of the composed client bundle', () => {
    expect(appJs).toContain(bootJs);
  });

  it('routes a balance-exhausted account to top up or to another provider', () => {
    expect(bootJs).toContain("cfg.modelAccessBlocked === 'cloud_balance_exhausted'");
    // The wall is the "connect another provider" path; the notice carries top-up.
    expect(bootJs).toContain('showConnectWall');
    expect(bootJs).toContain('Add tokens');
    expect(bootJs).toContain('cfg.topUpUrl');
  });

  it('clears the notice once a model is connected, so it cannot outlive the wall', () => {
    expect(bootJs).toContain('removeModelBlockedNotice');
  });
});

describe('the default model id is defined in exactly one place', () => {
  const read = (rel: string): string => readFileSync(join(HERE, '../../', rel), 'utf8');
  // The model id each of these files declares for itself (null when it declares
  // none — which is the end state for everything but the first entry).
  const definitions = (['src/ai/llm-client.ts', 'src/gui/ai/chat.ts'] as const).map((rel) => ({
    rel,
    literal: /export const DEFAULT_MODEL = '([^']+)'/.exec(read(rel))?.[1] ?? null,
  }));

  it('is exported from the shared model-client module', () => {
    expect(definitions[0]?.literal).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL.length).toBeGreaterThan(0);
  });

  it('is re-exported by the chat loop, never restated', async () => {
    // A second literal is a silent-drift hazard: bump one copy and half the
    // features quietly move to a different model. The chat loop must import the
    // shared constant and re-export it for its own downstream importers.
    expect(
      definitions[1]?.literal,
      'src/gui/ai/chat.ts still declares its own DEFAULT_MODEL — it must re-export ' +
        'DEFAULT_MODEL from src/ai/llm-client.ts instead of restating the id',
    ).toBeNull();
    // The import direction that cannot cycle: llm-client.ts is a leaf module.
    expect(read('src/gui/ai/chat.ts')).toContain("from '../../ai/llm-client.js'");
    // And the re-exported binding is the shared one, at runtime.
    const chat = await import('../../src/gui/ai/chat.js');
    expect(chat.DEFAULT_MODEL).toBe(DEFAULT_MODEL);
  });
});
