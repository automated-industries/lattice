// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const createDatabaseWizardJs = `    // ────────────────────────────────────────────────────────────
    // File ingest — drag a file onto the rail or use the paperclip.
    // Browsers can't expose the local path, so we POST the bytes; the
    // server extracts + summarizes, then discards them (path stays null).
    // ────────────────────────────────────────────────────────────
    // Cap how many uploads are in flight at once. A browser allows only ~6
    // HTTP/1.1 connections per host, so a bulk drop of N files would fire N
    // upload POSTs in parallel and saturate that budget — every other data
    // request (entities, rows, navigation) then queues for minutes behind the
    // multi-minute ingests and the GUI looks frozen. Holding uploads to a few
    // at a time leaves connections free for the rest of the app (and eases the
    // AI rate limit each ingest hits server-side). The realtime/feed streams are
    // already off this budget — they share one WebSocket — so this is the last
    // place a big batch could starve the connection pool.
    var INGEST_MAX_CONCURRENCY = 3;
    // Run a batch of upload thunks with at most \`limit\` in flight, calling
    // onProgress(done, total) as each settles. One failure never stalls the
    // batch — uploadFile surfaces its own error and resolves.
    function runIngestBatch(thunks, limit, onProgress) {
      return new Promise(function (resolve) {
        var total = thunks.length, idx = 0, done = 0;
        function startNext() {
          if (idx >= total) return;
          var thunk = thunks[idx++];
          Promise.resolve().then(thunk).catch(function () { /* already surfaced */ }).then(function () {
            done++;
            if (onProgress) onProgress(done, total);
            if (done === total) resolve(); else startNext();
          });
        }
        for (var i = 0; i < Math.min(limit, total); i++) startNext();
      });
    }
    // Ingest progress bar is now defined in ingest-progress-state.ts as a shared,
    // state-driven component that survives DOM re-renders and is used by both
    // browser batch uploads (kind: 'browser') and server folder ingests (kind: 'server').
    // Use: var bar = ingestProgress(total, 'browser'); bar.update(done, t); bar.done();
    // Append a transient "Analyzing <file>…" row to the feed so the user sees
    // the ingest is processing in the background; returns a disposer. The real
    // create/link feed events stream in over SSE as the server materializes them.
    // Upload ONE file. RESOLVES with the server's JSON on success and REJECTS on
    // failure — it deliberately does not swallow the error and resolve undefined.
    // That old shape was a success-shaped value for a failure: the batch caller read
    // the id off undefined, contributed nothing, and the composer then sent the turn
    // as though one attachment had been everything the user attached.
    function uploadFile(file) {
      // Per-file progress is surfaced by the caller through the unified
      // activity-menu background-task tracker (a single-file task, or the batch
      // task in uploadFiles) — no bespoke per-file feed row here.
      // Carry the composer's "Private mode" intent so an upload made while the
      // box is checked is stamped private at insert, instead of inheriting the
      // files-table default (which can be shared-to-everyone on a cloud). Read
      // the checkbox defensively — it may not be rendered. On a local workspace
      // the box is checked+disabled, so this is '1' there too; forced visibility
      // is a harmless no-op on the single-user SQLite path.
      var pv = document.getElementById('chat-private');
      var priv = pv && pv.checked ? '1' : '0';
      return fetch('/api/ingest/upload', {
        method: 'POST',
        // Percent-encode the filename: HTTP header values must be ISO-8859-1,
        // so a Unicode filename (emoji, smart quote, accent, em-dash) would
        // otherwise make fetch() throw "String contains non ISO-8859-1 code
        // point". The server decodeURIComponent()s it back.
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name || 'file'), 'x-lattice-private': priv },
        body: file,
      })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
    }
    // Ingest the given files and RESOLVE with { ok: [{id, name}], failed: [{name, error}] }
    // — BOTH sets, always. The caller (the composer Send) needs to know not just what
    // landed but what didn't: sending a turn that references only the files that
    // happened to succeed is how five attachments quietly became one. opts.silent
    // suppresses the single-file open-the-record navigation (used when a chat message
    // accompanies the upload — the chat is the focus).
    function uploadFiles(files, opts) {
      opts = opts || {};
      if (!files || !files.length) return Promise.resolve({ ok: [], failed: [] });
      gaTrack('file_ingest', { count: files.length }); // count only — never file names
      // Single-file drop: open the resulting record once it lands (the dedup
      // survivor if it was a duplicate). Multi-file drops do not navigate.
      if (files.length === 1) {
        var only = files[0];
        var oname = (only && only.name) || 'file';
        // Single-file: an indeterminate task in the unified tracker while the
        // upload + server-side extraction run.
        var t1 = bgTask('ingest', { label: 'Analyzing ' + oname + '…' });
        return uploadFile(only).then(function (j) {
          var sid = j && (j.duplicateOf || j.id);
          if (!sid) {
            t1.fail('Ingest failed');
            return { ok: [], failed: [{ name: oname, error: 'the server returned no file' }] };
          }
          t1.done('Analyzed ' + oname);
          // A structured source the server flagged as confirmable comes back with
          // an autoImport proposal — render the inline confirm card instead of
          // navigating to the file record. A silent import (autoImport.imported,
          // no reason) or a plain file keeps the open-the-record behavior.
          if (j.autoImport && j.autoImport.reason) handleAutoImport(j.autoImport);
          else if (!opts.silent) openSearchHit('files', sid);
          return { ok: [{ id: sid, name: only.name }], failed: [] };
        }, function (e) {
          t1.fail('Ingest failed: ' + e.message);
          showToast('Ingest failed: ' + e.message, {});
          return { ok: [], failed: [{ name: oname, error: e.message }] };
        });
      }
      // Multi-file: drain through the bounded-concurrency queue (so a big drop
      // can't saturate the connection budget) with a batch progress bar.
      var bar = ingestProgress(files.length, 'browser');
      var okRefs = [];
      var failedRefs = [];
      var thunks = [];
      for (var i = 0; i < files.length; i++) {
        (function (f) {
          var fname = (f && f.name) || 'file';
          thunks.push(function () {
            return uploadFile(f).then(function (j) {
              // A structured source within a batch still gets its own inline
              // confirm card (the batch as a whole does not navigate).
              if (j && j.autoImport && j.autoImport.reason) handleAutoImport(j.autoImport);
              var fid = j && (j.duplicateOf || j.id);
              if (fid) okRefs.push({ id: fid, name: f.name });
              else failedRefs.push({ name: fname, error: 'the server returned no file' });
            }, function (e) {
              showToast('Could not add ' + fname + ': ' + e.message, {});
              failedRefs.push({ name: fname, error: e.message });
            });
          });
        })(files[i]);
      }
      return runIngestBatch(thunks, INGEST_MAX_CONCURRENCY, bar.update)
        .then(bar.done)
        .then(function () { return { ok: okRefs, failed: failedRefs }; });
    }
    // ── Staging tray ────────────────────────────────────────────────────────
    // A dropped file (or one picked via the paperclip) is NOT ingested on the
    // spot — it's staged in a tray the user reviews first. The "✕" drops one file;
    // the main composer Send ingests the batch (→ uploadFiles) along with any typed
    // message. Multiple drops accumulate into the one tray (deduped by name+size).
    var stagedFiles = [];
    // Files already ingested for the CURRENT draft but not yet sent — they exist when a
    // previous submit had SOME uploads fail: those refs must not be re-uploaded (they
    // are already in Files) and must not be dropped either, so they ride along with the
    // next send of this draft.
    var stagedRefs = [];
    function removeStagingTray() {
      var el = document.getElementById('staging-tray');
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    function clearStaging() {
      stagedFiles = [];
      stagedRefs = [];
      removeStagingTray();
      if (typeof updateComposerAction === 'function') updateComposerAction();
    }
    // True while a staged batch is ingesting. The tray itself is already gone by then
    // (the submit clears the composer in one tick and shows the pending message bubble
    // instead), so this is purely the re-entrancy guard + an input to the action
    // button's derived state.
    var stagingBusy = false;
    function setStagingBusy(busy) {
      stagingBusy = busy;
      if (typeof updateComposerAction === 'function') updateComposerAction();
    }
    function stageFiles(fileList) {
      if (!fileList || !fileList.length) return;
      for (var i = 0; i < fileList.length; i++) {
        var f = fileList[i];
        var dup = stagedFiles.some(function (s) { return s.name === f.name && s.size === f.size; });
        if (!dup) stagedFiles.push(f);
      }
      renderStagingTray();
      if (typeof updateComposerAction === 'function') updateComposerAction();
    }
    function renderStagingTray() {
      removeStagingTray();
      if (!stagedFiles.length) return;
      // The tray sits in its OWN host directly above the composer (not in the
      // message feed) so the "files to add" list is always visible right above the
      // chat box while you type — each chip removable via its ✕.
      var host = document.getElementById('staging-tray-host');
      if (!host) return;
      var n = stagedFiles.length;
      var rows = stagedFiles.map(function (f, idx) {
        return '<li class="staging-file">' +
          '<span class="staging-file-ic">📄</span>' +
          '<span class="staging-file-name">' + escapeHtml(f.name || 'file') + '</span>' +
          '<button class="staging-file-x" data-idx="' + idx + '" type="button" title="Remove" aria-label="Remove">✕</button>' +
        '</li>';
      }).join('');
      var tray = document.createElement('div');
      tray.className = 'staging-tray';
      tray.id = 'staging-tray';
      tray.innerHTML =
        '<div class="staging-head">' + n + (n === 1 ? ' file to add' : ' files to add') + '</div>' +
        '<ul class="staging-list">' + rows + '</ul>';
      // The tray just DISPLAYS the staged files (each removable with its ✕); the
      // main composer Send ingests them — no separate Send/Cancel here.
      host.appendChild(tray);
      tray.querySelectorAll('.staging-file-x').forEach(function (b) {
        b.addEventListener('click', function () {
          stagedFiles.splice(Number(b.getAttribute('data-idx')), 1);
          renderStagingTray();
          if (typeof updateComposerAction === 'function') updateComposerAction();
        });
      });
    }
    // Surface a notice when files/secrets aren't bound as native objects — the
    // assistant key storage + ingest need them. Normally they auto-create on
    // open; this only shows in the edge case where a pre-existing plaintext
    // secrets table was skipped (the adopt flow won't silently encrypt it).
    function checkNativeSetup() {
      fetchJson('/api/native-entities').then(function (d) {
        var bound = {};
        ((d && d.bindings) || []).forEach(function (b) { if (b.origin !== 'skipped') bound[b.entity] = true; });
        var missing = ['files', 'secrets'].filter(function (e) { return !bound[e]; });
        if (missing.length === 0) return;
        var feedEl = railFeedEl(); if (!feedEl) return;
        railEmptyGone();
        var card = document.createElement('div');
        card.className = 'feed-item';
        var note = 'Set up native ' + missing.join(' + ') + ' to enable the assistant’s key storage and file ingest.';
        if (missing.indexOf('secrets') >= 0) {
          note += ' A pre-existing plaintext “secrets” table is left untouched — move its rows to an encrypted native secrets store to use it here.';
        }
        card.innerHTML = '<div class="feed-icon">⚠️</div><div class="feed-body"><div class="feed-summary">' +
          escapeHtml(note) + '</div></div>';
        feedEl.insertBefore(card, feedEl.firstChild);
      }).catch(function () { /* ignore */ });
    }

    function renderComposer() {
      var host = document.getElementById('rail-composer'); if (!host) return;
      fetchJson('/api/assistant/config').then(function () {
          // The composer is always active — a connected Claude subscription is
          // guaranteed past the first-run wall (or supplied by a managed deployment),
          // so there is no key-gated setup prompt anymore.
          // Dictation is always on-device + keyless, so the mic always shows; there
          // is no provider choice in the GUI (the cloud route stays API-only).
          var micHtml = '<button class="composer-mic" id="chat-mic" title="Record voice">🎙</button>';
          host.innerHTML =
            '<div class="composer-row">' +
              // A <label for> the hidden file input opens the picker NATIVELY on
              // click — the prior <button> + fileInput.click() was a no-op in the
              // desktop webview (programmatic .click() on a display:none input is
              // blocked there), so the upload button did nothing.
              '<label class="composer-clip" id="chat-clip" for="chat-file" role="button" tabindex="0" title="Upload files" aria-label="Upload files">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
                  '<polyline points="17 8 12 3 7 8"/>' +
                  '<line x1="12" y1="3" x2="12" y2="15"/>' +
                '</svg>' +
              '</label>' +
              micHtml +
              '<textarea id="chat-input" rows="1" placeholder="Ask or instruct…"></textarea>' +
              '<button class="composer-send" id="chat-send">Send</button>' +
            '</div>' +
            // Private mode — when checked, items the assistant adds on this send
            // stay private to me (passed as privateMode in the /api/chat body).
            // Local workspaces are inherently single-user/private, so on local we
            // force the box checked + disabled as a read-only indicator (cloudMode
            // is set from the workspace kind before the composer renders).
            '<label class="composer-private' + (cloudMode ? '' : ' is-disabled') + '">' +
              '<input type="checkbox" id="chat-private"' + (cloudMode ? '' : ' checked disabled') + ' /> Private mode ' +
              '<span class="composer-private-hint">' +
                (cloudMode ? 'New items I add stay private to you' : 'Local workspaces are always private') +
              '</span>' +
            '</label>' +
            // Visually hidden but STILL RENDERED (not display:none): a <label for> can
            // only open the native picker for an input the engine considers rendered —
            // a display:none file input is inert in the desktop webview, so the clip
            // button did nothing. This sr-only style keeps it activatable + off-screen.
            '<input type="file" id="chat-file" multiple ' +
              'style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0,0,0,0);border:0;padding:0;margin:-1px;">';
          var input = document.getElementById('chat-input');
          var sendBtn = document.getElementById('chat-send');
          var clipBtn = document.getElementById('chat-clip');
          var fileInput = document.getElementById('chat-file');
          if (clipBtn && fileInput) {
            // The label opens the picker natively on click (its for-target is the
            // hidden input) — do NOT also call fileInput.click() (that
            // double-triggers, opening then instantly cancelling the dialog). Only
            // add keyboard activation for the role=button.
            clipBtn.addEventListener('keydown', function (e) {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
            });
            fileInput.addEventListener('change', function () { stageFiles(fileInput.files); fileInput.value = ''; });
          }
          // Grow the textarea to fit its content (wrapped lines included), capped
          // so it never swallows the feed. Recompute on input AND whenever the
          // textarea's width changes (rail resize / mobile drawer) — re-wrapping
          // at a new width changes how many lines the same text needs.
          function autoGrowInput() {
            input.style.height = 'auto';
            input.style.height = Math.min(COMPOSER_MAX_H, input.scrollHeight) + 'px';
          }
          input._autoGrow = autoGrowInput;
          input.addEventListener('input', function () {
            autoGrowInput();
            // Typing is one of the inputs to the action button's state: an empty box
            // mid-reply offers Stop, a non-empty one offers Queue.
            updateComposerAction();
          });
          if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(function () { autoGrowInput(); }).observe(input);
          }
          autoGrowInput(); // fit the initial height
          // The ONE Send button (and Enter). When files are staged, ADD them to
          // Files FIRST (await ingest), then run the chat against those just-added
          // files — so the assistant works on exactly what was attached, any file
          // type, single or many. Text only → just chat. Files (with or WITHOUT text)
          // → add them AND chat, so Lattice always responds to an attachment.
          function submitComposer() {
            var t = input.value.trim();
            // Lattice is still replying: DON'T bail — sendChat queues a follow-up sent
            // while a turn streams (see the queue tray in onboarding.ts) instead of
            // dropping it. A text-only send queues directly; a send with staged files
            // ingests them (so they're added now) and queues the chat about them.
            // Guard the in-flight ingest FIRST, before the text-only fast path: while a
            // staged batch ingests, stagedFiles is already cleared, so a second Enter
            // would otherwise fall into the fast path and fire a text-only turn that
            // races the files. (Enter isn't covered by the disabled Send button.)
            if (stagingBusy) return; // an ingest for this tray is already in flight
            if (!stagedFiles.length) {
              // Nothing new to ingest — but a previous partial failure may have left
              // already-ingested refs waiting for this draft; they go now.
              if (stagedRefs.length) {
                var carried = stagedRefs.slice();
                stagedRefs = [];
                sendChat(t, carried);
              } else if (t) {
                sendChat(t);
              }
              return;
            }
            var batch = stagedFiles.slice();
            var names = batch.map(function (f) { return (f && f.name) || 'file'; });
            var carriedRefs = stagedRefs.slice();
            // COMMIT THE COMPOSER FIRST, synchronously, before the upload is even
            // started: the message appears in the conversation, the box and the tray
            // empty together, and the button takes its busy state — all in one tick.
            // Doing the ingest first left the typed text sitting in a box the user
            // could not send from, with the file chips already gone and no sign that
            // anything had happened.
            var pendingBubble = commitComposer(t, names);
            setStagingBusy(true);
            // An attachment must NEVER be dropped silently. If ANY file fails to land we
            // send NOTHING: the failures go back in the tray, the text goes back in the
            // box, and the message is marked as not sent — because a turn that names
            // only the files that happened to succeed is a turn about the wrong thing.
            var restore = function (failedNames, message) {
              stageFiles(batch.filter(function (f) {
                return failedNames.indexOf((f && f.name) || 'file') >= 0;
              }));
              // Files that DID land are already in Files; carry their refs so the retry
              // attaches them instead of losing or re-uploading them.
              input.value = t;
              if (input._autoGrow) input._autoGrow();
              setStagingBusy(false);
              markBubbleFailed(pendingBubble, message, function () { submitComposer(); });
              showToast(message, {});
            };
            uploadFiles(batch, { silent: true }).then(
              function (result) {
                var ok = (result && result.ok) || [];
                var failed = (result && result.failed) || [];
                if (failed.length) {
                  stagedRefs = carriedRefs.concat(ok);
                  restore(
                    failed.map(function (f) { return f.name; }),
                    'Couldn’t add ' + failed.map(function (f) { return f.name; }).join(', ') +
                      ' — still attached, tap Send to retry.'
                  );
                  return;
                }
                stagedRefs = [];
                stagingBusy = false; // sendChat owns the action button for this turn
                sendChat(t, carriedRefs.concat(ok), { bubble: pendingBubble });
              },
              function (e) {
                // The whole ingest failed — put everything back and say so.
                stagedRefs = carriedRefs;
                restore(names, 'Couldn’t add your files (' + e.message + ') — still attached, tap Send to retry.');
              },
            );
          }
          input.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            // Cmd/Ctrl+Enter (and Shift+Enter) insert a line break; plain Enter sends.
            if (e.metaKey || e.ctrlKey) {
              e.preventDefault();
              var s = input.selectionStart, en = input.selectionEnd;
              input.value = input.value.slice(0, s) + '\\n' + input.value.slice(en);
              input.selectionStart = input.selectionEnd = s + 1;
              input.dispatchEvent(new Event('input')); // re-run the auto-grow sizer
              return;
            }
            if (!e.shiftKey) { e.preventDefault(); submitComposer(); }
          });
          sendBtn.addEventListener('click', function () {
            // One button, whichever state it is currently in.
            var action = sendBtn.getAttribute('data-action');
            // A stop already asked for and not yet delivered — the button says so and
            // is disabled. Never fall through to a send from this state.
            if (action === 'stopping') return;
            if (action === 'stop') {
              stopActiveTurn().then(null, function () {
                // stopActiveTurn already showed the failure; nothing further to do
                // here beyond not treating the turn as ended.
              });
              return;
            }
            submitComposer();
          });
          var micBtn = document.getElementById('chat-mic');
          if (micBtn) {
            micBtn.addEventListener('click', function () {
              // Faded/unavailable mic → clicking is a no-op (no error dialog).
              if (micBtn.classList.contains('composer-mic-unavailable')) return;
              toggleRecording(micBtn, input);
            });
            refreshMicAvailability(micBtn);
          }
          // The composer is freshly rendered — derive the button's state rather than
          // leaving it on whatever the markup happened to say.
          registerComposerAction('chat-send');
          updateComposerAction();
      }).catch(function () {
        host.innerHTML = '<div class="composer-setup">Assistant unavailable.</div>';
      });
    }

    /** Reload column meta after a secret-flag change. */
    function refreshColumnMeta() {
      return fetchJson('/api/gui-meta/columns').then(function (d) {
        state.columnMeta = d || {};
      });
    }


    // One shared interval keeps every relative timestamp on the page current — chat
    // bubbles and activity times alike. Without it a label is frozen at the moment it
    // was written, so an open conversation reads "0s ago" indefinitely.
    startRelTimeTicker();
    init();
  })();
  `;
