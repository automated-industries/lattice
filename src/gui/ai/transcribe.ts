/**
 * Speech-to-text for the assistant composer. Two providers, selected by which
 * key the user has configured: OpenAI Whisper or ElevenLabs Scribe. Uses the
 * global fetch + FormData (Node 18+), so there's no SDK dependency.
 */

export type SttProvider = 'openai' | 'elevenlabs';

export interface TranscribeOptions {
  provider: SttProvider;
  apiKey: string;
  audio: Blob;
  /** File name hint (extension helps providers sniff the format). */
  filename?: string;
}

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_MODEL = 'whisper-1';
const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const ELEVENLABS_MODEL = 'scribe_v1';

/**
 * Transcribe an audio blob to text. Throws (loudly) on a non-OK response — the
 * caller surfaces the failure to the user rather than silently returning ''.
 */
export async function transcribe(opts: TranscribeOptions): Promise<string> {
  const filename = opts.filename ?? 'audio.webm';
  const form = new FormData();
  form.append('file', opts.audio, filename);

  let url: string;
  const headers: Record<string, string> = {};
  if (opts.provider === 'openai') {
    url = OPENAI_URL;
    form.append('model', OPENAI_MODEL);
    headers.Authorization = `Bearer ${opts.apiKey}`;
  } else {
    url = ELEVENLABS_URL;
    form.append('model_id', ELEVENLABS_MODEL);
    headers['xi-api-key'] = opts.apiKey;
  }

  const res = await fetch(url, { method: 'POST', headers, body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Transcription failed (${opts.provider} ${String(res.status)}): ${detail.slice(0, 300)}`,
    );
  }
  const body = (await res.json()) as { text?: unknown };
  if (typeof body.text !== 'string') {
    throw new Error(`Transcription response from ${opts.provider} had no text field`);
  }
  return body.text.trim();
}
