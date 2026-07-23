// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const onboardingJs = `    // ────────────────────────────────────────────────────────────
    // Assistant chat composer — POST /api/chat, parse SSE, render
    // bubbles + tool pills into the same rail feed (interleaved with
    // activity events). Gated on a configured Claude token.
    // ────────────────────────────────────────────────────────────
    var chatHistory = [];
    var chatBusy = false;
    // Follow-ups typed while a turn streams are queued (FIFO) and sent when the
    // turn finishes — never dropped. Each item: { text, files, node } where node
    // is the dimmed "queued" placeholder bubble.
    var chatQueue = [];
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
      // never leak into a different thread.
      chatQueue = [];
      var feedEl = railFeedEl();
      if (!feedEl) return;
      // The rail is conversation-scoped: clearing or switching a conversation
      // drops both its chat bubbles AND its activity cards (each conversation
      // replays its own data-change cards from the persisted per-turn events).
      // Also clear any in-progress ingest bar (orphaned by the conversation switch).
      // Reset the grouping anchors so a freshly loaded thread starts clean.
      var nodes = feedEl.querySelectorAll('.chat-msg, .feed-item, .ingest-progress');
      for (var i = 0; i < nodes.length; i++) nodes[i].remove();
      feedGroups = {};
      // Restore the empty hint only when the rail is now completely empty.
      if (!feedEl.firstElementChild) {
        feedEl.innerHTML = '<div class="rail-empty" id="rail-empty">No activity yet. Changes you make will appear here.</div>';
      }
    }
    // Drop the activity cards (e.g. when switching to another workspace, whose
    // events are a different set). Resets the grouping anchor too. Clear any
    // in-progress ingest bar: it belongs to the workspace we're leaving and must
    // not bleed into the new one (its feed events go to the old workspace's feed).
    function clearActivityFeed() {
      var feedEl = railFeedEl();
      if (!feedEl) return;
      var items = feedEl.querySelectorAll('.feed-item');
      for (var i = 0; i < items.length; i++) items[i].remove();
      feedGroups = {};
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
          if (m.role === 'user') { appendUserBubble(m.text, m.files); chatHistory.push({ role: 'user', text: m.text, files: m.files }); }
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
              var rctx = newAssistantBubble();
              if (m.text) setBubbleText(rctx, m.text);
              bindChatTurn({ messageId: m.id, threadId: id, actx: rctx, assembled: m.text || '', pendingOpen: null, done: false });
              chatBusy = true; feedTurnActive = true;
              var sbtn = document.getElementById('chat-send'); if (sbtn) sbtn.disabled = true;
            } else if (streaming) {
              // Orphaned in-flight turn: show what was saved (or a soft interrupted note)
              // as final — no bind, no composer lock, no lingering turn.
              var ictx = newAssistantBubble();
              setBubbleText(ictx, m.text || '\\u26a0 This reply was interrupted and did not finish.');
            } else if (Array.isArray(m.turns) && m.turns.length > 0) {
              // Rich replay: the saved per-turn structure (text + the data-change activity
              // cards it produced), matching the live stream.
              m.turns.forEach(function (t) { appendAssistantTurn(t, m.created_at, m.startedAt); });
            } else {
              // Plain text bubble — messages saved before turns were persisted.
              var c = newAssistantBubble(); setBubbleText(c, m.text);
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
    function appendUserBubble(text, fileNames) {
      railEmptyGone();
      var feedEl = railFeedEl(); if (!feedEl) return;
      var msg = document.createElement('div'); msg.className = 'chat-msg user';
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
      feedEl.appendChild(msg); feedEl.scrollTop = feedEl.scrollHeight;
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
    // Re-enable the composer once no turn is streaming (a turn recovered on reload keeps
    // it disabled until that turn finishes). Reflects busy state off the live turn count.
    function releaseComposer() {
      var streaming = Object.keys(chatTurns).length > 0;
      chatBusy = streaming;
      feedTurnActive = streaming;
      var sb = document.getElementById('chat-send'); if (sb) sb.disabled = streaming;
      if (!streaming) { var inp = document.getElementById('chat-input'); if (inp) inp.focus(); }
      // Turn finished (also fires on a pre-flight refusal / network reject): drain
      // the next queued follow-up, if any.
      if (!streaming) flushChatQueue();
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
            var settled = row.status !== 'streaming' && row.status !== 'pending';
            var visible = turn.threadId === currentThreadId;
            if (settled) {
              // The turn finished (its 'done' may have been lost during the disconnect):
              // render the final text and release.
              if (visible && row.text) { if (!turn.actx) turn.actx = newAssistantBubble(); setBubbleText(turn.actx, row.text); }
              turn.assembled = row.text || turn.assembled;
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
        if (visible) { finalizeBubble(turn.actx); turn.actx = newAssistantBubble(); }
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
        if (visible) finalizeBubble(turn.actx);
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
        if (visible) { finalizeBubble(turn.actx); var lb = newAssistantBubble(); setBubbleText(lb, '⏳ ' + ev.message); if (typeof refreshLimitBlock === 'function') refreshLimitBlock(); }
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
    // A dimmed placeholder for a follow-up typed mid-turn; removed when it flushes.
    function appendQueuedBubble(text, fileNames) {
      railEmptyGone();
      var feedEl = railFeedEl(); if (!feedEl) return null;
      var msg = document.createElement('div'); msg.className = 'chat-msg user queued';
      var label = text || (fileNames && fileNames.length ? fileNames.join(', ') : '');
      var b = document.createElement('div'); b.className = 'chat-bubble user'; b.textContent = label;
      msg.appendChild(b);
      var tag = document.createElement('span'); tag.className = 'chat-queued-tag'; tag.textContent = 'queued';
      msg.appendChild(tag);
      feedEl.appendChild(msg); feedEl.scrollTop = feedEl.scrollHeight;
      return msg;
    }
    // Queue a follow-up sent while a turn is streaming: show a placeholder, clear
    // the composer (like a real send), and remember it to flush on turn-done.
    function enqueueChat(text, attachedFiles) {
      var fileNames = (attachedFiles || []).map(function (f) { return f && f.name ? f.name : 'file'; });
      var node = appendQueuedBubble(text, fileNames);
      var input = document.getElementById('chat-input');
      if (input) { input.value = ''; if (input._autoGrow) input._autoGrow(); else input.style.height = 'auto'; }
      chatQueue.push({ text: text, files: attachedFiles, node: node });
    }
    // Send the next queued follow-up once the composer is free. Each flushed send
    // keeps sendChat's own inline error handling, so a failed queued send surfaces
    // loudly rather than dropping.
    function flushChatQueue() {
      if (chatBusy || !chatQueue.length) return;
      var item = chatQueue.shift();
      if (item.node && item.node.remove) item.node.remove();
      sendChat(item.text, item.files);
    }
    function sendChat(text, attachedFiles) {
      var hasFiles = !!(attachedFiles && attachedFiles.length);
      if (!text && !hasFiles) return;
      // Streaming: don't drop the message — queue it and drain on turn-done.
      if (chatBusy) { enqueueChat(text, attachedFiles); return; }
      // A files-only send (no message) must NOT fabricate a "take a look at this file"
      // sentence — show the attached file name(s) as the bubble instead. That is
      // truthful (it is what the user attached), and the server's attached-files note
      // is what actually directs the assistant to read them.
      var fileNames = (attachedFiles || []).map(function (f) { return f && f.name ? f.name : 'file'; });
      var effectiveText = text || fileNames.join(', ') || 'file';
      chatBusy = true;
      gaTrack('assistant_message', {}); // no message text — just the event

      // Open a fresh turn scope: this turn's activity cards group together (no
      // window expiry) and their timers measure from now.
      feedTurnId += 1;
      feedTurnStartMs = Date.now();
      feedTurnActive = true;
      // Show the REAL typed text (empty on a files-only send) plus the attached files
      // as chips — not the synthesized effectiveText, which would otherwise hide the
      // files behind the message on a text+file send.
      appendUserBubble(text, fileNames);
      var historyToSend = chatHistory.slice();
      chatHistory.push({ role: 'user', text: effectiveText, files: fileNames });
      var input = document.getElementById('chat-input');
      var sendBtn = document.getElementById('chat-send');
      // Clear + collapse the textarea back to one line (reuse its auto-grow so
      // the reset matches the grow logic instead of leaving a bare 'auto').
      if (input) { input.value = ''; if (input._autoGrow) input._autoGrow(); else input.style.height = 'auto'; }
      if (sendBtn) sendBtn.disabled = true;
      // Private mode: when the composer checkbox is checked, items the assistant
      // adds on this turn stay private to the current user.
      var privEl = document.getElementById('chat-private');
      var privateMode = !!(privEl && privEl.checked);
      fetch('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // activeContext: the record on screen, so "this file"/"this row" resolves.
        body: JSON.stringify({ message: effectiveText, history: historyToSend, threadId: currentThreadId, privateMode: privateMode, activeContext: activeElement(), attachedFiles: (attachedFiles || []).slice(0, 25), ingestInProgress: (typeof ingestOrImportActive === 'function' && ingestOrImportActive()) })
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
