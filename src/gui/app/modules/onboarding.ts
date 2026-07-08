// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const onboardingJs = `    // ────────────────────────────────────────────────────────────
    // Assistant chat composer — POST /api/chat, parse SSE, render
    // bubbles + tool pills into the same rail feed (interleaved with
    // activity events). Gated on a configured Claude token.
    // ────────────────────────────────────────────────────────────
    var chatHistory = [];
    var chatBusy = false;
    var COMPOSER_MAX_H = 160; // px — textarea auto-grow ceiling (then it scrolls)
    function railFeedEl() { return document.getElementById('rail-feed'); }
    function railEmptyGone() { var e = document.getElementById('rail-empty'); if (e) e.remove(); }
    var currentThreadId = null;
    var loadThreadSeq = 0; // discards a stale loadThread response when a newer load supersedes it
    // Active workspace id (set by renderWsSwitcher, which runs before the thread
    // list loads on both boot and switch). Keys the per-workspace "last open
    // conversation" so a refresh restores the EXACT thread the user was in — not
    // merely the newest, which during a long batch turn may be a different thread.
    var activeWsId = null;
    function chatThreadKey() { return 'lattice.chatThread.' + (activeWsId || '_default'); }
    function rememberThread(id) {
      try {
        if (id) window.localStorage.setItem(chatThreadKey(), id);
        else window.localStorage.removeItem(chatThreadKey());
      } catch (_) { /* storage unavailable — non-fatal */ }
    }
    function recallThread() {
      try { return window.localStorage.getItem(chatThreadKey()) || ''; } catch (_) { return ''; }
    }
    function clearChat() {
      chatHistory = [];
      var feedEl = railFeedEl();
      if (!feedEl) return;
      // The rail is conversation-scoped: clearing or switching a conversation
      // drops both its chat bubbles AND its activity cards (each conversation
      // replays its own data-change cards from the persisted per-turn events).
      // Reset the grouping anchors so a freshly loaded thread starts clean.
      var nodes = feedEl.querySelectorAll('.chat-msg, .feed-item');
      for (var i = 0; i < nodes.length; i++) nodes[i].remove();
      feedGroups = {};
      // Restore the empty hint only when the rail is now completely empty.
      if (!feedEl.firstElementChild) {
        feedEl.innerHTML = '<div class="rail-empty" id="rail-empty">No activity yet. Changes you make will appear here.</div>';
      }
    }
    // Drop the activity cards (e.g. when switching to another workspace, whose
    // events are a different set). Resets the grouping anchor too.
    function clearActivityFeed() {
      var feedEl = railFeedEl();
      if (!feedEl) return;
      var items = feedEl.querySelectorAll('.feed-item');
      for (var i = 0; i < items.length; i++) items[i].remove();
      feedGroups = {};
    }
    function newChat() {
      gaTrack('assistant_thread_new', {});
      currentThreadId = null;
      rememberThread(null);
      clearChat();
      var sel = document.getElementById('rail-threads');
      if (sel) sel.value = '';
    }
    // Populate the conversation dropdown from the ACTIVE workspace's threads
    // (chat_threads lives in the workspace DB, so switching workspaces changes
    // the list). When autoSelect is set and nothing is open yet, load the most
    // recent thread so a page refresh / workspace switch restores the
    // conversation instead of starting blank.
    function refreshThreadList(autoSelect) {
      var sel = document.getElementById('rail-threads'); if (!sel) return Promise.resolve();
      return fetchJson('/api/chat/threads').then(function (d) {
        var threads = (d && d.threads) || [];
        var opts = '<option value="">＋ New conversation</option>';
        threads.forEach(function (t) {
          opts += '<option value="' + escapeHtml(t.id) + '">' + escapeHtml(t.title || 'Chat') + '</option>';
        });
        sel.innerHTML = opts;
        if (autoSelect && !currentThreadId) {
          // Restore the exact conversation the user was last in (per workspace);
          // fall back to the most recent thread only when there's nothing stored
          // or the stored thread is gone.
          var remembered = recallThread();
          if (remembered && threads.some(function (t) { return t.id === remembered; })) {
            loadThread(remembered);
          } else if (threads.length > 0) {
            loadThread(threads[0].id); // threads are newest-first
          } else {
            sel.value = '';
          }
        } else {
          sel.value = currentThreadId || '';
        }
      }).catch(function () { /* ignore */ });
    }
    function loadThread(id) {
      var seq = ++loadThreadSeq;
      fetchJson('/api/chat/threads/' + encodeURIComponent(id) + '/messages').then(function (d) {
        if (seq !== loadThreadSeq) return; // a newer loadThread() superseded this one
        var msgs = (d && d.messages) || [];
        clearChat();
        currentThreadId = id;
        rememberThread(id);
        var sel = document.getElementById('rail-threads'); if (sel) sel.value = id;
        msgs.forEach(function (m) {
          if (m.role === 'user') { appendUserBubble(m.text); chatHistory.push({ role: 'user', text: m.text }); }
          else if (m.role === 'assistant') {
            // Rich replay: the saved per-turn structure (text + the data-change
            // activity cards it produced), matching the live stream. Falls back to
            // a plain text bubble for messages saved before turns were persisted.
            if (Array.isArray(m.turns) && m.turns.length > 0) {
              m.turns.forEach(function (t) { appendAssistantTurn(t, m.created_at, m.startedAt); });
            } else { var c = newAssistantBubble(); setBubbleText(c, m.text); }
            chatHistory.push({ role: 'assistant', text: m.text });
          }
        });
      }).catch(function (e) { showToast('Could not load conversation: ' + e.message, {}); });
    }
    function initThreadControls() {
      var sel = document.getElementById('rail-threads');
      var btn = document.getElementById('rail-newchat');
      if (btn) btn.addEventListener('click', newChat);
      if (sel) sel.addEventListener('change', function () { if (sel.value) loadThread(sel.value); else newChat(); });
      refreshThreadList(true); // restore the most recent conversation on load
    }
    function appendUserBubble(text) {
      railEmptyGone();
      var feedEl = railFeedEl(); if (!feedEl) return;
      var msg = document.createElement('div'); msg.className = 'chat-msg user';
      var b = document.createElement('div'); b.className = 'chat-bubble user'; b.textContent = text;
      msg.appendChild(b); feedEl.appendChild(msg); feedEl.scrollTop = feedEl.scrollHeight;
    }
    function newAssistantBubble() {
      railEmptyGone();
      var feedEl = railFeedEl();
      var msg = document.createElement('div'); msg.className = 'chat-msg assistant';
      var b = document.createElement('div'); b.className = 'chat-bubble assistant';
      // Show an animated typing indicator until the first text delta arrives.
      b.innerHTML = '<span class="chat-typing"><i></i><i></i><i></i></span>';
      b.setAttribute('data-typing', '1');
      msg.appendChild(b); feedEl.appendChild(msg); feedEl.scrollTop = feedEl.scrollHeight;
      return { bubble: b, msg: msg };
    }
    /** Set an assistant bubble's text, clearing the typing indicator. */
    // Turn [label](lattice://table/id) object references the assistant emits into
    // clickable pills that open the row (mode-aware, via openSearchHit). The
    // links are pulled out into placeholders BEFORE markdown rendering and the
    // pill HTML is swapped back in AFTER — so it's independent of mdToHtml's own
    // link handling and survives HTML-escaping. Labels/ids are re-escaped.
    function renderAssistantHtml(text) {
      var pills = [];
      // U+0002 sentinel survives mdToHtml's escape + inline passes untouched.
      // Use a unicode-escape string literal for insertion and a REGEX LITERAL for
      // the swap (one escaping level each) — a new RegExp('(\\d+)') here would be
      // double-collapsed by the template literal into a literal "d", silently
      // breaking the swap (the pill rendered as a bare index).
      var pre = String(text == null ? '' : text).replace(
        /\\[([^\\]]+)\\]\\(lattice:\\/\\/([a-zA-Z0-9_]+)\\/([^)\\s]+)\\)/g,
        function (_, label, table, id) {
          pills.push({ label: label, table: table, id: id });
          return '\\u0002' + (pills.length - 1) + '\\u0002';
        }
      );
      var html = mdToHtml(pre);
      return html.replace(/\\u0002([0-9]+)\\u0002/g, function (_, n) {
        var p = pills[Number(n)];
        return '<a class="chip chip-link lattice-ref" data-table="' + escapeHtml(p.table) +
          '" data-id="' + escapeHtml(p.id) + '" title="Open this ' + escapeHtml(p.table) + '">🔗 ' +
          escapeHtml(p.label) + '</a>';
      });
    }
    // One delegated click handler on the rail feed: a lattice-ref pill opens its
    // object through the same mode-aware navigator the activity feed uses.
    var _latticeRefWired = false;
    function ensureLatticeRefHandler() {
      if (_latticeRefWired) return;
      var feedEl = document.getElementById('rail-feed');
      if (!feedEl) return;
      feedEl.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('.lattice-ref') : null;
        if (!a) return;
        e.preventDefault();
        openSearchHit(a.getAttribute('data-table'), a.getAttribute('data-id'));
      });
      _latticeRefWired = true;
    }
    function setBubbleText(ctx, text) {
      if (!ctx || !ctx.bubble) return; // bubble may have been finalized/removed
      ctx.bubble.removeAttribute('data-typing');
      // Assistant turns are Markdown; render (input is HTML-escaped inside
      // mdToHtml first, so this is injection-safe) + linkify object references.
      ctx.bubble.innerHTML = renderAssistantHtml(text);
      ensureLatticeRefHandler();
    }
    /**
     * A turn ended still showing the typing indicator (no text streamed) — drop
     * the empty bubble. The turn's data-change activity cards live in the rail
     * feed independently (not inside the message), so they remain.
     */
    function finalizeBubble(ctx) {
      if (!ctx || !ctx.bubble || !ctx.bubble.getAttribute('data-typing')) return;
      if (ctx.msg) ctx.msg.remove();
    }
    /** Replay one persisted assistant turn: its text bubble + the data-change
     *  activity cards it produced (collapsed, per-turn). Reads aren't persisted
     *  as events, so a read-only turn with no text renders nothing. createdAt
     *  stamps the cards' relative time (events carry no ts of their own). */
    function appendAssistantTurn(turn, createdAt, startedAt) {
      var ctx = newAssistantBubble();
      if (turn.text) setBubbleText(ctx, turn.text);
      else finalizeBubble(ctx); // no text → drop the empty typing bubble
      var events = (turn.events || []).map(function (e) {
        return e.ts ? e : { op: e.op, table: e.table, rowId: e.rowId, summary: e.summary, source: e.source || 'ai', ts: createdAt };
      });
      // Task start for the duration timer: the persisted turn-start, else the
      // message time. Per-event ts (above) gives the run's finish.
      var startedMs = new Date(startedAt || createdAt || 0).getTime();
      renderTurnEventCards(railFeedEl(), events, startedMs);
    }
    function parseSse(buffer, onEvent) {
      var sep;
      while ((sep = buffer.indexOf('\\n\\n')) >= 0) {
        var frame = buffer.slice(0, sep); buffer = buffer.slice(sep + 2);
        var line = frame.split('\\n').find(function (l) { return l.indexOf('data:') === 0; });
        if (!line) continue;
        var json = line.slice(5).trim(); if (!json) continue;
        try { onEvent(JSON.parse(json)); } catch (_) { /* drop malformed */ }
      }
      return buffer;
    }
    function sendChat(text, attachedFiles) {
      var hasFiles = !!(attachedFiles && attachedFiles.length);
      if (chatBusy || (!text && !hasFiles)) return;
      // A files-only send (no message): give Gladys a directive so it still responds to
      // the attachment (the server's attached-files note tells it what was added).
      var effectiveText = text || (attachedFiles && attachedFiles.length > 1 ? 'Take a look at these files.' : 'Take a look at this file.');
      chatBusy = true;
      gaTrack('assistant_message', {}); // no message text — just the event

      // Open a fresh turn scope: this turn's activity cards group together (no
      // window expiry) and their timers measure from now.
      feedTurnId += 1;
      feedTurnStartMs = Date.now();
      feedTurnActive = true;
      appendUserBubble(effectiveText);
      var historyToSend = chatHistory.slice();
      chatHistory.push({ role: 'user', text: effectiveText });
      var input = document.getElementById('chat-input');
      var sendBtn = document.getElementById('chat-send');
      // Clear + collapse the textarea back to one line (reuse its auto-grow so
      // the reset matches the grow logic instead of leaving a bare 'auto').
      if (input) { input.value = ''; if (input._autoGrow) input._autoGrow(); else input.style.height = 'auto'; }
      if (sendBtn) sendBtn.disabled = true;
      var actx = null; var assembled = ''; var pendingOpen = null;
      // Private mode: when the composer checkbox is checked, items the assistant
      // adds on this turn stay private to the current user.
      var privEl = document.getElementById('chat-private');
      var privateMode = !!(privEl && privEl.checked);
      fetch('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // activeContext: the record on screen, so "this file"/"this row" resolves.
        body: JSON.stringify({ message: effectiveText, history: historyToSend, threadId: currentThreadId, privateMode: privateMode, activeContext: activeElement(), attachedFiles: (attachedFiles || []).slice(0, 25) })
      }).then(function (r) {
        if (!r.ok || !r.body) {
          return r.json().then(function (j) {
            // Pre-flight usage-limit block (server refused before streaming): show
            // the friendly limit copy with the ⏳ marker (matching the mid-stream
            // 'limit' SSE event) and refresh the app-wide banner, not a raw code.
            if (j && j.error === 'claude_limit') {
              finalizeBubble(actx);
              var lb = newAssistantBubble(); setBubbleText(lb, '⏳ ' + (j.message || 'Claude usage limit reached.'));
              if (typeof refreshLimitBlock === 'function') refreshLimitBlock();
              return undefined;
            }
            throw new Error((j && j.error) || ('HTTP ' + r.status));
          });
        }
        var tid = r.headers.get('x-thread-id'); if (tid) { currentThreadId = tid; rememberThread(tid); }
        var reader = r.body.getReader(); var dec = new TextDecoder(); var buf = '';
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) { anToolStatus(null); return; }
            buf += dec.decode(res.value, { stream: true });
            buf = parseSse(buf, function (ev) {
              if (ev.type === 'assistant_message_start') { finalizeBubble(actx); actx = newAssistantBubble(); assembled = ''; }
              else if (ev.type === 'text_delta' && actx) { anToolStatus(null); assembled += ev.delta; setBubbleText(actx, assembled); railFeedEl().scrollTop = railFeedEl().scrollHeight; }
              // A tool round's streamed text was pre-tool preamble ("Let me search\\u2026"),
              // not the answer — reap its bubble so only the final answer remains (the
              // server likewise drops it from the persisted message). Text now streams
              // live before tool use is known, so this is where a preamble round is undone.
              else if (ev.type === 'assistant_message_end' && ev.hadTools) { if (actx && actx.msg) actx.msg.remove(); actx = null; assembled = ''; }
              // tool_use / tool_result are not painted as inline pills — the
              // assistant's data changes stream in as activity cards over the feed
              // SSE (renderFeedItem). The only in-chat acknowledgement is ONE
              // transient plain-language status line ("Building your dashboard…"),
              // cleared as soon as the reply text starts.
              else if (ev.type === 'tool_use') { anToolStatus(ev.name); }
              // The model asked a clarification question (ask_user): render the
              // interactive card inline; the turn ends right after (so the status
              // line clears now), and the user's pick/free-form reply goes out as
              // the next chat message.
              else if (ev.type === 'question') { finalizeBubble(actx); actx = null; anToolStatus(null); if (typeof renderChatQuestion === 'function') renderChatQuestion(ev); }
              else if (ev.type === 'warn') { finalizeBubble(actx); var wb = newAssistantBubble(); setBubbleText(wb, '⚠ ' + ev.message); actx = null; }
              else if (ev.type === 'limit') { finalizeBubble(actx); var lb = newAssistantBubble(); setBubbleText(lb, '⏳ ' + ev.message); actx = null; if (typeof refreshLimitBlock === 'function') refreshLimitBlock(); }
              else if (ev.type === 'error') { if (!actx) actx = newAssistantBubble(); setBubbleText(actx, (assembled ? assembled + '\\n' : '') + '⚠ ' + ev.message); }
              // A tool (e.g. create_artifact) asked the GUI to open the row it
              // created. Remember it and navigate once the turn finishes so the
              // main viewer isn't yanked mid-reply.
              else if (ev.type === 'open' && ev.table && ev.id) { pendingOpen = { table: String(ev.table), id: String(ev.id) }; }
            });
            return pump();
          });
        }
        return pump();
      }).then(function () {
        finalizeBubble(actx); // drop a trailing empty "typing…" bubble
        if (assembled) chatHistory.push({ role: 'assistant', text: assembled });
        refreshThreadList();
        // Open a just-created artifact in the main viewer (markdown renders via
        // renderFilePreview). Drop the cached rows first so the detail fetch is
        // fresh, then navigate (mode-aware).
        if (pendingOpen) { invalidate(pendingOpen.table); openSearchHit(pendingOpen.table, pendingOpen.id); }
      }).catch(function (e) {
        finalizeBubble(actx);
        var c = newAssistantBubble(); setBubbleText(c, '⚠ ' + e.message);
        // If the model backend is no longer connected (credentials gone/invalid), send
        // the user back to onboarding to reconnect. Keyed off config.connected so a
        // transient hiccup or a usage-limit does NOT eject them mid-conversation.
        if (typeof reonboardOnAiFailure === 'function') {
          fetchJson('/api/assistant/config').then(function (cfg) {
            if (cfg && cfg.connected === false) reonboardOnAiFailure();
          }).catch(function () { /* ignore */ });
        }
      }).finally(function () {
        chatBusy = false;
        // Close the turn scope: later activity starts fresh cards (the next turn,
        // or manual edits via the rolling window).
        feedTurnActive = false;
        var sb = document.getElementById('chat-send'); if (sb) sb.disabled = false;
        var inp = document.getElementById('chat-input'); if (inp) inp.focus();
      });
    }
    var recState = 'idle';
    var mediaRecorder = null;
    var audioChunks = [];
    function setMicState(btn, state) {
      recState = state;
      // Mirror the recording lifecycle onto the composer. While recording or
      // transcribing, the textarea is read-only (it shows a status placeholder,
      // not editable text) and the Send button is disabled — you can't send a
      // half-captured voice note. Returning to idle restores both, then the
      // transcript is dropped in (see rec.onstop).
      var inp = document.getElementById('chat-input');
      var snd = document.getElementById('chat-send');
      var busy = state === 'recording' || state === 'transcribing';
      if (inp) {
        if (busy) {
          if (inp._restorePlaceholder == null) {
            inp._restorePlaceholder = inp.getAttribute('placeholder') || '';
          }
          inp.setAttribute('readonly', 'readonly');
          inp.classList.add('recording');
          inp.setAttribute('placeholder', state === 'recording' ? 'Listening…' : 'Transcribing…');
        } else {
          inp.removeAttribute('readonly');
          inp.classList.remove('recording');
          if (inp._restorePlaceholder != null) {
            inp.setAttribute('placeholder', inp._restorePlaceholder);
            inp._restorePlaceholder = null;
          }
        }
      }
      if (snd) snd.disabled = busy;
      if (!btn) return;
      btn.classList.remove('recording', 'transcribing');
      if (state === 'recording') { btn.classList.add('recording'); btn.textContent = '⏹'; btn.title = 'Stop recording'; btn.disabled = false; }
      else if (state === 'transcribing') { btn.classList.add('transcribing'); btn.textContent = '…'; btn.title = 'Transcribing…'; btn.disabled = true; }
      else { btn.textContent = '🎙'; btn.title = 'Record voice'; btn.disabled = false; }
    }
    // Fade + tooltip the mic button when no microphone is available, and make a
    // click a no-op (so it never pops a "Microphone unavailable" dialog). Kept
    // NON-disabled on purpose: browsers suppress the title tooltip on a disabled
    // button, and the ask is a hover tooltip explaining why it's unusable.
    function markMicUnavailable(btn) {
      if (!btn) return;
      btn.classList.add('composer-mic-unavailable');
      btn.title = 'No microphone available';
      btn.setAttribute('aria-disabled', 'true');
    }
    function markMicAvailable(btn) {
      if (!btn) return;
      btn.classList.remove('composer-mic-unavailable');
      btn.title = 'Record voice';
      btn.removeAttribute('aria-disabled');
    }
    // The user's chosen input device (used only when the default doesn't work).
    var selectedMicId = null;
    try { selectedMicId = (window.localStorage && localStorage.getItem('lattice.micDeviceId')) || null; } catch (e) {}
    function micConstraint() { return selectedMicId ? { deviceId: { exact: selectedMicId } } : true; }
    // Default the mic to ENABLED — assume the system microphone works. Browsers
    // and the desktop webview are unreliable about enumerateDevices BEFORE mic
    // permission is granted (often an empty list, or audioinput entries with no
    // label), so a missing entry does NOT mean "no mic". Only fade the button when
    // we positively know there ARE devices yet none is an audio input; genuine
    // failures are surfaced at record time, with a device-picker fallback.
    function refreshMicAvailability(btn) {
      if (!btn) return;
      markMicAvailable(btn);
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      navigator.mediaDevices.enumerateDevices().then(function (devices) {
        var inputs = devices.filter(function (d) { return d.kind === 'audioinput'; });
        if (devices.length > 0 && inputs.length === 0) markMicUnavailable(btn);
        else markMicAvailable(btn);
      }).catch(function () { /* enumeration blocked — leave enabled */ });
    }
    // When the default mic fails, let the user pick a specific input + retry.
    function offerMicPicker(btn, input) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        markMicUnavailable(btn); showToast('No microphone available', {}); return;
      }
      navigator.mediaDevices.enumerateDevices().then(function (devices) {
        var inputs = devices.filter(function (d) { return d.kind === 'audioinput'; });
        if (!inputs.length) { markMicUnavailable(btn); showToast('No microphone available', {}); return; }
        var host = btn.parentNode; if (!host) return;
        var old = host.querySelector('.mic-picker'); if (old) old.remove();
        var sel = document.createElement('select');
        sel.className = 'mic-picker';
        sel.title = 'Choose a microphone';
        sel.innerHTML = '<option value="">Choose a microphone…</option>' +
          inputs.map(function (d, i) {
            return '<option value="' + escapeHtml(d.deviceId) + '">' + escapeHtml(d.label || ('Microphone ' + (i + 1))) + '</option>';
          }).join('');
        sel.addEventListener('change', function () {
          if (!sel.value) return;
          selectedMicId = sel.value;
          try { if (window.localStorage) localStorage.setItem('lattice.micDeviceId', selectedMicId); } catch (e) {}
          sel.remove(); markMicAvailable(btn); startRecording(btn, input);
        });
        host.insertBefore(sel, btn.nextSibling);
      }).catch(function () { markMicUnavailable(btn); showToast('No microphone available', {}); });
    }
    function startRecording(btn, input) {
      if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
        showToast('Voice recording is not supported in this browser.'); return;
      }
      navigator.mediaDevices.getUserMedia({ audio: micConstraint() }).then(function (stream) {
        var rec = new MediaRecorder(stream);
        audioChunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) audioChunks.push(e.data); };
        rec.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          var blob = new Blob(audioChunks, { type: rec.mimeType || 'audio/webm' });
          // The GUI ALWAYS dictates on-device (keyless; the audio never leaves the
          // machine). The cloud transcribe route stays available to API callers for
          // backward compatibility, but the GUI never uses it.
          dictateLocal(blob, btn, input);
        };
        rec.start();
        mediaRecorder = rec;
        setMicState(btn, 'recording');
      }).catch(function (e) {
        // Degrade gracefully instead of popping an error dialog. A genuinely
        // missing device fades the button + tooltips it; permission/other errors
        // surface as a toast (the device is there, so don't mark it unavailable).
        var name = (e && e.name) || '';
        if (/NotFound|DevicesNotFound|OverConstrained/i.test(name)) {
          // The default (or previously-chosen) device didn't work — drop a stale
          // choice and let the user pick another input, then retry.
          if (selectedMicId) { selectedMicId = null; try { if (window.localStorage) localStorage.removeItem('lattice.micDeviceId'); } catch (e2) {} }
          offerMicPicker(btn, input);
        } else if (/NotAllowed|Permission|Security/i.test(name)) {
          showToast('Microphone permission denied — allow it in your browser settings.', {});
        } else {
          showToast('Microphone unavailable: ' + ((e && e.message) || name), {});
        }
      });
    }
    function toggleRecording(btn, input) {
      if (recState === 'recording' && mediaRecorder) { mediaRecorder.stop(); mediaRecorder = null; }
      else if (recState === 'idle') { startRecording(btn, input); }
    }

`;
