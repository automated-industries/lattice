/**
 * Turning a recording into text — a capability, not a route.
 *
 * Dictation reached the speech service through one request handler, which meant
 * the only way to transcribe anything was to record it in a browser tab. A pile
 * of voice memos on disk, a call recording a job wants a transcript of, a batch
 * somebody wants to run overnight: none of those involve a browser, and none of
 * them could use the credential this machine already has configured.
 *
 * So the work lives here and takes bytes. What stayed in the request handler is
 * exactly what serving a browser needs: reading the upload off the socket and
 * writing the answer back.
 */
import type { Lattice } from '../lattice.js';
import { transcribe } from '../gui/ai/transcribe.js';
import { getVoiceCredential } from './ai-config.js';
import { modelError } from './model-errors.js';

/** A recording to transcribe, as bytes plus what kind of bytes they are. */
export interface RecordingInput {
  /** The encoded audio. */
  audio: Uint8Array;
  /**
   * The recording's media type, e.g. `audio/webm`, `audio/mp4`, `audio/wav`.
   * Defaults to `audio/webm` — what a browser composer records.
   */
  mimeType?: string | undefined;
}

/**
 * The filename a speech service is told to expect.
 *
 * Both services key their decoder off the extension rather than the media type,
 * so a container they cannot name is a failure at the far end with a message
 * that does not mention the file. Naming it here keeps that guess in one place.
 */
export function filenameForMimeType(mime: string): string {
  const ext =
    mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('wav') ? 'wav' : 'webm';
  return `audio.${ext}`;
}

/**
 * Transcribe a recording with whichever speech credential this machine has —
 * OpenAI Whisper when both are configured, otherwise ElevenLabs.
 *
 * @throws no_voice_key when no speech credential is available at all.
 * @throws invalid_request for empty audio, which is a caller mistake rather than
 * a service failure and must not be reported as one.
 * @throws transcription_failed when the service was reached and would not
 * transcribe — carrying the reason it gave, never a swallowed empty string.
 */
export async function transcribeRecording(
  db: Lattice | null,
  input: RecordingInput,
): Promise<string> {
  const voice = await getVoiceCredential(db);
  if (!voice) {
    throw modelError('no_voice_key', 'No voice key configured. Add an OpenAI or ElevenLabs key.');
  }
  if (input.audio.length === 0) throw modelError('invalid_request', 'empty audio');
  const mime = input.mimeType ?? 'audio/webm';
  try {
    return await transcribe({
      provider: voice.provider,
      apiKey: voice.apiKey,
      audio: new Blob([input.audio], { type: mime }),
      filename: filenameForMimeType(mime),
    });
  } catch (e) {
    throw modelError('transcription_failed', (e as Error).message);
  }
}
