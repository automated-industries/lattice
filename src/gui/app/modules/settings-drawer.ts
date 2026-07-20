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
    function closeExistingProvenanceCard() {
      var existing = document.querySelector('.provenance-card');
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    }
    function openProvenanceCard(chip) {
      closeExistingProvenanceCard();
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
      card.innerHTML = '<div class="provenance-card-body">' +
        '<div class="provenance-card-header">' + escapeHtml(chip.textContent) + '</div>' +
        '<div class="provenance-card-meta">' + escapeHtml(tableVal) + '\\u00a0·\\u00a0<code>' + escapeHtml(idVal) + '</code></div>' +
        '<div class="provenance-card-content">' +
          '<p style="margin:0;font-size:0.85em;color:var(--text-muted);">Loading...</p>' +
        '</div></div>';
      document.body.appendChild(card);
      var closeCard = function () {
        if (card.parentNode) {
          card.parentNode.removeChild(card);
          document.removeEventListener('keydown', onEscape);
          document.removeEventListener('click', onOutsideClick);
        }
      };
      var onEscape = function (e) {
        if (e.key === 'Escape') closeCard();
      };
      var onOutsideClick = function (e) {
        if (!card.contains(e.target)) closeCard();
      };
      document.addEventListener('keydown', onEscape);
      document.addEventListener('click', onOutsideClick, { capture: true });
      // Fetch row data to populate the card.
      fetchJson('/api/tables/' + encodeURIComponent(tableVal) + '/rows/' + encodeURIComponent(idVal))
        .then(function (response) {
          var row = response && typeof response === 'object' ? (response.row || response) : null;
          if (!row) return;
          var fields = [];
          var keysToTry = ['name', 'title', 'label', 'original_name', 'subject', 'description', 'body', 'content'];
          for (var i = 0; i < keysToTry.length; i++) {
            var k = keysToTry[i];
            if (row[k]) { fields.push({ key: k, val: String(row[k]).slice(0, 100) }); if (fields.length >= 3) break; }
          }
          var html = '<div class="provenance-fields">';
          for (var j = 0; j < fields.length; j++) {
            html += '<div class="provenance-field"><strong>' + escapeHtml(fields[j].key) + ':</strong> ' + escapeHtml(fields[j].val) + '</div>';
          }
          html += '<button class="btn u-mt-2" style="width:100%;" data-act="open">Open ↗</button></div>';
          var contentEl = card.querySelector('.provenance-card-content');
          if (contentEl) contentEl.innerHTML = html;
          var openBtn = card.querySelector('[data-act="open"]');
          if (openBtn) {
            openBtn.addEventListener('click', function () {
              closeCard();
              openSearchHit(tableVal, idVal);
            });
          }
          // Lazy-load provenance tier.
          fetchJson('/api/provenance/row?table=' + encodeURIComponent(tableVal) + '&id=' + encodeURIComponent(idVal))
            .then(function (prov) {
              if (prov && prov.tier) {
                var tierEl = document.createElement('div');
                tierEl.className = 'provenance-tier';
                tierEl.textContent = 'Source: ' + escapeHtml(prov.tier);
                var contentEl2 = card.querySelector('.provenance-card-content');
                if (contentEl2 && contentEl2.firstChild) {
                  contentEl2.insertBefore(tierEl, contentEl2.firstChild);
                }
              }
            })
            .catch(function () {});
        })
        .catch(function () {
          var contentEl = card.querySelector('.provenance-card-content');
          if (contentEl) contentEl.innerHTML = '<p style="margin:0;font-size:0.85em;color:var(--text-muted);">Could not load data.</p>';
        });
    }
    function ensureContextChipHandler() {
      var mount = document.getElementById('fs-context');
      if (!mount) return;
      if (mount.getAttribute('data-chips-wired') === 'true') return;
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
      mount.setAttribute('data-chips-wired', 'true');
    }
    function loadFsContext(tableName, id) {
      var mount = document.getElementById('fs-context');
      if (!mount) return;
      // Clear the chips-wired flag since we're recreating the context.
      mount.removeAttribute('data-chips-wired');
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
        // Build source chips from files array: group by table name, skip self/custom/enriched.
        var sourceChipsHtml = '';
        if (files && files.length > 0) {
          var sourceMap = {};
          for (var f = 0; f < files.length; f++) {
            var file = files[f];
            if (!file || !file.source) continue;
            var src = file.source;
            // Skip self, custom, enriched (no table); only show hasMany/belongsTo/manyToMany.
            if (!src.table || src.type === 'self' || src.type === 'custom' || src.type === 'enriched') {
              continue;
            }
            var srcTable = src.table;
            if (!sourceMap[srcTable]) sourceMap[srcTable] = 0;
            sourceMap[srcTable] += (src.count != null ? src.count : 1);
          }
          if (Object.keys(sourceMap).length > 0) {
            sourceChipsHtml = '<div class="source-chips-row">';
            for (var srcKey in sourceMap) {
              if (sourceMap.hasOwnProperty(srcKey)) {
                sourceChipsHtml += '<span class="source-chip" data-table="' + escapeHtml(srcKey) + '">' +
                  escapeHtml(srcKey) + '\\u00a0·\\u00a0' + sourceMap[srcKey] + '</span>';
              }
            }
            sourceChipsHtml += '</div>';
          }
        }
        mount.innerHTML =
          sourceChipsHtml +
          '<div class="fs-context-doc"><div class="md-body">' + renderedHtml + '</div></div>' +
          '<textarea class="fs-context-edit" spellcheck="false" aria-label="Edit record markdown"></textarea>' +
          '<div class="fs-context-status" aria-live="polite"></div>';
        mount.hidden = false;
        // Wire up source chip clicks to navigate to table views.
        var chipsRow = mount.querySelector('.source-chips-row');
        if (chipsRow) {
          chipsRow.addEventListener('click', function (e) {
            var chip = e.target && e.target.closest ? e.target.closest('.source-chip') : null;
            if (chip) {
              var tbl = chip.getAttribute('data-table');
              if (tbl && typeof openTableView === 'function') {
                openTableView(tbl);
              }
            }
          });
        }
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
