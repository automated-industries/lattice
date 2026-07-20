// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const settingsDrawerJs = `    // ────────────────────────────────────────────────────────────
    // Row context (Lattice-rendered markdown files)
    // ────────────────────────────────────────────────────────────

    // Single-record view: build the record's ONE compiled document — the primary
    // (first non-empty) rendered file, NOT every per-section file concatenated
    // (which produced duplicate "Files" sections) — into #fs-context, as both a
    // FORMATTED render (.fs-context-doc) and an editable raw-markdown textarea
    // (.fs-context-edit). Editing the textarea derives the round-trippable column
    // updates and writes them back to the record (debounced PUT …/context) and
    // live-updates the formatted view; applyFsItemView toggles which one shows.
    //
    // Linkify lattice:// references in the rendered markdown: extract links,
    // replace with sentinels, pass through mdToHtml, then swap back as trace chips.
    // The chips open a provenance card showing the linked row's display label and
    // a few key fields.
    function renderContextMarkdown(raw) {
      var pills = [];
      var pre = String(raw == null ? '' : raw).replace(
        /\\[([^\\]]+)\\]\\(lattice:\\/\\/([a-zA-Z0-9_]+)\\/([^)\\s]+)\\)/g,
        function (_, label, table, id) {
          pills.push({ label: label, table: table, id: decodeURIComponent(id) });
          return '\\u0002' + (pills.length - 1) + '\\u0002';
        }
      );
      var html = mdToHtml(pre);
      return html.replace(/\\u0002([0-9]+)\\u0002/g, function (_, n) {
        var p = pills[Number(n)];
        return '<span class="chip chip-trace" data-table="' + escapeHtml(p.table) +
          '" data-id="' + escapeHtml(p.id) + '" tabindex="0" role="button" title="View provenance">🔗 ' +
          escapeHtml(p.label) + '</span>';
      });
    }
    function openProvenanceCard(chip) {
      var rect = chip.getBoundingClientRect();
      var tableVal = chip.getAttribute('data-table');
      var idVal = chip.getAttribute('data-id');
      if (!tableVal || !idVal) return;
      var card = document.createElement('div');
      card.className = 'provenance-card';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', 'Row provenance');
      card.style.position = 'fixed';
      card.style.top = (rect.bottom + 4) + 'px';
      card.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
      card.style.maxWidth = '300px';
      card.style.zIndex = '10000';
      card.innerHTML = '<div style="padding:12px;background:var(--surface);border:1px solid var(--border-strong);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.15);">' +
        '<div style="font-weight:500;margin-bottom:8px;word-break:break-word;">' + escapeHtml(chip.textContent) + '</div>' +
        '<div style="font-size:0.85em;color:var(--text-muted);margin-bottom:8px;">' + escapeHtml(tableVal) + '\\u00a0·\\u00a0<code>' + escapeHtml(idVal) + '</code></div>' +
        '<div style="border-top:1px solid var(--border);padding-top:8px;margin-top:8px;">' +
          '<p style="margin:0;font-size:0.85em;color:var(--text-muted);">Loading...</p>' +
        '</div></div>';
      document.body.appendChild(card);
      var closeCard = function () {
        if (card.parentNode) card.parentNode.removeChild(card);
      };
      var onEscape = function (e) {
        if (e.key === 'Escape') { closeCard(); document.removeEventListener('keydown', onEscape); }
      };
      card.addEventListener('click', closeCard);
      document.addEventListener('keydown', onEscape);
      document.addEventListener('click', function (e) {
        if (!card.contains(e.target) && e.target !== chip) closeCard();
      }, { once: true, capture: true });
      // Fetch row data to populate the card.
      fetchJson('/api/tables/' + encodeURIComponent(tableVal) + '/rows/' + encodeURIComponent(idVal))
        .then(function (row) {
          if (!row) return;
          var fields = [];
          var keysToTry = ['name', 'title', 'label', 'original_name', 'subject', 'description', 'body', 'content'];
          for (var i = 0; i < keysToTry.length; i++) {
            var k = keysToTry[i];
            if (row[k]) { fields.push({ key: k, val: String(row[k]).slice(0, 100) }); if (fields.length >= 3) break; }
          }
          var html = '<div style="font-size:0.85em;">';
          for (var j = 0; j < fields.length; j++) {
            html += '<div style="margin-bottom:6px;"><strong>' + escapeHtml(fields[j].key) + ':</strong> ' + escapeHtml(fields[j].val) + '</div>';
          }
          html += '<button class="btn u-mt-2" style="width:100%;" data-act="open">Open ↗</button></div>';
          card.querySelector('[role="dialog"] > div > div:last-child').innerHTML = html;
          card.querySelector('[data-act="open"]').addEventListener('click', function () {
            closeCard();
            openSearchHit(tableVal, idVal);
          });
        })
        .catch(function () {
          card.querySelector('[role="dialog"] > div > div:last-child').innerHTML = '<p style="margin:0;font-size:0.85em;color:var(--text-muted);">Could not load data.</p>';
        });
    }
    var _contextChipWired = false;
    function ensureContextChipHandler() {
      if (_contextChipWired) return;
      var mount = document.getElementById('fs-context');
      if (!mount) return;
      mount.addEventListener('click', function (e) {
        var chip = e.target && e.target.closest ? e.target.closest('.chip-trace') : null;
        if (!chip) return;
        openProvenanceCard(chip);
      });
      mount.addEventListener('keydown', function (e) {
        if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.classList && e.target.classList.contains('chip-trace')) {
          e.preventDefault();
          openProvenanceCard(e.target);
        }
      });
      _contextChipWired = true;
    }
    function loadFsContext(tableName, id) {
      var mount = document.getElementById('fs-context');
      if (!mount) return;
      // Capture the render generation so a debounced save can't fire into a record
      // the user has navigated away from (renderRoute bumps renderGen on every nav).
      var myGen = renderGen;
      var url = '/api/tables/' + encodeURIComponent(tableName) + '/rows/' +
                encodeURIComponent(id) + '/context';
      fetchJson(url).then(function (data) {
        var files = (data && data.files) || [];
        var primary = null;
        for (var i = 0; i < files.length; i++) {
          if (files[i] && files[i].content) { primary = files[i]; break; }
        }
        if (!primary) {
          mount.innerHTML = '<div class="fs-empty" style="padding:16px">No rendered markdown for this record yet.</div>';
          mount.hidden = false;
          if (typeof applyFsItemView === 'function') applyFsItemView();
          return;
        }
        var raw = primary.content;
        var strippedRaw = stripFrontmatter(raw);
        var renderedHtml = renderContextMarkdown(strippedRaw);
        mount.innerHTML =
          '<div class="fs-context-doc"><div class="md-body">' + renderedHtml + '</div></div>' +
          '<textarea class="fs-context-edit" spellcheck="false" aria-label="Edit record markdown"></textarea>' +
          '<div class="fs-context-status" aria-live="polite"></div>';
        mount.hidden = false;
        ensureContextChipHandler();
        var ta = mount.querySelector('.fs-context-edit');
        var renderedBody = mount.querySelector('.fs-context-doc .md-body');
        var statusEl = mount.querySelector('.fs-context-status');
        ta.value = raw;
        function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }
        // Debounced write-back: the server derives the round-trippable column
        // updates from the edited markdown and applies them; the formatted view
        // re-renders on every keystroke so a switch to Formatted shows the latest.
        var saveTimer = null;
        var lastSaved = raw;
        ta.addEventListener('input', function () {
          var cur = ta.value;
          var stripped = stripFrontmatter(cur);
          if (renderedBody) renderedBody.innerHTML = renderContextMarkdown(stripped);
          ensureContextChipHandler();
          setStatus('Editing\\u2026');
          if (saveTimer) window.clearTimeout(saveTimer);
          saveTimer = window.setTimeout(function () {
            // Superseded by a newer navigation: don't PUT into a record that is no
            // longer on screen (and don't write "Saved"/"Save failed" to a
            // detached status node the user can't see).
            if (myGen !== renderGen) return;
            if (cur === lastSaved) return;
            lastSaved = cur;
            setStatus('Saving\\u2026');
            fetchJson(url, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ content: cur }),
            }).then(function (r) {
              var n = r && typeof r.updated === 'number' ? r.updated : 0;
              setStatus(n > 0 ? ('Saved ' + n + (n === 1 ? ' field' : ' fields')) : 'No structured fields changed (free-form edits are not saved).');
              if (typeof invalidate === 'function') invalidate(tableName);
              if (typeof refreshEntities === 'function') refreshEntities();
            }).catch(function (err) {
              setStatus('Save failed: ' + (err && err.message ? err.message : 'error'));
            });
          }, 800);
        });
        if (typeof applyFsItemView === 'function') applyFsItemView();
      }).catch(function () {
        mount.innerHTML = '';
        mount.hidden = true;
        if (typeof applyFsItemView === 'function') applyFsItemView();
      });
    }

`;
