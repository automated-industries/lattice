/**
 * Pure derivation of the assistant's voice (speech-to-text) mode from the user's
 * preference + which cloud keys are configured.
 *
 * On-device dictation is the keyless default, so the mic is available with NO key
 * — the GUI is no longer gated on a cloud voice key. A cloud provider is used only
 * as a fallback when the user explicitly picks one AND has its key configured.
 *
 * Extracted as a pure function so the mode logic (and the "should the mic show"
 * decision) is unit-testable without booting a server.
 */

/** The resolved voice mode the GUI acts on. */
export type VoiceMode = 'local' | 'openai' | 'elevenlabs' | 'off';

/** The stored user preference (machine-local). */
export type VoicePreference = 'local' | 'auto' | 'openai' | 'elevenlabs';

export interface VoiceModeInputs {
  /** The user's stored `voice_provider` preference. */
  preference: VoicePreference;
  /** Whether an OpenAI key is available (stored or env). */
  hasOpenaiKey: boolean;
  /** Whether an ElevenLabs key is available (stored or env). */
  hasElevenlabsKey: boolean;
}

/**
 * Resolve the effective voice mode:
 *   - `'local'`      → on-device (the keyless default). Always available.
 *   - `'openai'`     → cloud Whisper, only when its key is configured; otherwise
 *                      falls back to on-device (still keyless, never "off").
 *   - `'elevenlabs'` → cloud Scribe, same fallback rule.
 *   - `'auto'`       → the legacy "no on-device" sentinel: use a configured cloud
 *                      key (OpenAI first), else `'off'`. Kept for back-compat with
 *                      users who explicitly set "No Voice" before on-device shipped.
 */
export function voiceModeFromConfig(inputs: VoiceModeInputs): VoiceMode {
  const { preference, hasOpenaiKey, hasElevenlabsKey } = inputs;
  switch (preference) {
    case 'local':
      return 'local';
    case 'openai':
      // Explicit cloud choice uses its key when present; otherwise on-device
      // covers it (keyless), never silently disabling voice.
      return hasOpenaiKey ? 'openai' : 'local';
    case 'elevenlabs':
      return hasElevenlabsKey ? 'elevenlabs' : 'local';
    case 'auto':
      // Legacy "No Voice" sentinel: honor a configured cloud key, else off.
      if (hasOpenaiKey) return 'openai';
      if (hasElevenlabsKey) return 'elevenlabs';
      return 'off';
    default:
      return 'local';
  }
}

/** Whether the composer should render the 🎙 mic for a resolved voice mode. */
export function shouldShowMic(mode: VoiceMode): boolean {
  return mode !== 'off';
}
