// Auto-composed segment of the GUI client script. Verbatim substring of the
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
//
// On-device voice dictation host glue. The heavy speech model runs in a SEPARATE
// module Web Worker (loaded out-of-band as `new Worker(url, {type:'module'})`),
// so this host code stays small ES5 — it only constructs the worker, decodes the
// recorded audio to mono 16 kHz PCM in the browser, and exchanges postMessage.
// Audio never leaves the machine; no API key, no server round-trip.
//
// Failures are surfaced LOUDLY (showToast) and the mic resets to idle — empty or
// failed transcripts never insert blank text into the composer.
export const voiceLocalJs = `    // ────────────────────────────────────────────────────────────
    // On-device voice dictation (in-browser speech model, keyless).
    // ────────────────────────────────────────────────────────────
    var _voiceWorker = null;       // lazily constructed on first mic use
    var _voiceWorkerReady = false; // worker has built the pipeline at least once
    var _voicePending = {};        // request id -> { resolve, reject }
    var _voiceReqSeq = 0;
    var LOCAL_VOICE_WORKER_URL = '/gui-assets/transcriber.worker.mjs';
    var LOCAL_VOICE_MODEL = 'Xenova/whisper-tiny.en';

    // Lazily create the worker. Returns the Worker or null when the environment
    // can't run it (no Worker support / construction throws — e.g. the fail-soft
    // build skipped the asset). A null return means "voice unavailable", surfaced
    // by the caller.
    function getVoiceWorker() {
      if (_voiceWorker) return _voiceWorker;
      if (typeof Worker === 'undefined') return null;
      try {
        _voiceWorker = new Worker(LOCAL_VOICE_WORKER_URL, { type: 'module' });
      } catch (_) {
        _voiceWorker = null;
        return null;
      }
      _voiceWorker.onmessage = function (e) {
        var m = e && e.data;
        if (!m || typeof m !== 'object') return;
        if (m.type === 'ready') { _voiceWorkerReady = true; return; }
        if (m.type === 'progress') { onVoiceProgress(m.file, m.progress); return; }
        if (m.type === 'result' && m.id && _voicePending[m.id]) {
          var okEntry = _voicePending[m.id]; delete _voicePending[m.id];
          okEntry.resolve(typeof m.text === 'string' ? m.text : '');
          return;
        }
        if (m.type === 'error') {
          var msg = m.message || 'voice worker error';
          if (m.id && _voicePending[m.id]) {
            var errEntry = _voicePending[m.id]; delete _voicePending[m.id];
            errEntry.reject(new Error(msg));
          } else {
            // An init/load failure with no request id — fail the in-flight
            // request(s) so the mic resets instead of hanging on "transcribing".
            failAllVoicePending(new Error(msg));
          }
        }
      };
      // A worker-level error (failed module load / WASM init) rejects everything
      // in flight and tears the worker down so the next use rebuilds it.
      _voiceWorker.onerror = function (ev) {
        var reason = (ev && ev.message) || 'voice worker failed to load';
        failAllVoicePending(new Error(reason));
        resetVoiceWorker();
      };
      // Kick off pipeline construction up front so the first transcribe is
      // faster and a load failure surfaces as a progress/error promptly.
      try { _voiceWorker.postMessage({ type: 'init', model: LOCAL_VOICE_MODEL, device: voicePreferredDevice() }); } catch (_) { /* posted on demand below */ }
      return _voiceWorker;
    }

    // Warm up the voice worker + model in the BACKGROUND on launch, so dictation is
    // ready by the time the user records and any first-run weight fetch happens
    // silently up front (never mid-recording, never with a visible "downloading"
    // state). Idempotent + best-effort — a failure just leaves the mic to lazy-init.
    function voicePreload() {
      try { getVoiceWorker(); } catch (_) { /* best-effort */ }
    }

    function voicePreferredDevice() {
      // WebGPU when the browser exposes it, else WASM. The worker downgrades to
      // wasm itself if the runtime can't honor webgpu, so this is just a hint.
      return (typeof navigator !== 'undefined' && navigator.gpu) ? 'webgpu' : 'wasm';
    }

    function failAllVoicePending(err) {
      var ids = Object.keys(_voicePending);
      for (var i = 0; i < ids.length; i++) {
        var entry = _voicePending[ids[i]];
        delete _voicePending[ids[i]];
        if (entry) entry.reject(err);
      }
    }

    function resetVoiceWorker() {
      if (_voiceWorker) { try { _voiceWorker.terminate(); } catch (_) { /* ignore */ } }
      _voiceWorker = null;
      _voiceWorkerReady = false;
    }

    // Model loading is SILENT — the user never sees a "downloading voice model"
    // state. The worker + model are warmed up in the background on launch (see
    // voicePreload), and the ORT runtime ships bundled, so by the time anyone
    // records, dictation is ready. We intentionally surface no loading progress in
    // the composer; if a first-run weight fetch is still in flight, the existing
    // "Transcribing…" placeholder covers it.
    function onVoiceProgress(_file, _progress) {
      /* intentionally silent — no visible voice-model loading UI */
    }

    // Decode a recorded audio blob to mono 16 kHz PCM (Float32Array), entirely in
    // the browser. Handles Safari's webkit-prefixed AudioContext/OfflineAudioContext.
    // Rejects loudly on a decode failure — never returns silent/empty PCM.
    function decodeToPcm(blob) {
      var AC = window.AudioContext || window.webkitAudioContext;
      var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!AC) return Promise.reject(new Error('This browser has no Web Audio support.'));
      return blob.arrayBuffer().then(function (buf) {
        var ctx = new AC();
        return new Promise(function (resolve, reject) {
          // decodeAudioData supports both the promise and callback forms; use
          // callbacks for the widest browser support (Safari).
          var done = false;
          try {
            var p = ctx.decodeAudioData(buf, function (decoded) {
              done = true; resolve(decoded);
            }, function (err) {
              if (done) return;
              reject(new Error('Could not decode the recording: ' + ((err && err.message) || 'unsupported audio')));
            });
            // The promise form (modern browsers) also resolves; guard the dupe.
            if (p && typeof p.then === 'function') { p.then(function (d) { if (!done) { done = true; resolve(d); } }).catch(function () { /* callback path handles it */ }); }
          } catch (e) {
            reject(new Error('Could not decode the recording: ' + (e.message || e)));
          }
        }).then(function (decoded) {
          try { ctx.close(); } catch (_) { /* ignore */ }
          return resampleDecodedTo16k(decoded, OAC);
        });
      });
    }

    // Downmix to mono + resample to 16 kHz. Prefer an OfflineAudioContext render
    // (playback-engine quality); fall back to a pure linear resample when it's
    // unavailable (older Safari).
    function resampleDecodedTo16k(decoded, OAC) {
      var TARGET = 16000;
      var srcRate = decoded.sampleRate || TARGET;
      var frames = decoded.length;
      var outLen = Math.ceil((frames / srcRate) * TARGET);
      if (outLen <= 0) return Promise.reject(new Error("Didn't catch anything — try again."));
      // Mono mix first (averaging channels).
      var mono = monoMix(decoded);
      if (srcRate === TARGET) return Promise.resolve(mono);
      if (OAC) {
        try {
          var offline = new OAC(1, outLen, TARGET);
          var src = offline.createBufferSource();
          var monoBuf = offline.createBuffer(1, mono.length, srcRate);
          monoBuf.getChannelData(0).set(mono);
          src.buffer = monoBuf;
          src.connect(offline.destination);
          src.start(0);
          return offline.startRendering().then(function (rendered) {
            return rendered.getChannelData(0);
          });
        } catch (_) { /* fall through to the pure resample */ }
      }
      return Promise.resolve(linearResample(mono, srcRate, TARGET, outLen));
    }

    function monoMix(decoded) {
      var ch = decoded.numberOfChannels || 1;
      if (ch === 1) return decoded.getChannelData(0);
      var len = decoded.length;
      var out = new Float32Array(len);
      for (var c = 0; c < ch; c++) {
        var data = decoded.getChannelData(c);
        for (var i = 0; i < len; i++) out[i] += data[i];
      }
      for (var j = 0; j < len; j++) out[j] /= ch;
      return out;
    }

    function linearResample(input, srcRate, target, outLen) {
      var out = new Float32Array(outLen);
      if (outLen === 0 || input.length === 0) return out;
      var ratio = input.length / outLen;
      var last = input.length - 1;
      for (var i = 0; i < outLen; i++) {
        var pos = i * ratio;
        var lo = Math.floor(pos);
        var hi = Math.min(lo + 1, last);
        var frac = pos - lo;
        out[i] = input[lo] * (1 - frac) + input[hi] * frac;
      }
      return out;
    }

    // Transcribe PCM on-device. Resolves the recognized text (never empty — the
    // worker rejects an empty transcript so the caller can show a clear message).
    function transcribeLocal(pcm) {
      var worker = getVoiceWorker();
      if (!worker) {
        return Promise.reject(new Error('On-device voice is unavailable in this browser.'));
      }
      var id = 'v' + (++_voiceReqSeq);
      return new Promise(function (resolve, reject) {
        _voicePending[id] = { resolve: resolve, reject: reject };
        try {
          // Transfer the PCM buffer (zero-copy) to the worker.
          worker.postMessage({ type: 'transcribe', id: id, pcm: pcm }, [pcm.buffer]);
        } catch (e) {
          delete _voicePending[id];
          reject(new Error('Could not start transcription: ' + (e.message || e)));
        }
      });
    }

    // Decode the recorded blob and transcribe it on-device, inserting the text
    // into the composer. Mirrors the cloud rec.onstop branch's UX (placeholder +
    // mic state) but does it all locally.
    function dictateLocal(blob, btn, input) {
      setMicState(btn, 'transcribing');
      decodeToPcm(blob)
        .then(function (pcm) { return transcribeLocal(pcm); })
        .then(function (text) {
          if (input && text) {
            input.value = (input.value ? input.value + ' ' : '') + text;
            input.dispatchEvent(new Event('input'));
            input.focus();
          }
        })
        .catch(function (e) {
          var m = (e && e.message) || 'Transcription failed';
          // A first-run with no network can't fetch the model — name it.
          if (/load|fetch|network|Failed to fetch/i.test(m)) {
            showToast('Voice model download failed — it needs the network the first time. ' + m);
          } else if (/empty transcript/i.test(m)) {
            showToast("Didn't catch anything — try again.");
          } else {
            showToast('Transcription failed: ' + m);
          }
        })
        .finally(function () { setMicState(btn, 'idle'); });
    }

`;
