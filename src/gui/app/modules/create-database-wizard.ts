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
    function pendingIngestItem(label) {
      railEmptyGone();
      var feedEl = document.getElementById('rail-feed');
      if (!feedEl) return function () {};
      var item = document.createElement('div');
      item.className = 'feed-item feed-pending';
      item.innerHTML =
        '<div class="feed-icon"><span class="feed-spinner"></span></div>' +
        '<div class="feed-body"><div class="feed-summary">Analyzing ' + escapeHtml(label) + '…</div></div>' +
        '<div class="feed-time">0s</div>';
      // Same bottom-pin rule as renderFeedItem: don't bury a streaming chat
      // turn's typing bubble beneath this card.
      var anchor = feedTypingAnchor(feedEl);
      if (anchor) feedEl.insertBefore(item, anchor); else feedEl.appendChild(item);
      feedEl.scrollTop = feedEl.scrollHeight;
      // Live elapsed-time counter while the upload + server-side extraction run.
      // Previously the time element was left empty (rendered as a stuck "0s")
      // because nothing tracked or updated it. Tick once a second; the cleanup
      // returned below clears the interval (and self-clears if the node is gone).
      var started = Date.now();
      var timeEl = item.querySelector('.feed-time');
      var tick = setInterval(function () {
        if (!item.parentNode || !timeEl) { clearInterval(tick); return; }
        timeEl.textContent = formatElapsed(Date.now() - started);
      }, 1000);
      return function () {
        clearInterval(tick);
        if (item.parentNode) item.parentNode.removeChild(item);
      };
    }
    function uploadFile(file) {
      var done = pendingIngestItem(file.name || 'file');
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
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
        .catch(function (e) { showToast('Ingest failed: ' + e.message, {}); })
        .finally(function () { done(); });
    }
    // Ingest the given files and RESOLVE with [{id, name}] for each that landed —
    // so the caller (the composer Send) can reference the just-added files in the
    // chat turn. opts.silent suppresses the single-file open-the-record navigation
    // (used when a chat message accompanies the upload — the chat is the focus).
    function uploadFiles(files, opts) {
      opts = opts || {};
      if (!files || !files.length) return Promise.resolve([]);
      gaTrack('file_ingest', { count: files.length }); // count only — never file names
      // Single-file drop: open the resulting record once it lands (the dedup
      // survivor if it was a duplicate). Multi-file drops do not navigate.
      if (files.length === 1) {
        return uploadFile(files[0]).then(function (j) {
          // A structured source the server flagged as confirmable comes back with
          // an autoImport proposal — render the inline confirm card instead of
          // navigating to the file record. A silent import (autoImport.imported,
          // no reason) or a plain file keeps the open-the-record behavior.
          if (j && j.autoImport && j.autoImport.reason) renderInlineImportCard(j.autoImport);
          else if (!opts.silent && j && (j.duplicateOf || j.id)) openSearchHit('files', j.duplicateOf || j.id);
          var sid = j && (j.duplicateOf || j.id);
          return sid ? [{ id: sid, name: files[0].name }] : [];
        });
      }
      // Multi-file: drain through the bounded-concurrency queue (so a big drop
      // can't saturate the connection budget) with a batch progress bar.
      var bar = ingestProgress(files.length, 'browser');
      var refs = [];
      var thunks = [];
      for (var i = 0; i < files.length; i++) {
        (function (f) {
          thunks.push(function () {
            return uploadFile(f).then(function (j) {
              // A structured source within a batch still gets its own inline
              // confirm card (the batch as a whole does not navigate).
              if (j && j.autoImport && j.autoImport.reason) renderInlineImportCard(j.autoImport);
              var fid = j && (j.duplicateOf || j.id);
              if (fid) refs.push({ id: fid, name: f.name });
            });
          });
        })(files[i]);
      }
      return runIngestBatch(thunks, INGEST_MAX_CONCURRENCY, bar.update)
        .then(bar.done)
        .then(function () { return refs; });
    }
    // ── Staging tray ────────────────────────────────────────────────────────
    // A dropped file (or one picked via the paperclip) is NOT ingested on the
    // spot — it's staged in a tray the user reviews first. The "✕" drops one file;
    // the main composer Send ingests the batch (→ uploadFiles) along with any typed
    // message. Multiple drops accumulate into the one tray (deduped by name+size).
    var stagedFiles = [];
    function removeStagingTray() {
      var el = document.getElementById('staging-tray');
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    function clearStaging() { stagedFiles = []; removeStagingTray(); }
    // While a staged batch is ingesting, lock Send + relabel the tray "Adding…"
    // instead of clearing it — so a single-file ingest (which has no batch bar) still
    // shows the work in flight, and a failure keeps the files attached to retry.
    var stagingBusy = false;
    function setStagingBusy(busy) {
      stagingBusy = busy;
      var sendBtn = document.getElementById('chat-send');
      if (sendBtn) sendBtn.disabled = busy;
      var tray = document.getElementById('staging-tray');
      if (tray) tray.classList.toggle('staging-busy', busy);
      var head = tray && tray.querySelector('.staging-head');
      if (head) {
        var n = stagedFiles.length;
        head.textContent = busy
          ? (n === 1 ? 'Adding your file…' : 'Adding ' + n + ' files…')
          : (n + (n === 1 ? ' file to add' : ' files to add'));
      }
    }
    function stageFiles(fileList) {
      if (!fileList || !fileList.length) return;
      for (var i = 0; i < fileList.length; i++) {
        var f = fileList[i];
        var dup = stagedFiles.some(function (s) { return s.name === f.name && s.size === f.size; });
        if (!dup) stagedFiles.push(f);
      }
      renderStagingTray();
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
          input.addEventListener('input', autoGrowInput);
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
            // Lattice is still replying: sendChat's chatBusy guard would drop this turn AFTER
            // we'd already ingested the files, silently losing them. Bail now, keeping the
            // staged files + typed text intact so the user can send once the reply finishes.
            if (typeof chatBusy !== 'undefined' && chatBusy) return;
            if (!stagedFiles.length) { if (t) sendChat(t); return; }
            if (stagingBusy) return; // an ingest for this tray is already in flight
            var batch = stagedFiles.slice();
            // Clear the tray for the send (the ingest shows its own "Analyzing…" card) and
            // LOCK Send while the files ingest. Critically, an attachment must NEVER be dropped
            // silently: if the ingest fails (or yields no file) we RE-STAGE the batch and never
            // send the message without it — the old reject path sent the text alone, losing the
            // file, and a files-only send no-oped with the file already gone.
            clearStaging();
            setStagingBusy(true);
            uploadFiles(batch, { silent: true }).then(
              function (refs) {
                if (refs && refs.length) {
                  stagingBusy = false; // sendChat now owns the Send button for this turn
                  sendChat(t, refs);
                } else {
                  // Ingest produced no usable file — put the files back, keep the text,
                  // never fabricate a turn with no attachment.
                  stageFiles(batch);
                  setStagingBusy(false);
                  showToast('Those files couldn’t be added — they’re still attached, tap Send to retry.', {});
                }
              },
              function () {
                // Ingest failed — put the staged files back (never send the message without
                // its attachment) and tell the user; they retry with Send.
                stageFiles(batch);
                setStagingBusy(false);
                showToast('Couldn’t add your files — they’re still attached, tap Send to retry.', {});
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
          sendBtn.addEventListener('click', function () { submitComposer(); });
          var micBtn = document.getElementById('chat-mic');
          if (micBtn) {
            micBtn.addEventListener('click', function () {
              // Faded/unavailable mic → clicking is a no-op (no error dialog).
              if (micBtn.classList.contains('composer-mic-unavailable')) return;
              toggleRecording(micBtn, input);
            });
            refreshMicAvailability(micBtn);
          }
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


    init();
  })();
  `;
