// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const onboardingJs = `    // ────────────────────────────────────────────────────────────
    // Assistant chat composer — POST /api/chat, parse SSE, render
    // bubbles + tool pills into the same rail feed (interleaved with
    // activity events). Gated on a configured Claude token.
    // ────────────────────────────────────────────────────────────
    var chatHistory = [];
    var chatBusy = false;
    // The consent question currently open in this conversation — a server-composed
    // destructive confirmation, set by renderChatQuestion when its event carries an
    // id. Send state, so it lives here: EVERY send reads and clears it, attaching it
    // with the clicked option's index (or -1, which is never an option the user was
    // shown) so a typed reply or a files-only send explicitly declines rather than
    // leaving a recorded question live for a later message to answer by accident.
    // Each item in the queue below carries its own copy for the same reason.
    var qOpenConsentId = null;
    // Follow-ups typed while a turn streams are queued (FIFO) and sent when the turn
    // finishes — never dropped. Each item: { text, files, names, claimed }. They render
    // in a tray above the composer (renderQueueTray), where they can be reordered out of
    // or removed; they are NOT placeholder bubbles in the conversation, which read as
    // messages that had already been sent.
    var chatQueue = [];
    // An item pulled out of the queue by "send now": it has been CLAIMED, so the ordinary
    // drain can never also fire it, and it is delivered by the next flush — after the
    // running turn has been stopped. Exactly one item can be in this state at a time.
    var forcePushItem = null;
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
      // Discard any follow-ups queued for the conversation we're leaving, so they
      // never leak into a different thread — including one already claimed by a
      // "send now" whose stop had not come back yet.
      chatQueue = [];
      forcePushItem = null;
      renderQueueTray();
      updateComposerAction();
      var feedEl = railFeedEl();
      if (!feedEl) return;
      // The rail is conversation-scoped: clearing or switching a conversation
      // drops its chat bubbles, plus anything a previous version of the client
      // left behind in the rail, so a freshly loaded thread starts clean.
      var nodes = feedEl.querySelectorAll('.chat-msg, .feed-item, .ingest-progress');
      for (var i = 0; i < nodes.length; i++) nodes[i].remove();
      // Restore the empty hint only when the rail is now completely empty.
      if (!feedEl.firstElementChild) {
        feedEl.innerHTML = '<div class="rail-empty" id="rail-empty">No activity yet. Changes you make will appear here.</div>';
      }
    }
    // Drop anything left in the rail that is not conversation (e.g. when switching
    // to another workspace, whose activity is a different set). Clear any
    // in-progress ingest task too: it belongs to the workspace we're leaving and
    // must not bleed into the new one (its feed events go to the old workspace).
    function clearActivityFeed() {
      var feedEl = railFeedEl();
      if (!feedEl) return;
      var items = feedEl.querySelectorAll('.feed-item');
      for (var i = 0; i < items.length; i++) items[i].remove();
      clearIngestProgress();
    }
    function newChat() {
      gaTrack('assistant_thread_new', {});
      currentThreadId = null;
      rememberThread(null);
      clearChat();
      // Drop any bound/buffered turns and re-enable the composer — the explicit escape
      // hatch if a turn was left streaming (e.g. the server died mid-run so its 'done'
      // never arrived). An off-screen turn from another thread still completes server-side.
      chatTurns = {};
      chatEventBuffer = {};
      releaseComposer();
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
        msgs.forEach(function (m, mi) {
          if (m.role === 'user') { appendUserBubble(m.text, m.files, m.created_at); chatHistory.push({ role: 'user', text: m.text, files: m.files }); }
          else if (m.role === 'assistant') {
            // A turn still running when the page reloaded (the newest message, status
            // 'streaming'/'pending'). Distinguish FRESH from STALE: a fresh row is almost
            // certainly still running on the same server process, so rebind it to the live
            // chat-progress bus (its remaining events keep painting) and lock the composer.
            // A STALE row (older than the freshness window) was orphaned — the process that
            // owned it died (crash / relaunch / redeploy / teardown timeout) and can never
            // finish it — so DON'T bind it (a bound-but-dead turn would wedge the composer
            // with a permanent typing bubble); render its checkpointed text as a final,
            // interrupted reply and leave the composer free.
            var streaming = (m.status === 'streaming' || m.status === 'pending') && !!m.id && mi === msgs.length - 1;
            if (streaming && chatTurnFresh(m.startedAt)) {
              var rctx = newAssistantBubble(m.startedAt || m.created_at);
              if (m.text) setBubbleText(rctx, m.text);
              bindChatTurn({ messageId: m.id, threadId: id, actx: rctx, assembled: m.text || '', pendingOpen: null, done: false });
              chatBusy = true; feedTurnActive = true;
              updateComposerAction();
            } else if (streaming) {
              // Orphaned in-flight turn: show what was saved (or a soft interrupted note)
              // as final — no bind, no composer lock, no lingering turn.
              var ictx = newAssistantBubble(m.startedAt || m.created_at);
              setBubbleText(ictx, m.text || '\\u26a0 This reply was interrupted and did not finish.');
            } else if (m.status === 'stopped') {
              // The user stopped this reply. Terminal, and NOT a failure: replay the
              // partial text that survived and mark plainly where it was cut off.
              var sctx = newAssistantBubble(m.startedAt || m.created_at);
              if (m.text) setBubbleText(sctx, m.text);
              else finalizeBubble(sctx);
              var stopNote = document.createElement('div');
              stopNote.className = 'chat-stopped';
              stopNote.textContent = '⏹ You stopped this reply.';
              var sfeed = railFeedEl(); if (sfeed) sfeed.appendChild(stopNote);
            } else if (Array.isArray(m.turns) && m.turns.length > 0) {
              // Rich replay: the saved per-turn structure (text + the data-change activity
              // cards it produced), matching the live stream.
              m.turns.forEach(function (t) { appendAssistantTurn(t, m.created_at, m.startedAt); });
            } else {
              // Plain text bubble — messages saved before turns were persisted.
              var c = newAssistantBubble(m.startedAt || m.created_at); setBubbleText(c, m.text);
            }
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
    // Append a relative-time label as a SIBLING of the bubble (so setBubbleText's
    // innerHTML rewrite of the bubble never clobbers it). stampRelTime writes both the
    // label AND the instant it came from, so the shared ticker can keep it current —
    // without the stamp the label froze at whatever it said when the node was made, and
    // a live send (which passes no timestamp) read "0s ago" for the rest of the session.
    function stampBubble(msgEl, iso) {
      if (!msgEl) return;
      var t = document.createElement('span'); t.className = 'chat-time';
      stampRelTime(t, iso || new Date().toISOString());
      msgEl.appendChild(t);
    }
    // opts.pending marks the bubble as not-yet-delivered (an attachment is still
    // ingesting). Returns the message element so the caller can settle it.
    function appendUserBubble(text, fileNames, createdAt, opts) {
      railEmptyGone();
      var feedEl = railFeedEl(); if (!feedEl) return null;
      var msg = document.createElement('div'); msg.className = 'chat-msg user';
      if (opts && opts.pending) msg.classList.add('pending');
      var hasFiles = !!(fileNames && fileNames.length);
      // With files, stack the bubble + file chips vertically (right-aligned); a
      // text-only message keeps the plain single-bubble layout unchanged.
      var host = msg;
      if (hasFiles) { host = document.createElement('div'); host.className = 'chat-user-stack'; msg.appendChild(host); }
      // Suppress the text bubble when it's just the attached file names: a files-only send
      // persists the joined names as its message text, and the chips already show them — so
      // on reload we'd otherwise render the names twice (a bubble AND the chips).
      var showText = !!text && !(hasFiles && text === fileNames.join(', '));
      if (showText) {
        var b = document.createElement('div'); b.className = 'chat-bubble user'; b.textContent = text;
        host.appendChild(b);
      }
      // Attached files render as persistent chips IN the sent message. They used to
      // vanish on a text+file send (the bubble showed only the text), so the user
      // couldn't see what they'd attached; now the attachment stays visible in the
      // feed and re-renders from thread history.
      if (hasFiles) {
        var tray = document.createElement('div'); tray.className = 'chat-msg-files';
        for (var i = 0; i < fileNames.length; i++) {
          var chip = document.createElement('span'); chip.className = 'chat-msg-file';
          var ic = document.createElement('span'); ic.className = 'chat-msg-file-ic'; ic.textContent = '📄';
          var nm = document.createElement('span'); nm.className = 'chat-msg-file-name';
          nm.textContent = fileNames[i] || 'file';
          chip.appendChild(ic); chip.appendChild(nm); tray.appendChild(chip);
        }
        host.appendChild(tray);
      }
      stampBubble(msg, createdAt);
      feedEl.appendChild(msg); feedEl.scrollTop = feedEl.scrollHeight;
      return msg;
    }
    // The attachment landed and the turn is on its way: drop the in-flight marking.
    function markBubbleSent(msg) {
      if (!msg) return;
      msg.classList.remove('pending', 'failed');
      var note = msg.querySelector('.chat-send-error');
      if (note) note.remove();
    }
    // The send never happened. Say so ON the message — a bubble sitting in the feed
    // for something that was never sent is worse than no bubble at all — and offer
    // the retry inline. The composer still holds the text + files, so retry re-runs
    // the same submit.
    function markBubbleFailed(msg, detail, onRetry) {
      if (!msg) return;
      msg.classList.remove('pending');
      msg.classList.add('failed');
      var old = msg.querySelector('.chat-send-error');
      if (old) old.remove();
      var note = document.createElement('div');
      note.className = 'chat-send-error';
      var label = document.createElement('span');
      label.textContent = detail || 'Not sent.';
      note.appendChild(label);
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'chat-retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', function () {
        msg.remove();
        if (typeof onRetry === 'function') onRetry();
      });
      note.appendChild(retry);
      msg.appendChild(note);
    }
    function newAssistantBubble(createdAt) {
      railEmptyGone();
      var feedEl = railFeedEl();
      var msg = document.createElement('div'); msg.className = 'chat-msg assistant';
      var b = document.createElement('div'); b.className = 'chat-bubble assistant';
      // Show an animated typing indicator until the first text delta arrives.
      b.innerHTML = '<span class="chat-typing"><i></i><i></i><i></i></span>';
      b.setAttribute('data-typing', '1');
      msg.appendChild(b); stampBubble(msg, createdAt); feedEl.appendChild(msg); feedEl.scrollTop = feedEl.scrollHeight;
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
          // The id may carry a "?f=<column>" source-field query — the record view
          // highlights that field on arrival so the click lands on the data itself.
          var parts = String(id).split('?');
          var field = '';
          if (parts[1] && parts[1].indexOf('f=') === 0) {
            try { field = decodeURIComponent(parts[1].slice(2)); } catch (_e) { field = ''; }
          }
          pills.push({ label: label, table: table, id: parts[0], field: field });
          return '\\u0002' + (pills.length - 1) + '\\u0002';
        }
      );
      // Linkify plain http(s) markdown links (e.g. the out-of-credit notice's
      // top-up link) — mdToHtml has no [text](url) support, so without this the
      // link would render as literal markdown. Scheme is restricted to http/https
      // and both label + href are escaped. Same sentinel trick as the pills.
      var links = [];
      pre = pre.replace(
        /\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g,
        function (_, label, url) {
          links.push({ label: label, url: url });
          return '\\u0003' + (links.length - 1) + '\\u0003';
        }
      );
      var html = mdToHtml(pre);
      html = html.replace(/\\u0002([0-9]+)\\u0002/g, function (_, n) {
        var p = pills[Number(n)];
        // Inline word-link, not a boxed pill: the referenced word itself is the
        // link, flowing with the sentence.
        return '<a class="lattice-ref" data-table="' + escapeHtml(p.table) +
          '" data-id="' + escapeHtml(p.id) + '" data-field="' + escapeHtml(p.field) +
          '" title="Open this ' + escapeHtml(p.table) + '">' +
          escapeHtml(p.label) + '</a>';
      });
      return html.replace(/\\u0003([0-9]+)\\u0003/g, function (_, n) {
        var l = links[Number(n)];
        return '<a href="' + escapeHtml(l.url) + '" target="_blank" rel="noopener noreferrer">' +
          escapeHtml(l.label) + '</a>';
      });
    }
    // One delegated click handler on the rail feed: a lattice-ref word-link
    // navigates straight to its record in the workspace. The source field (when
    // the link carries one) is stashed so the record view can highlight it.
    var _latticeRefWired = false;
    function ensureLatticeRefHandler() {
      if (_latticeRefWired) return;
      var feedEl = document.getElementById('rail-feed');
      if (!feedEl) return;
      feedEl.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('.lattice-ref') : null;
        if (!a) return;
        e.preventDefault();
        var tbl = a.getAttribute('data-table');
        var rid = a.getAttribute('data-id');
        // Stash the whole answer's text too: when the target renders as a text
        // document (a file preview), the passage the answer drew from can be
        // found and highlighted — the quote may sit in a different paragraph
        // than the link itself (e.g. a Sources line), so the full bubble is the
        // right haystack source.
        var snippet = '';
        var bubble = a.closest ? a.closest('.chat-bubble') : null;
        var pe = bubble || a.parentElement;
        if (pe && pe.textContent) snippet = pe.textContent.slice(0, 2500);
        try {
          sessionStorage.setItem('latticeTraceHl', JSON.stringify({
            table: tbl, id: rid, field: a.getAttribute('data-field') || '',
            snippet: snippet, ts: Date.now()
          }));
        } catch (_e) { /* storage unavailable — navigation still works */ }
        openSearchHit(tbl, rid);
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
     * the empty bubble. Data changes are reported in the activity menu, not in
     * the conversation, so there is nothing else to leave behind.
     */
    function finalizeBubble(ctx) {
      if (!ctx || !ctx.bubble || !ctx.bubble.getAttribute('data-typing')) return;
      if (ctx.msg) ctx.msg.remove();
    }
    /** Replay one persisted assistant turn: its text bubble, and nothing else.
     *  Background work — including the data changes a turn made — is reported in
     *  the activity menu while it happens; the conversation carries only what you
     *  sent and what the assistant answered. Any events array on an older
     *  persisted row is ignored, so threads written before that change replay
     *  cleanly as text. A read-only turn with no text renders nothing. */
    function appendAssistantTurn(turn, createdAt, startedAt) {
      var ctx = newAssistantBubble(startedAt || createdAt);
      if (turn.text) setBubbleText(ctx, turn.text);
      else finalizeBubble(ctx); // no text → drop the empty typing bubble
    }
    // ── Async chat transport ──────────────────────────────────────
    // POST /api/chat ACKs 202 {threadId, messageId} and the turn runs as a background
    // job on the server; its events arrive over the /api/stream WebSocket as
    // 'chat-progress' frames { threadId, messageId, event }. chatTurns maps a streaming
    // messageId -> that turn's bubble/render state so each event lands on the right turn
    // (including one recovered after a page reload). A frame can arrive before the 202
    // resolves (or before recovery binds), so unclaimed frames are buffered per messageId
    // and replayed when the turn registers.
    var chatTurns = {};
    var chatEventBuffer = {};
    // A recovered in-flight row is only treated as LIVE (rebound + composer locked) when
    // it started within this window; older than it, the owning process is presumed dead
    // (crash / relaunch / redeploy / teardown timeout) and the row is rendered as an
    // interrupted final reply instead of a permanent typing bubble. Comfortably longer
    // than any real turn so a slow-but-live turn is never misclassified.
    var CHAT_TURN_STALE_MS = 300000; // 5 min
    function chatTurnFresh(startedAt) {
      if (!startedAt) return false; // no start stamp → can't prove it's live → treat as stale
      var t = new Date(startedAt).getTime();
      if (!(t > 0)) return false;
      return (Date.now() - t) < CHAT_TURN_STALE_MS;
    }
    // ── Composer action button ──────────────────────────────────────────────
    // ONE button, four derived states, so it is never a dead grey rectangle while a
    // reply streams: Send (idle), Queue (busy + something typed), Stop (busy + nothing
    // typed), disabled Send (idle + nothing typed). The state is DERIVED, so every
    // input that can change it just calls updateComposerAction() and is done.
    //
    // Registered by id rather than hard-coded, because the dock is not the only
    // composer in the app — a second one hands off to the assistant the same way and
    // can join the machine by registering its button (and naming its textarea with
    // data-composer-input) instead of duplicating any of this.
    var composerActionIds = ['chat-send'];
    function registerComposerAction(id) {
      if (!id || composerActionIds.indexOf(id) >= 0) return;
      composerActionIds.push(id);
      updateComposerAction();
    }
    function composerInputFor(btn) {
      var id = (btn && btn.getAttribute && btn.getAttribute('data-composer-input')) || 'chat-input';
      return document.getElementById(id);
    }
    function composerHasContent(btn) {
      var inp = composerInputFor(btn);
      if (inp && inp.value && inp.value.trim()) return true;
      // Staged attachments are content too — a files-only send is a real send. They
      // belong to the dock composer's tray only.
      if (btn && btn.id === 'chat-send' && typeof stagedFiles !== 'undefined' && stagedFiles && stagedFiles.length) return true;
      return false;
    }
    function updateComposerAction() {
      // A voice note being recorded/transcribed owns the composer for its duration;
      // half-captured audio must not be sendable, queueable, or a Stop target.
      var dictating = recState === 'recording' || recState === 'transcribing';
      for (var i = 0; i < composerActionIds.length; i++) {
        var btn = document.getElementById(composerActionIds[i]);
        if (!btn) continue;
        var content = composerHasContent(btn);
        btn.classList.remove('is-stop', 'is-queue');
        var ingesting = btn.id === 'chat-send' && typeof stagingBusy !== 'undefined' && !!stagingBusy;
        if (dictating || ingesting) {
          // Nothing can be submitted until the audio or the attachment has landed, so
          // the button says Send and is genuinely disabled — rather than looking live
          // and doing nothing when clicked.
          btn.setAttribute('data-action', 'send');
          btn.textContent = 'Send';
          btn.title = ingesting ? 'Adding your files…' : 'Send';
          btn.disabled = true;
        } else if (stopPending() && !content) {
          // A Stop the user already pressed that has not been delivered yet: the turn
          // is still being identified (see stopActiveTurn). It goes out on its own, so
          // the button reports that instead of looking armed for a press that would
          // add nothing.
          btn.setAttribute('data-action', 'stopping');
          btn.classList.add('is-stop');
          btn.textContent = 'Stopping…';
          btn.title = 'Stopping this reply';
          btn.disabled = true;
        } else if (chatBusy && !content) {
          btn.setAttribute('data-action', 'stop');
          btn.classList.add('is-stop');
          btn.textContent = 'Stop';
          btn.title = 'Stop this reply';
          btn.disabled = false;
        } else if (chatBusy) {
          btn.setAttribute('data-action', 'queue');
          btn.classList.add('is-queue');
          btn.textContent = 'Queue';
          btn.title = 'Send this as soon as the current reply finishes';
          btn.disabled = false;
        } else {
          btn.setAttribute('data-action', 'send');
          btn.textContent = 'Send';
          btn.title = 'Send';
          btn.disabled = !content;
        }
      }
    }
    // Re-enable the composer once no turn is streaming (a turn recovered on reload keeps
    // it disabled until that turn finishes). Reflects busy state off the live turn count.
    function releaseComposer() {
      var streaming = Object.keys(chatTurns).length > 0;
      chatBusy = streaming;
      feedTurnActive = streaming;
      updateComposerAction();
      if (!streaming) { var inp = document.getElementById('chat-input'); if (inp) inp.focus(); }
      // Turn finished (also fires on a pre-flight refusal / network reject): drain
      // the next queued follow-up, if any.
      if (!streaming) flushChatQueue();
    }
    // ── Stopping a turn ─────────────────────────────────────────────────────
    // The turn does NOT run inside the POST that started it: that request acks 202 and
    // the work continues server-side as a background job streaming over the socket. So
    // abandoning a fetch here would stop nothing — the job would keep calling the model
    // and keep writing to the workspace. Stopping has to be a request of its own.
    //
    // That ack is also what NAMES the turn, and the button becomes a Stop the moment
    // the send leaves — so there is a window where the turn is already running but no
    // messageId has come back to address a stop to. A press there must not evaporate
    // (it is exactly when an alarmed user reaches for Stop), so the intent is
    // REMEMBERED and delivered the instant the ack binds the turn:
    //   pendingSendCount — /api/chat POSTs that have not resolved yet
    //   stopRequested    — a Stop pressed while only such a send existed
    //   stopWaiters      — the callers awaiting that stop; they settle on its REAL
    //                      outcome, never on a promise that stopped nothing.
    var pendingSendCount = 0;
    var stopRequested = false;
    var stopWaiters = [];
    // True while a requested stop has not been delivered/settled — the composer button
    // shows this state rather than a live-looking Stop.
    function stopPending() { return stopRequested || stopWaiters.length > 0; }
    function settleStopWaiters(err) {
      var waiters = stopWaiters;
      stopWaiters = [];
      updateComposerAction();
      for (var i = 0; i < waiters.length; i++) {
        if (err) waiters[i].reject(err); else waiters[i].resolve();
      }
    }
    // The ack named the turn: deliver the Stop the user already pressed.
    function deliverRememberedStop() {
      if (!stopRequested) return;
      stopRequested = false;
      stopActiveTurn().then(
        function () { settleStopWaiters(null); },
        function (e) { settleStopWaiters(e); }
      );
    }
    // A send POST has resolved — with an ack, a refusal, or a network error. If a Stop
    // is STILL remembered at that point, no turn was ever opened for it to name (the
    // send was refused, or its turn had already finished), so there is genuinely
    // nothing running: clear the intent rather than leaving the button on 'Stopping…'
    // forever, and settle the callers.
    function sendSettled() {
      if (pendingSendCount > 0) pendingSendCount -= 1;
      if (!stopRequested) { updateComposerAction(); return; }
      if (pendingSendCount > 0 || Object.keys(chatTurns).length) return;
      stopRequested = false;
      settleStopWaiters(null);
    }
    function stopActiveTurn() {
      var ids = Object.keys(chatTurns);
      if (!ids.length) {
        // Nothing bound yet. If a send is still in flight, its turn IS running on the
        // server and its ack is on the way — remember the request instead of handing
        // back a resolved promise for a stop that never happened.
        if (pendingSendCount > 0) {
          stopRequested = true;
          updateComposerAction();
          return new Promise(function (resolve, reject) {
            stopWaiters.push({ resolve: resolve, reject: reject });
          });
        }
        return Promise.resolve();
      }
      var reqs = [];
      for (var i = 0; i < ids.length; i++) {
        (function (mid) {
          reqs.push(
            fetch('/api/chat/messages/' + encodeURIComponent(mid) + '/stop', { method: 'POST' })
              .then(function (r) {
                return r.json().then(
                  function (j) { return { ok: r.ok, body: j || {} }; },
                  function () { return { ok: r.ok, body: {} }; }
                );
              })
              .then(function (out) {
                if (!out.ok) throw new Error(out.body.error || 'Could not stop the reply.');
                // stopped:false means the reply had already finished — nothing to
                // report, the turn's own 'done' releases the composer.
                if (out.body.stopped) noteTurnStopped(mid);
              })
          );
        })(ids[i]);
      }
      return Promise.all(reqs).then(function () { return undefined; }, function (e) {
        // A stop that did not take is exactly the case the user must hear about: the
        // reply is still running and still spending. Surface it and re-throw so the
        // caller does not act as though the turn had ended.
        showToast('Could not stop the reply: ' + e.message, {});
        throw e;
      });
    }
    // Mark a stopped turn in the conversation and release locally. The server settles
    // the persisted row and publishes its own terminal frame; finalizeChatTurn is
    // idempotent, so whichever arrives first wins and the other is a no-op.
    function noteTurnStopped(messageId) {
      var turn = chatTurns[messageId];
      if (!turn) return;
      if (turn.threadId === currentThreadId) {
        finalizeBubble(turn.actx);
        var feedEl = railFeedEl();
        if (feedEl) {
          var note = document.createElement('div');
          note.className = 'chat-stopped';
          // Honest about the boundary: a tool call already in flight finishes.
          note.textContent = '⏹ Stopped. Anything already running finished; nothing new was started.';
          feedEl.appendChild(note);
          feedEl.scrollTop = feedEl.scrollHeight;
        }
      }
      finalizeChatTurn(turn);
    }
    // Reconcile bound (streaming) turns after the /api/stream WebSocket reconnects. The bus
    // has NO replay buffer, so any event — including the terminal 'done' — published while
    // the socket was down is lost, which would otherwise leave the turn bound forever and
    // the composer stuck disabled. On reconnect we re-fetch each bound turn's persisted row:
    // a settled row (done/error) is finalized locally; a still-streaming FRESH row has its
    // partial text refreshed (live frames resume over the new socket); a still-streaming
    // STALE row is treated as interrupted and released.
    function resyncChatTurns() {
      var ids = Object.keys(chatTurns);
      if (!ids.length) return;
      // Group the bound turns by their thread so each thread is fetched once.
      var byThread = {};
      ids.forEach(function (mid) {
        var turn = chatTurns[mid];
        if (turn && turn.threadId) (byThread[turn.threadId] = byThread[turn.threadId] || []).push(mid);
      });
      Object.keys(byThread).forEach(function (tid) {
        fetchJson('/api/chat/threads/' + encodeURIComponent(tid) + '/messages').then(function (d) {
          var msgs = (d && d.messages) || [];
          byThread[tid].forEach(function (mid) {
            var turn = chatTurns[mid];
            if (!turn) return;
            var row = null;
            for (var i = 0; i < msgs.length; i++) { if (msgs[i].id === mid) { row = msgs[i]; break; } }
            if (!row) return; // row not found (deleted?) — leave the turn; a full reload recovers
            // 'stopped' is terminal alongside 'done'/'error': the user ended it, so the
            // turn must be released rather than left bound waiting for frames that will
            // never come.
            var settled = row.status !== 'streaming' && row.status !== 'pending';
            var visible = turn.threadId === currentThreadId;
            if (settled) {
              // The turn finished (its 'done' may have been lost during the disconnect):
              // render the final text and release.
              if (visible && row.text) { if (!turn.actx) turn.actx = newAssistantBubble(); setBubbleText(turn.actx, row.text); }
              turn.assembled = row.text || turn.assembled;
              if (visible && row.status === 'stopped') {
                var rsNote = document.createElement('div');
                rsNote.className = 'chat-stopped';
                rsNote.textContent = '⏹ You stopped this reply.';
                var rsFeed = railFeedEl(); if (rsFeed) rsFeed.appendChild(rsNote);
              }
              finalizeChatTurn(turn);
            } else if (chatTurnFresh(row.startedAt)) {
              // Still legitimately running — refresh the partial (recovering deltas lost in
              // the gap); live frames continue over the reconnected socket.
              if (visible && row.text) { if (!turn.actx) turn.actx = newAssistantBubble(); setBubbleText(turn.actx, row.text); turn.assembled = row.text; }
            } else {
              // Still 'streaming' but stale — the owning process is gone; treat as interrupted.
              if (visible && row.text && turn.actx) setBubbleText(turn.actx, row.text);
              finalizeChatTurn(turn);
            }
          });
        }).catch(function () { /* best-effort; a full reload still recovers */ });
      });
    }
    // Apply one streamed event to its turn. Painting is gated on the turn's thread being
    // the one on screen — an off-screen turn (the user switched threads mid-run) still
    // completes + persists server-side and replays when they switch back.
    // A metered/managed proxy answers "out of credit" with a 402 whose body carries
    // an insufficient_credit error. The SDK surfaces it as a raw "402 {json}" string;
    // turn it into a friendly markdown message (with a top-up link pulled from the
    // body) instead. Returns null for any other error.
    function insufficientCreditInfo(msg) {
      var s = String(msg == null ? '' : msg);
      if (s.indexOf('insufficient_credit') < 0) return null;
      var m = s.match(/https?:\\/\\/[^\\s"'}]+/);
      var url = m ? m[0] : '';
      return 'Out of Lattice tokens. ' +
        (url ? '[Add more tokens](' + url + ')' : 'Add more tokens') +
        ' to keep the assistant running.';
    }
    function applyChatEvent(turn, ev) {
      if (!turn || !ev) return;
      var visible = turn.threadId === currentThreadId;
      if (ev.type === 'ack') {
        // Fast contextual acknowledgement shown before the real answer. Render it as its
        // own transient bubble and finalize any waiting typing bubble — the answer streams
        // into a fresh bubble via the next assistant_message_start. Not persisted, so it is
        // never replayed on reload. (For an inline answer the server streams the answer
        // itself via text_delta, so the ack path isn't used there.)
        if (visible) { finalizeBubble(turn.actx); turn.actx = null; anToolStatus(null); var ackb = newAssistantBubble(); setBubbleText(ackb, ev.message); }
      } else if (ev.type === 'assistant_message_start') {
        if (visible) { finalizeBubble(turn.actx); turn.actx = newAssistantBubble(); anStatusThinking(); }
        turn.assembled = '';
      } else if (ev.type === 'text_delta') {
        turn.assembled += ev.delta;
        if (visible) { anToolStatus(null); if (!turn.actx) turn.actx = newAssistantBubble(); setBubbleText(turn.actx, turn.assembled); var fe = railFeedEl(); if (fe) fe.scrollTop = fe.scrollHeight; }
      // The answer round re-emitted with deterministic trace links — swap the
      // bubble's full text so retrieved-record references become clickable.
      } else if (ev.type === 'text_final') {
        turn.assembled = ev.text;
        if (visible && turn.actx) setBubbleText(turn.actx, turn.assembled);
      // A tool round's streamed text (e.g. "I see — I need a different approach…") is real
      // narration the user should keep, so FINALIZE this round's bubble instead of reaping
      // it — the next round opens a fresh bubble via assistant_message_start / the next
      // text_delta. finalizeBubble drops an empty (no-text) round's typing bubble on its own,
      // so a bare tool call with no narration leaves nothing behind.
      } else if (ev.type === 'assistant_message_end' && ev.hadTools) {
        // dropText: this round's preamble exactly repeated the previous kept one —
        // remove its just-streamed bubble instead of finalizing it, so a multi-step
        // turn doesn't show the same intent several times over.
        if (visible) {
          if (ev.dropText && turn.actx && turn.actx.msg && turn.actx.msg.remove) turn.actx.msg.remove();
          else finalizeBubble(turn.actx);
        }
        turn.actx = null; turn.assembled = '';
      // tool_use / tool_result are not painted as inline pills — the assistant's data
      // changes stream in as activity cards over the feed. The only in-chat acknowledgement
      // is ONE transient status line ("Building your dashboard…"), cleared when text starts.
      } else if (ev.type === 'tool_use') {
        if (visible) anToolStatus(ev.name);
      // The model asked a clarification question (ask_user): render the interactive card
      // inline; the turn ends right after, and the user's pick goes out as the next message.
      } else if (ev.type === 'question') {
        if (visible) { finalizeBubble(turn.actx); anToolStatus(null); if (typeof renderChatQuestion === 'function') renderChatQuestion(ev); }
        turn.actx = null;
      } else if (ev.type === 'warn') {
        if (visible) { finalizeBubble(turn.actx); var wb = newAssistantBubble(); setBubbleText(wb, '⚠ ' + ev.message); }
        turn.actx = null;
      } else if (ev.type === 'limit') {
        if (visible) { finalizeBubble(turn.actx); var lb = newAssistantBubble(); setBubbleText(lb, '⏳ ' + ev.message); if (typeof refreshLimitBlock === 'function') refreshLimitBlock(); if (typeof refreshAuthWarningBlock === 'function') refreshAuthWarningBlock(); }
        turn.actx = null;
      } else if (ev.type === 'error') {
        if (visible) {
          if (!turn.actx) turn.actx = newAssistantBubble();
          var ic = insufficientCreditInfo(ev.message);
          if (ic) { turn.actx.bubble.classList.add('notice-error'); setBubbleText(turn.actx, ic); }
          else { setBubbleText(turn.actx, (turn.assembled ? turn.assembled + '\\n' : '') + '⚠ ' + ev.message); }
        }
        turn.reonboard = true;
      // A tool (e.g. create_artifact) asked the GUI to open the row it created; navigate
      // once the turn finishes so the main viewer isn't yanked mid-reply.
      } else if (ev.type === 'open' && ev.table && ev.id) {
        turn.pendingOpen = { table: String(ev.table), id: String(ev.id) };
      } else if (ev.type === 'done') {
        finalizeChatTurn(turn);
      }
    }
    function finalizeChatTurn(turn) {
      if (!turn || turn.done) return;
      turn.done = true;
      var visible = turn.threadId === currentThreadId;
      if (visible) { finalizeBubble(turn.actx); anToolStatus(null); if (turn.assembled) chatHistory.push({ role: 'assistant', text: turn.assembled }); }
      delete chatTurns[turn.messageId];
      delete chatEventBuffer[turn.messageId];
      releaseComposer();
      refreshThreadList();
      if (visible && turn.pendingOpen) { invalidate(turn.pendingOpen.table); openSearchHit(turn.pendingOpen.table, turn.pendingOpen.id); }
      // If the model backend is no longer connected (creds gone/invalid), route back to
      // onboarding — keyed off config.connected so a transient hiccup or usage-limit does
      // NOT eject the user mid-conversation.
      if (turn.reonboard && typeof reonboardOnAiFailure === 'function') {
        fetchJson('/api/assistant/config').then(function (cfg) {
          if (cfg && cfg.connected === false) reonboardOnAiFailure();
        }).catch(function () { /* ignore */ });
      }
    }
    // Register a turn's render state under its messageId and replay any buffered events.
    function bindChatTurn(turn) {
      chatTurns[turn.messageId] = turn;
      var buf = chatEventBuffer[turn.messageId];
      if (buf) { delete chatEventBuffer[turn.messageId]; for (var i = 0; i < buf.length; i++) applyChatEvent(turn, buf[i]); }
    }
    // Dispatched from the /api/stream WebSocket (dispatchStreamMessage 'chat-progress').
    function onChatProgress(msg) {
      if (!msg || !msg.messageId || !msg.event) return;
      var turn = chatTurns[msg.messageId];
      if (turn) { applyChatEvent(turn, msg.event); return; }
      // Not yet bound (our 202 hasn't resolved, or recovery hasn't run). Buffer from the
      // start so the binding replays the whole turn; bounded so a never-claimed stream
      // can't grow without limit, and GC'd shortly after 'done' if nothing ever binds it.
      var b = (chatEventBuffer[msg.messageId] = chatEventBuffer[msg.messageId] || []);
      if (b.length < 4000) b.push(msg.event);
      if (msg.event.type === 'done') {
        setTimeout(function () { if (!chatTurns[msg.messageId]) delete chatEventBuffer[msg.messageId]; }, 5000);
      }
    }
    // ── Queue tray ──────────────────────────────────────────────────────────
    // Queued follow-ups get their OWN surface directly above the composer — the same
    // shape as the staged-files tray — instead of ghost bubbles in the conversation.
    // A bubble in the feed reads as a message that was sent; these have not been.
    function queueTrayHost() {
      var host = document.getElementById('chat-queue-host');
      if (host) return host;
      var composer = document.getElementById('rail-composer');
      if (!composer || !composer.parentNode) return null;
      host = document.createElement('div');
      host.className = 'chat-queue-host';
      host.id = 'chat-queue-host';
      composer.parentNode.insertBefore(host, composer);
      return host;
    }
    function queueItemLabel(item) {
      if (item.text) return item.text.length > 90 ? item.text.slice(0, 90) + '…' : item.text;
      if (item.names && item.names.length) return item.names.join(', ');
      return 'Attached files';
    }
    function renderQueueTray() {
      var host = queueTrayHost(); if (!host) return;
      host.innerHTML = '';
      if (!chatQueue.length) return;
      var tray = document.createElement('div');
      tray.className = 'chat-queue-tray';
      tray.id = 'chat-queue-tray';
      var head = document.createElement('div');
      head.className = 'chat-queue-head';
      head.textContent = chatQueue.length === 1
        ? 'Queued — sends when this reply finishes'
        : chatQueue.length + ' queued — sent in order when this reply finishes';
      tray.appendChild(head);
      var list = document.createElement('ul');
      list.className = 'chat-queue-list';
      for (var i = 0; i < chatQueue.length; i++) {
        (function (idx) {
          var li = document.createElement('li');
          li.className = 'chat-queue-item';
          var label = document.createElement('span');
          label.className = 'chat-queue-text';
          label.textContent = queueItemLabel(chatQueue[idx]);
          li.appendChild(label);
          var push = document.createElement('button');
          push.type = 'button';
          push.className = 'chat-queue-push';
          push.title = 'Stop the current reply and send this now';
          push.setAttribute('aria-label', 'Send now');
          push.textContent = '⏭';
          push.addEventListener('click', function () { forcePushQueued(idx); });
          li.appendChild(push);
          var rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'chat-queue-x';
          rm.title = 'Remove';
          rm.setAttribute('aria-label', 'Remove');
          rm.textContent = '✕';
          rm.addEventListener('click', function () { removeQueued(idx); });
          li.appendChild(rm);
          list.appendChild(li);
        })(i);
      }
      tray.appendChild(list);
      host.appendChild(tray);
    }
    function removeQueued(idx) {
      var item = chatQueue[idx];
      if (!item || item.claimed) return; // already on its way out via "send now"
      chatQueue.splice(idx, 1);
      renderQueueTray();
      updateComposerAction();
    }
    // "Send now": stop the running turn, then send THIS item ahead of the rest. The
    // item is CLAIMED and pulled out of the queue first, and held in forcePushItem
    // which flushChatQueue consumes before anything else — so the ordinary
    // drain-on-turn-done can never send it a second time.
    function forcePushQueued(idx) {
      var item = chatQueue[idx];
      if (!item || item.claimed || forcePushItem) return;
      item.claimed = true;
      chatQueue.splice(idx, 1);
      forcePushItem = item;
      renderQueueTray();
      updateComposerAction();
      stopActiveTurn().then(function () {
        // If the turn's release already ran, this is a no-op; otherwise it delivers.
        flushChatQueue();
      }, function () {
        // The turn could not be stopped, so it is still running and this message must
        // NOT be sent into the middle of it. Put it back exactly where it was — the
        // failure itself was already surfaced by stopActiveTurn.
        if (forcePushItem !== item) return;
        forcePushItem = null;
        item.claimed = false;
        chatQueue.splice(idx, 0, item);
        renderQueueTray();
        updateComposerAction();
      });
    }
    // Queue a follow-up sent while a turn is streaming: clear the composer (like a real
    // send) and remember it to flush on turn-done. The answered-question id + option
    // index are carried on the item: an answer to an inline question waits on chatBusy
    // and can end up here, and dropping the id would silently turn a recorded yes into
    // an unattributed message (it degrades closed — the server just re-asks — but it
    // reads to the user like a button that did nothing).
    function enqueueChat(text, attachedFiles, questionId, optionIndex) {
      var fileNames = (attachedFiles || []).map(function (f) { return f && f.name ? f.name : 'file'; });
      clearComposerInput(!!fileNames.length);
      chatQueue.push({
        text: text, files: attachedFiles, names: fileNames, claimed: false,
        questionId: questionId || null,
        optionIndex: typeof optionIndex === 'number' ? optionIndex : -1
      });
      renderQueueTray();
      updateComposerAction();
    }
    // Send the next follow-up once the composer is free — a force-pushed item first,
    // then the FIFO. Each flushed send keeps sendChat's own inline error handling, so a
    // failed queued send surfaces loudly rather than dropping.
    function flushChatQueue() {
      if (chatBusy) return;
      if (forcePushItem) {
        var pushed = forcePushItem;
        forcePushItem = null; // consumed here and nowhere else — never twice
        sendChat(pushed.text, pushed.files, { questionId: pushed.questionId, optionIndex: pushed.optionIndex });
        return;
      }
      if (!chatQueue.length) return;
      var item = chatQueue.shift();
      renderQueueTray();
      updateComposerAction();
      sendChat(item.text, item.files, { questionId: item.questionId, optionIndex: item.optionIndex });
    }
    // Empty the composer: the textarea (collapsed back to one line via its own
    // auto-grow, so the reset matches the grow logic) and — only when this send is
    // actually carrying them — the staged files, in the same tick. A send that carries
    // NO attachment must leave the tray alone: a suggested-prompt click elsewhere in the
    // app routes through here too, and it must not quietly discard files the user staged.
    function clearComposerInput(alsoStaged) {
      var input = document.getElementById('chat-input');
      if (input) { input.value = ''; if (input._autoGrow) input._autoGrow(); else input.style.height = 'auto'; }
      if (alsoStaged && typeof clearStaging === 'function') clearStaging();
      updateComposerAction();
    }
    /**
     * Commit the composer for a submission. Runs SYNCHRONOUSLY, before any await, so
     * there is never a window where the message has left the box but nothing shows it:
     * the bubble appears, the box and the tray empty, and the button takes its busy
     * state — all in one tick. The bubble is marked pending until the send actually
     * goes out (an attachment still has to be ingested first), and can be marked failed
     * if it never does. Returns the bubble element.
     */
    function commitComposer(text, fileNames) {
      var msg = appendUserBubble(text, fileNames, null, { pending: true });
      clearComposerInput(!!(fileNames && fileNames.length));
      return msg;
    }
    function sendChat(text, attachedFiles, opts) {
      opts = opts || {};
      var hasFiles = !!(attachedFiles && attachedFiles.length);
      if (!text && !hasFiles) return;
      // EVERY send settles whatever confirmation is open in this conversation. When the
      // caller supplied an option index, this send is the user's actual answer to it.
      // Otherwise the index is -1 — never one of the options they were shown — so a
      // typed reply or a files-only send explicitly DECLINES rather than leaving a
      // recorded question live for some later message to answer by accident. Read and
      // cleared here, before the busy branch, so the queued path carries it too.
      var consentId = opts.questionId || qOpenConsentId || null;
      var consentIndex = typeof opts.optionIndex === 'number' ? opts.optionIndex : -1;
      qOpenConsentId = null;
      // Streaming: don't drop the message — queue it and drain on turn-done. A bubble
      // committed before the ingest is REMOVED here: the message is not sent, so its one
      // surface is the queue tray. Leaving both would show it twice, once as if sent.
      if (chatBusy) {
        if (opts.bubble && opts.bubble.remove) opts.bubble.remove();
        enqueueChat(text, attachedFiles, consentId, consentIndex);
        return;
      }
      var fileNames = (attachedFiles || []).map(function (f) { return f && f.name ? f.name : 'file'; });
      chatBusy = true;
      gaTrack('assistant_message', {}); // no message text — just the event

      // Open a fresh turn scope: this turn's activity cards group together (no
      // window expiry) and their timers measure from now.
      feedTurnId += 1;
      feedTurnStartMs = Date.now();
      feedTurnActive = true;
      // The bubble may already be on screen — a send with attachments commits the
      // composer before the ingest starts, and hands that bubble in here. Otherwise
      // commit now (still synchronously, before the request goes out).
      var bubble = opts.bubble || commitComposer(text, fileNames);
      markBubbleSent(bubble);
      var historyToSend = chatHistory.slice();
      // The user's OWN words go into the history, empty on a files-only send. Putting
      // the file NAMES here instead made the filename the message: the server then
      // classified a bare filename as ambiguous and asked what to do with it, while the
      // file itself was sitting right there. The attachment travels as structured data.
      chatHistory.push({ role: 'user', text: text || '', files: fileNames });
      updateComposerAction();
      // Private mode: when the composer checkbox is checked, items the assistant
      // adds on this turn stay private to the current user.
      var privEl = document.getElementById('chat-private');
      var privateMode = !!(privEl && privEl.checked);
      // Counted from here until the response settles: until it does, this turn cannot
      // be named, and a Stop pressed meanwhile is held rather than dropped.
      pendingSendCount += 1;
      fetch('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // activeContext: the record on screen, so "this file"/"this row" resolves.
        // questionId/optionIndex: the confirmation this send settles, and which option
        // was clicked. The server decides what the index means; the client never does.
        body: JSON.stringify({ message: text || '', history: historyToSend, threadId: currentThreadId, privateMode: privateMode, activeContext: activeElement(), attachedFiles: (attachedFiles || []).slice(0, 25), ingestInProgress: (typeof ingestOrImportActive === 'function' && ingestOrImportActive()), questionId: consentId, optionIndex: consentIndex })
      }).then(function (r) {
        var tid = r.headers.get('x-thread-id');
        if (r.status === 202) {
          // Accepted: the turn now runs server-side and streams over the WebSocket.
          return r.json().then(function (j) {
            var threadId = tid || (j && j.threadId);
            if (threadId) { currentThreadId = threadId; rememberThread(threadId); }
            var mid = j && j.messageId;
            if (!mid) throw new Error('malformed chat ack');
            // Bind this turn's render state so 'chat-progress' frames (some may already be
            // buffered from before this resolved) paint the reply. The composer stays busy
            // until the turn's 'done' event fires (finalizeChatTurn).
            bindChatTurn({ messageId: mid, threadId: threadId || currentThreadId, actx: null, assembled: '', pendingOpen: null, done: false });
            // A Stop pressed while this send was in flight had no message to name;
            // now it does, so it goes out immediately.
            deliverRememberedStop();
            return undefined;
          });
        }
        // Non-202: the server refused before starting a turn (no background job will run,
        // so release the composer here). A pre-flight usage-limit shows the friendly copy
        // with the ⏳ marker; anything else surfaces the error inline.
        return r.json().then(function (j) {
          if (j && j.error === 'claude_limit') {
            var lb = newAssistantBubble(); setBubbleText(lb, '⏳ ' + (j.message || 'Claude usage limit reached.'));
            if (typeof refreshLimitBlock === 'function') refreshLimitBlock();
            if (typeof refreshAuthWarningBlock === 'function') refreshAuthWarningBlock();
          } else {
            var c = newAssistantBubble(); setBubbleText(c, '⚠ ' + ((j && j.error) || ('HTTP ' + r.status)));
          }
          releaseComposer();
          return undefined;
        });
      }).catch(function (e) {
        var c = newAssistantBubble(); setBubbleText(c, '⚠ ' + e.message);
        releaseComposer();
        // If the model backend is no longer connected (credentials gone/invalid), send the
        // user back to onboarding. Keyed off config.connected so a transient hiccup or a
        // usage-limit does NOT eject them mid-conversation.
        if (typeof reonboardOnAiFailure === 'function') {
          fetchJson('/api/assistant/config').then(function (cfg) {
            if (cfg && cfg.connected === false) reonboardOnAiFailure();
          }).catch(function () { /* ignore */ });
        }
      }).then(function () {
        // Runs on every outcome (the catch above resolves): this send is no longer
        // in flight, so a Stop still waiting on it has to be settled one way or the
        // other rather than left pending forever.
        sendSettled();
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
      // The action button's state is derived, and dictation is one of its inputs —
      // recState is already set above, so this reflects the new state.
      updateComposerAction();
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
