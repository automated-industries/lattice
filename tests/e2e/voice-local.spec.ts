import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

/** Enable the composer (store a test Claude key + reload) and return the input. */
async function enableComposer(page: import('@playwright/test').Page, url: string) {
  await page.request.put(`${url}/api/assistant/key`, {
    data: { kind: 'anthropic', key: 'sk-ant-e2e-test-key' },
  });
  await page.goto(url);
  await expect(page.locator('#chat-input')).toBeVisible();
  return page.locator('#chat-input');
}

test('on-device mic renders with NO voice key configured (the keyless default)', async ({
  page,
}) => {
  await enableComposer(page, gui.url);
  // The core requirement: with only a Claude key (no OpenAI/ElevenLabs voice key),
  // the 🎙 mic is present because on-device dictation is the keyless default.
  await expect(page.locator('#chat-mic')).toBeVisible();
});

test('On-device persists as the selected voice provider in settings', async ({ page }) => {
  await page.goto(gui.url + '#/settings/user-config');
  const host = page.locator('#assistant-host');
  await expect(host.locator('#asst-stt')).toBeVisible();
  // Default selection is the on-device option, and it shows no key field (a note
  // instead). The cloud providers + Off are still selectable.
  await expect(host.locator('#asst-stt')).toHaveValue('local');
  await expect(host.locator('#asst-openai-key')).toHaveCount(0);
  await expect(host.locator('#asst-elevenlabs-key')).toHaveCount(0);
  await expect(host.getByText('Runs in your browser')).toBeVisible();
});

test('a recorded clip is transcribed on-device and the text lands in #chat-input', async ({
  page,
}) => {
  // STUB the browser audio capture + the speech Worker so CI never downloads
  // model weights or runs real WASM inference. We replace getUserMedia /
  // MediaRecorder / AudioContext / OfflineAudioContext / Worker with fakes that
  // drive the REAL host glue path end-to-end and return a canned transcript.
  await page.addInitScript(() => {
    const CANNED = 'hello from on device';

    // A fake module Worker that speaks the transcriber protocol: ack `init` with
    // `ready`, answer `transcribe` with a canned `result` echoing the request id.
    class FakeWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      postMessage(msg: { type?: string; id?: string }) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'init') {
          setTimeout(() => {
            this.onmessage?.({ data: { type: 'ready' } });
          }, 0);
        } else if (msg.type === 'transcribe') {
          setTimeout(() => {
            this.onmessage?.({ data: { type: 'result', id: msg.id, text: CANNED } });
          }, 0);
        }
      }
      terminate() {
        /* no-op */
      }
    }
    // Only intercept the transcriber worker URL; leave any other Worker intact.
    const RealWorker = window.Worker;
    // @ts-expect-error - override the global with a routing shim
    window.Worker = function (url: string, opts?: unknown) {
      if (typeof url === 'string' && url.includes('transcriber.worker')) {
        return new FakeWorker();
      }
      const Ctor = RealWorker as unknown as new (u: string, o?: unknown) => Worker;
      return new Ctor(url, opts);
    } as unknown as typeof Worker;

    // Fake mic stream + recorder. `.stop()` fires `onstop`, which runs the real
    // dictateLocal → decodeToPcm → transcribeLocal path.
    // @ts-expect-error - test stub
    navigator.mediaDevices = navigator.mediaDevices || {};
    // @ts-expect-error - test stub
    navigator.mediaDevices.getUserMedia = () =>
      Promise.resolve({ getTracks: () => [{ stop() {} }] } as MediaStream);
    // @ts-expect-error - test stub
    navigator.mediaDevices.enumerateDevices = () =>
      Promise.resolve([{ kind: 'audioinput' }] as MediaDeviceInfo[]);

    // @ts-expect-error - minimal MediaRecorder stub
    window.MediaRecorder = class {
      onstop: (() => void) | null = null;
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      mimeType = 'audio/webm';
      start() {
        if (this.ondataavailable) {
          this.ondataavailable({ data: new Blob([new Uint8Array([1, 2, 3])]) });
        }
      }
      stop() {
        if (this.onstop) this.onstop();
      }
    };

    // Fake AudioContext.decodeAudioData → a 1-channel 16 kHz buffer so the
    // resample step is a pass-through and no real decode happens.
    const fakeBuffer = {
      numberOfChannels: 1,
      length: 1600,
      sampleRate: 16000,
      getChannelData: () => new Float32Array(1600),
    };
    // @ts-expect-error - test stub
    window.AudioContext = class {
      decodeAudioData(_buf: ArrayBuffer, ok: (b: unknown) => void) {
        ok(fakeBuffer);
        return Promise.resolve(fakeBuffer);
      }
      close() {
        /* no-op */
      }
    };
    // Force the pure linear-resample fallback (no OfflineAudioContext needed).
    // @ts-expect-error - test stub
    window.OfflineAudioContext = undefined;
    // @ts-expect-error - test stub
    window.webkitOfflineAudioContext = undefined;
  });

  const input = await enableComposer(page, gui.url);
  const mic = page.locator('#chat-mic');
  await expect(mic).toBeVisible();

  // Click to start recording, then click again to stop → transcribe.
  await mic.click();
  await mic.click();

  // The canned transcript lands in the composer.
  await expect(input).toHaveValue(/hello from on device/, { timeout: 5000 });
});
