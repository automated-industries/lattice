// Auto-composed segment of the GUI client script. The structured-source importer
// is reachable ONLY by dropping a file into the assistant chat: an upload that the
// server recognizes as a confirmable structured source comes back with an
// `autoImport` proposal, and this segment renders a confirm card straight into the
// assistant rail (#rail-feed) — no top-bar button, no modal. Apply streams the
// import pipeline live into that same card. Reuses the shared globals defined
// earlier in the composed script: escapeHtml, refreshEntities, renderSidebar,
// renderRoute, state. Like every segment this is ONE template literal — no raw
// backticks or ${...} inside (they would break the literal); HTML is built with
// single-quoted string concatenation.
export const inlineImportJs = `
    // ── Inline structured-source import (confirm card in the assistant rail) ──
    function iiRailFeed() { return document.getElementById('rail-feed'); }
    function iiRailEmptyGone() {
      var e = document.getElementById('rail-empty');
      if (e) e.parentNode && e.parentNode.removeChild(e);
    }

    // Auto-run the data-model planner on the freshly-imported tables — it applies safe
    // normalizations immediately (and surfaces the rest as one-click suggestions in the
    // Data Model panel), so an import lands already-tidied instead of needing a manual
    // reorg. Fire-and-forget + a re-refresh so any auto-applied change shows right away.
    function iiAutoTidy() {
      fetch('/api/data-model/plan')
        .then(function () { return refreshEntities(); })
        .then(function () { renderSidebar(); renderRoute(); })
        .catch(function () {});
    }

    // In-progress signal so a chat turn can be made AWARE that ingestion is running: the
    // composer passes ingestOrImportActive() to /api/chat and the server tells the model
    // some data may still be loading. Counts silent structured imports PLUS any browser/
    // server file-ingest batch (the shared ingestProgressState).
    var iiActiveImports = 0;
    // ingestProgressState (browser/server file-ingest batches) lives inside an EARLIER IIFE
    // and is NOT in scope here, so the batch-ingest signal is mirrored onto this outer-scope
    // flag by the progress renderer (ingest-progress-state sets it on every state change).
    // Structured imports count via iiActiveImports.
    var iiBatchIngestActive = false;
    function ingestOrImportActive() {
      return iiActiveImports > 0 || iiBatchIngestActive;
    }

    // Read a newline-delimited-JSON response body, invoking onEvent(obj) per line.
    // Self-contained on purpose — this segment must not depend on any other.
    function iiStreamNdjson(url, payload, onEvent) {
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (res) {
        if (!res.body || !res.body.getReader) {
          return res.text().then(function (t) {
            t.split('\\n').forEach(function (line) {
              if (line.trim()) { try { onEvent(JSON.parse(line)); } catch (e) { /* skip */ } }
            });
          });
        }
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = '';
        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) {
              if (buf.trim()) { try { onEvent(JSON.parse(buf)); } catch (e) { /* skip */ } }
              return;
            }
            buf += dec.decode(chunk.value, { stream: true });
            var idx;
            while ((idx = buf.indexOf('\\n')) >= 0) {
              var line = buf.slice(0, idx);
              buf = buf.slice(idx + 1);
              if (line.trim()) { try { onEvent(JSON.parse(line)); } catch (e) { /* skip */ } }
            }
            return pump();
          });
        }
        return pump();
      }).catch(function (err) {
        onEvent({ phase: 'error', message: err && err.message ? err.message : 'Request failed' });
      });
    }

    // Dispatch an upload's autoImport proposal. Silent creation: a brand-new structured
    // dataset imports DIRECTLY — no confirm card, because confirmation cards are clunky.
    // A known-dataset re-import with no detectable date (needs-confirm) still asks, since
    // that is a genuine low-confidence choice (which snapshot date to file it under?).
    function handleAutoImport(autoImport) {
      if (!autoImport || !autoImport.reason) return;
      if (autoImport.reason === 'new-dataset') runInlineImportSilent(autoImport);
      else renderInlineImportCard(autoImport);
    }

    // Silent import of a brand-new dataset: materialize every base table + row plus ALL
    // detected computed views immediately (no opt-in UI), streaming a compact live-
    // progress card — there is no Apply gate. Marginal/uncertain links still surface as
    // questions in the assistant's panel (the apply route enqueues them regardless).
    function runInlineImportSilent(autoImport) {
      if (!autoImport || !autoImport.fileId) return;
      iiActiveImports++; // chat-awareness: a turn sent now knows the import is running
      // Auto-select every detected computed view (the silent path has no opt-in card).
      var computedSel = (autoImport.computedProposals || []).map(function (p) {
        return { table: p.table, fields: (p.fields || []).map(function (f) { return f.name; }) };
      });
      iiRailEmptyGone();
      var feedEl = iiRailFeed();
      var card = document.createElement('div');
      card.className = 'feed-item import-live';
      var icon = document.createElement('div'); icon.className = 'feed-icon'; icon.textContent = '⤓';
      var bodyEl = document.createElement('div'); bodyEl.className = 'feed-body';
      var title = document.createElement('div'); title.className = 'feed-summary';
      title.textContent = 'Importing your data…';
      var log = document.createElement('div'); log.className = 'imp-card-log';
      bodyEl.appendChild(title); bodyEl.appendChild(log);
      card.appendChild(icon); card.appendChild(bodyEl);
      if (feedEl) { feedEl.appendChild(card); feedEl.scrollTop = feedEl.scrollHeight; }
      function addLine(text, cls) {
        var d = document.createElement('div');
        d.className = 'imp-card-line' + (cls ? ' ' + cls : '');
        d.textContent = text;
        log.appendChild(d);
        while (log.childNodes.length > 60) log.removeChild(log.firstChild);
        if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
        return d;
      }
      addLine('Starting…');
      iiStreamNdjson('/api/import/apply', {
        fileId: autoImport.fileId,
        mode: 'both',
        asOf: '',
        asOfColumn: '',
        // Echo the threshold the proposal was inferred under so apply bands links identically.
        linkConfidence: autoImport.linkConfidence,
        computed: computedSel,
      }, function (evt) {
        if (!evt) return;
        if (evt.phase === 'done') {
          iiActiveImports = Math.max(0, iiActiveImports - 1);
          var r = evt.result || {};
          var rbt = r.rowsByTable || {};
          var names = Object.keys(rbt);
          var total = 0;
          names.forEach(function (n) { total += (rbt[n] || 0); });
          title.textContent = 'Imported ' + names.length + ' table' + (names.length === 1 ? '' : 's') +
            ', ' + total + ' row' + (total === 1 ? '' : 's');
          var upd = addLine('Updating your objects…', 'imp-spin');
          refreshEntities().then(function () {
            renderSidebar();
            renderRoute();
            if (upd) { upd.className = 'imp-card-line imp-done'; upd.textContent = '✓ Done'; }
            iiAutoTidy();
          }).catch(function () {
            if (upd) {
              upd.className = 'imp-card-line imp-err';
              upd.textContent = 'Imported, but refreshing the view failed — reload to see your objects.';
            }
          });
        } else if (evt.phase === 'error') {
          iiActiveImports = Math.max(0, iiActiveImports - 1);
          title.textContent = 'Import failed';
          addLine('Error: ' + (evt.message || 'import failed'), 'imp-err');
        } else if (evt.message) {
          addLine(evt.message);
        }
      });
    }

    // Render the confirm card for a structured drop the server flagged as
    // needing confirmation. autoImport is the upload response's proposal:
    // { reason, fileId, plan:{entities,dimensions,linkages}, views, asOf,
    //   asOfCandidates, asOfColumns, schemaMatch, matchedCount, totalEntities,
    //   linkConfidence, computedProposals }.
    function renderInlineImportCard(autoImport) {
      if (!autoImport || !autoImport.fileId) return;
      var plan = autoImport.plan || {};
      var ents = plan.entities || [];
      var dims = plan.dimensions || [];
      var links = plan.linkages || [];
      var views = autoImport.views || [];
      var candidates = autoImport.asOfCandidates || [];
      var asOfColumns = autoImport.asOfColumns || [];
      var schemaMatch = autoImport.schemaMatch || {};
      var computed = autoImport.computedProposals || [];
      var headerText = autoImport.reason === 'needs-confirm'
        ? 'Add a dated snapshot'
        : 'Import as a new dataset';

      iiRailEmptyGone();
      var feedEl = iiRailFeed();
      var card = document.createElement('div');
      card.className = 'feed-item import-confirm';
      var icon = document.createElement('div');
      icon.className = 'feed-icon';
      icon.textContent = '⤓';
      var bodyEl = document.createElement('div');
      bodyEl.className = 'feed-body';
      var title = document.createElement('div');
      title.className = 'feed-summary';
      title.textContent = headerText;
      bodyEl.appendChild(title);

      var parts = [];
      if (schemaMatch.isKnownDocument) {
        parts.push('<div class="cd-status ok imp-match">Recognized as a new period of an existing document &mdash; ' +
          schemaMatch.matchedCount + ' of ' + schemaMatch.totalEntities +
          ' tables match what you already imported. It will be added as a dated snapshot.</div>');
      }
      parts.push('<div class="cd-status ok">Found ' + ents.length + ' entities, ' + dims.length +
        ' dimensions, ' + links.length + ' links' +
        (views.length ? ', ' + views.length + ' reconstructed views (no duplicated rows)' : '') +
        '.</div><ul class="cd-import-list">');
      ents.forEach(function (e) {
        parts.push('<li><b>' + escapeHtml(e.name) + '</b> &mdash; ' + e.rowCount + ' rows, ' +
          (e.columns ? e.columns.length : 0) + ' cols &middot; ' +
          (e.naturalKey ? 'key ' + escapeHtml(e.naturalKey) : 'keyless') + '</li>');
      });
      dims.forEach(function (d) {
        parts.push('<li><b>' + escapeHtml(d.name) + '</b> (dimension) &mdash; ' + d.distinctValues + ' values</li>');
      });
      views.forEach(function (v) {
        parts.push('<li><b>' + escapeHtml(v.name) + '</b> (view of ' + escapeHtml(v.master) + ' where ' +
          escapeHtml(v.filterColumn) + ' = ' + escapeHtml(String(v.filterValue)) + ') &mdash; ' +
          v.matchedRows + ' rows, not duplicated</li>');
      });
      parts.push('</ul>');

      parts.push('<h4 class="imp-sub">As of date</h4>');
      var best = candidates[0];
      parts.push('<p class="cd-sub">' +
        (best ? 'Detected from ' + escapeHtml(best.evidence) + ' &mdash; edit if wrong.'
              : 'No date found in the file or its name &mdash; set the snapshot date, or leave blank to import undated.') +
        ' A newer file is kept as a separate dated snapshot beside the prior one.</p>');
      parts.push('<div class="cd-row"><input class="cd-path" id="ii-asof" type="date" value="' + escapeHtml(autoImport.asOf || '') + '" aria-label="As of date" /></div>');
      if (candidates.length > 1) {
        parts.push('<div class="cd-sub">Other candidates: ' + candidates.slice(1, 5).map(function (c) {
          return '<a href="#" class="ii-asof-alt" data-date="' + escapeHtml(c.date) + '" title="' + escapeHtml(c.evidence) + '">' + escapeHtml(c.date) + '</a>';
        }).join(', ') + '</div>');
      }
      if (asOfColumns.length) {
        var colOpts = asOfColumns.slice(0, 6).map(function (c) {
          return '<option value="' + escapeHtml(c.column) + '" title="' + escapeHtml(c.evidence) + '">' +
            escapeHtml(c.column) + ' (' + escapeHtml(c.entity) + ', ' + c.distinctDates +
            ' date' + (c.distinctDates === 1 ? '' : 's') + ')</option>';
        }).join('');
        parts.push('<label class="imp-percol"><input type="checkbox" id="ii-asof-percol"> ' +
          '<span>Date varies per row &mdash; use a date column instead (one file, many periods)</span></label>');
        parts.push('<div class="cd-row" id="ii-asof-col-row" style="display:none"><select class="cd-path" id="ii-asof-col">' + colOpts + '</select></div>');
      }

      parts.push('<h4 class="imp-sub">What should Lattice bring in?</h4>');
      parts.push('<div class="imp-modes">' +
        '<label><input type="radio" name="ii-mode" value="both" checked> <span><b>Data model + contents</b> — the schema, the taxonomy, and all the rows.</span></label>' +
        '<label><input type="radio" name="ii-mode" value="schema"> <span><b>Data model / schema only</b> — tables, dimension values, and views. No rows.</span></label>' +
        '<label><input type="radio" name="ii-mode" value="contents"> <span><b>Contents only</b> — the rows and their links, into tables that already exist.</span></label>' +
      '</div>');
      if (computed.length) {
        // Opt-in computed-table proposals: unchecked by default; the raw
        // source columns import as plain values either way.
        parts.push('<h4 class="imp-sub">Computed tables</h4>');
        parts.push('<p class="cd-sub">Optional — formulas and categories detected in the source. ' +
          'Checked fields become live computed tables; the raw values import either way.</p>');
        computed.forEach(function (t) {
          (t.fields || []).forEach(function (f) {
            var evidence = f.kind === 'calc'
              ? (f.example ? 'formula =' + f.example : 'formula')
              : 'classify by ' + (f.input || '');
            parts.push('<label class="imp-computed"><input type="checkbox" class="ii-computed"' +
              ' data-table="' + escapeHtml(t.table) + '" data-field="' + escapeHtml(f.name) + '"> ' +
              '<span><b>' + escapeHtml(t.table) + '.' + escapeHtml(f.name) + '</b> &mdash; ' +
              escapeHtml(evidence) + ' &middot; ' + Math.round((f.confidence || 0) * 100) +
              '% of rows</span></label>');
          });
        });
      }
      parts.push('<div class="cd-row"><button class="btn primary cd-btn cd-primary" id="ii-apply" type="button">Import into Lattice</button></div>');
      parts.push('<div class="imp-card-log" id="ii-log"></div>');

      var content = document.createElement('div');
      content.className = 'imp-confirm-body';
      content.innerHTML = parts.join('');
      bodyEl.appendChild(content);
      card.appendChild(icon);
      card.appendChild(bodyEl);
      if (feedEl) { feedEl.appendChild(card); feedEl.scrollTop = feedEl.scrollHeight; }

      content.querySelectorAll('.ii-asof-alt').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          var input = document.getElementById('ii-asof');
          if (input) input.value = a.getAttribute('data-date') || '';
        });
      });
      var perCol = document.getElementById('ii-asof-percol');
      if (perCol) perCol.addEventListener('change', function () {
        var row = document.getElementById('ii-asof-col-row');
        var dateEl = document.getElementById('ii-asof');
        if (row) row.style.display = perCol.checked ? '' : 'none';
        if (dateEl) dateEl.disabled = perCol.checked;
      });

      var applyBtn = document.getElementById('ii-apply');
      if (applyBtn) applyBtn.addEventListener('click', function () {
        runInlineImport(autoImport, title, content);
      });
    }

    // POST the confirmed proposal to /api/import/apply and stream the pipeline
    // live into the card's log. On 'done' show a success summary + refresh the
    // Objects nav in place; on 'error' show the message.
    function runInlineImport(autoImport, title, content) {
      var fileId = autoImport.fileId;
      var sel = content.querySelector('input[name="ii-mode"]:checked');
      var mode = sel ? sel.value : 'both';
      var asofEl = document.getElementById('ii-asof');
      var asOf = asofEl ? asofEl.value : '';
      var perColEl = document.getElementById('ii-asof-percol');
      var colSel = document.getElementById('ii-asof-col');
      var asOfColumn = (perColEl && perColEl.checked && colSel) ? colSel.value : '';
      // Checked computed-table fields, grouped per proposed table.
      var computedByTable = {};
      content.querySelectorAll('.ii-computed').forEach(function (cb) {
        if (!cb.checked) return;
        var t = cb.getAttribute('data-table');
        var f = cb.getAttribute('data-field');
        if (!t || !f) return;
        (computedByTable[t] = computedByTable[t] || []).push(f);
      });
      var computedSel = Object.keys(computedByTable).map(function (t) {
        return { table: t, fields: computedByTable[t] };
      });
      var applyBtn = document.getElementById('ii-apply');
      if (applyBtn) applyBtn.disabled = true;

      var feedEl = iiRailFeed();
      var log = document.getElementById('ii-log');
      function addLine(text, cls) {
        if (!log) return null;
        var d = document.createElement('div');
        d.className = 'imp-card-line' + (cls ? ' ' + cls : '');
        d.textContent = text;
        log.appendChild(d);
        while (log.childNodes.length > 60) log.removeChild(log.firstChild);
        log.scrollTop = log.scrollHeight;
        if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
        return d;
      }
      title.textContent = 'Importing your data…';
      addLine('Starting…');

      iiStreamNdjson('/api/import/apply', {
        fileId: fileId,
        mode: mode,
        asOf: asOf,
        asOfColumn: asOfColumn,
        // Echo the threshold the proposal was inferred under so apply's
        // re-derivation bands links identically.
        linkConfidence: autoImport.linkConfidence,
        computed: computedSel,
      }, function (evt) {
        if (!evt) return;
        if (evt.phase === 'done') {
          var r = evt.result || {};
          var rbt = r.rowsByTable || {};
          var names = Object.keys(rbt);
          var total = 0;
          names.forEach(function (n) { total += (rbt[n] || 0); });
          title.textContent = 'Imported ' + names.length + ' tables' + (mode === 'schema' ? '' : ', ' + total + ' rows');
          var upd = addLine('Updating your objects…', 'imp-spin');
          refreshEntities().then(function () {
            renderSidebar();
            renderRoute();
            var count = (state.entities && state.entities.tables) ? state.entities.tables.length : names.length;
            if (upd) {
              upd.className = 'imp-card-line imp-done';
              upd.textContent = '✓ Done — ' + count + ' objects in your workspace';
            }
            iiAutoTidy();
          }).catch(function () {
            if (upd) {
              upd.className = 'imp-card-line imp-err';
              upd.textContent = 'Imported, but refreshing the view failed — reload to see your objects.';
            }
          });
        } else if (evt.phase === 'error') {
          title.textContent = 'Import failed';
          addLine('Error: ' + (evt.message || 'import failed'), 'imp-err');
        } else if (evt.message) {
          addLine(evt.message);
        }
      });
    }
`;
