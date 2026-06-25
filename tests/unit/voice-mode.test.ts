import { describe, it, expect } from 'vitest';
import { voiceModeFromConfig, shouldShowMic } from '../../src/gui/ai/voice-mode.js';

describe('voiceModeFromConfig', () => {
  it("'local' is on-device and needs NO key (the keyless default)", () => {
    expect(
      voiceModeFromConfig({ preference: 'local', hasOpenaiKey: false, hasElevenlabsKey: false }),
    ).toBe('local');
  });

  it('an explicit cloud choice uses its key when present', () => {
    expect(
      voiceModeFromConfig({ preference: 'openai', hasOpenaiKey: true, hasElevenlabsKey: false }),
    ).toBe('openai');
    expect(
      voiceModeFromConfig({
        preference: 'elevenlabs',
        hasOpenaiKey: false,
        hasElevenlabsKey: true,
      }),
    ).toBe('elevenlabs');
  });

  it('a cloud choice with no key falls back to on-device (never silently off)', () => {
    expect(
      voiceModeFromConfig({ preference: 'openai', hasOpenaiKey: false, hasElevenlabsKey: false }),
    ).toBe('local');
    expect(
      voiceModeFromConfig({
        preference: 'elevenlabs',
        hasOpenaiKey: false,
        hasElevenlabsKey: false,
      }),
    ).toBe('local');
  });

  it("'auto' is the legacy No-Voice sentinel: a cloud key wins, else off", () => {
    expect(
      voiceModeFromConfig({ preference: 'auto', hasOpenaiKey: true, hasElevenlabsKey: false }),
    ).toBe('openai');
    expect(
      voiceModeFromConfig({ preference: 'auto', hasOpenaiKey: false, hasElevenlabsKey: true }),
    ).toBe('elevenlabs');
    expect(
      voiceModeFromConfig({ preference: 'auto', hasOpenaiKey: false, hasElevenlabsKey: false }),
    ).toBe('off');
  });

  it('prefers OpenAI over ElevenLabs when auto + both keys present', () => {
    expect(
      voiceModeFromConfig({ preference: 'auto', hasOpenaiKey: true, hasElevenlabsKey: true }),
    ).toBe('openai');
  });
});

describe('shouldShowMic', () => {
  it('shows the mic for every mode except off', () => {
    expect(shouldShowMic('local')).toBe(true);
    expect(shouldShowMic('openai')).toBe(true);
    expect(shouldShowMic('elevenlabs')).toBe(true);
    expect(shouldShowMic('off')).toBe(false);
  });
});
