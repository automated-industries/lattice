// Auto-composed segment of the GUI client script. The "Connect dashboard" +
// "Import Dashboard Data" top-bar buttons open self-contained modal panels (no
// dependency on the settings-drawer internals); import progress streams into the
// assistant rail (#rail-feed). Reuses the shared globals defined earlier in the
// composed script: escapeHtml, fetchJson, withBusy, refreshEntities,
// renderSidebar, renderRoute, state. Like every segment this is ONE template
// literal — no raw backticks or ${...} inside (they would break the literal);
// HTML is built with single-quoted string concatenation.
export const connectImportJs = `
    // ── Connect a dashboard + import a data model (modal panels) ──
    function ciCloseModal() {
      var b = document.getElementById('ci-modal-backdrop');
      if (b) b.parentNode && b.parentNode.removeChild(b);
    }
    function ciOpenModal(titleText) {
      ciCloseModal();
      var backdrop = document.createElement('div');
      backdrop.className = 'ci-modal-backdrop';
      backdrop.id = 'ci-modal-backdrop';
      var modal = document.createElement('div');
      modal.className = 'ci-modal';
      var head = document.createElement('div');
      head.className = 'ci-modal-head';
      var h = document.createElement('span');
      h.className = 'ci-modal-title';
      h.textContent = titleText;
      var x = document.createElement('button');
      x.className = 'ci-modal-close';
      x.textContent = '✕';
      x.title = 'Close';
      x.addEventListener('click', ciCloseModal);
      head.appendChild(h);
      head.appendChild(x);
      var body = document.createElement('div');
      body.className = 'ci-modal-body';
      modal.appendChild(head);
      modal.appendChild(body);
      backdrop.appendChild(modal);
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) ciCloseModal(); });
      document.body.appendChild(backdrop);
      return body;
    }
    function ciRailFeed() { return document.getElementById('rail-feed'); }
    function ciRailEmptyGone() {
      var e = document.getElementById('rail-empty');
      if (e) e.parentNode && e.parentNode.removeChild(e);
    }

    // Read a newline-delimited-JSON response body, invoking onEvent(obj) per line.
    function ciStreamNdjson(url, payload, onEvent) {
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

    // Connect-a-dashboard panel. Points Lattice at the user's own dashboard on
    // disk (file or folder), including a copyable prompt that asks Claude to find
    // the path. Connecting POSTs to /api/connect/dashboard (served at /, built-in
    // view at /lattice).
    function renderConnectDashboard(body) {
      function promptFor(desc) {
        var d = (desc || '').trim();
        var intro = d
          ? 'I have a dashboard on this computer that I would describe as: "' + d + '". It is a website made of one or more HTML files (you may have helped me build it). I want to connect it to a local tool, and it needs the dashboard location on disk.'
          : 'I have a dashboard on this computer — a website made of one or more HTML files (you may have helped me build it). I want to connect it to a local tool, and it needs the dashboard location on disk.';
        return [
          intro,
          '',
          'Please reply with:',
          '1) The absolute path to the dashboard. If it is a folder, give the folder that directly contains index.html. If it is a single file, give the full path to that .html file.',
          '2) Whether it is a folder or a single file.',
          '',
          'If you are not sure where it is, search my common locations — Desktop, Documents, Downloads, and any project folders — for index.html or other .html files, and list each candidate with its full absolute path.',
          '',
          'Use forward slashes in the path, and keep the answer short.',
        ].join('\\n');
      }
      function currentPrompt() {
        var el = document.getElementById('cd-desc');
        return promptFor(el ? el.value : '');
      }
      body.innerHTML =
        '<div class="cd-step">' +
          '<p>Lattice can serve <strong>your own</strong> dashboard at this address, with your data behind it. Point it at your dashboard on this computer — the files stay where they are, and your edits show up on refresh.</p>' +
        '</div>' +
        '<div class="cd-step">' +
          '<h4>1 &middot; Folder or single file?</h4>' +
          '<p>If your dashboard is a <strong>folder</strong> (an <code>index.html</code> plus other files), you will give the folder path. If it is a single <code>.html</code> file, give that file path.</p>' +
        '</div>' +
        '<div class="cd-step">' +
          '<h4>2 &middot; Not sure where it lives? Ask Claude</h4>' +
          '<p>Describe your dashboard or type its name, then copy the prompt and paste it into Claude to find the exact path on your computer.</p>' +
          '<textarea class="cd-desc" id="cd-desc" placeholder="e.g. my fund track record dashboard"></textarea>' +
          '<p class="cd-sub">Prompt to copy (this is what Claude will see):</p>' +
          '<textarea class="cd-prompt" id="cd-prompt" readonly aria-label="Prompt to paste into Claude"></textarea>' +
          '<div class="cd-row"><button class="cd-btn" id="cd-copy" type="button">Copy prompt</button></div>' +
        '</div>' +
        '<div class="cd-step">' +
          '<h4>3 &middot; Paste the path and connect</h4>' +
          '<div class="cd-row">' +
            '<input class="cd-path" id="cd-path" type="text" placeholder="e.g. C:/Users/you/my-dashboard" aria-label="Dashboard path" />' +
            '<button class="cd-btn cd-primary" id="cd-connect" type="button">Connect</button>' +
          '</div>' +
        '</div>' +
        '<div class="cd-status" id="cd-status"></div>';

      var statusEl = document.getElementById('cd-status');
      function showStatus(cls, html) {
        if (!statusEl) return;
        statusEl.className = 'cd-status ' + cls;
        statusEl.innerHTML = html;
      }
      var liveLinks =
        ' <a href="/" target="_blank" rel="noopener">open it</a>' +
        ' (the built-in Lattice view is at <a href="/lattice" target="_blank" rel="noopener">/lattice</a>).';

      var descEl = document.getElementById('cd-desc');
      var promptEl = document.getElementById('cd-prompt');
      function refreshPrompt() { if (promptEl) promptEl.value = currentPrompt(); }
      if (descEl) descEl.addEventListener('input', refreshPrompt);
      refreshPrompt();

      var copyBtn = document.getElementById('cd-copy');
      if (copyBtn) copyBtn.addEventListener('click', function () {
        var text = currentPrompt();
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () {
            copyBtn.textContent = 'Copied!';
            window.setTimeout(function () { copyBtn.textContent = 'Copy prompt'; }, 1500);
          });
        } else if (promptEl) {
          promptEl.focus();
          promptEl.select();
        }
      });

      var connectBtn = document.getElementById('cd-connect');
      if (connectBtn) connectBtn.addEventListener('click', function () {
        var input = document.getElementById('cd-path');
        var path = input ? input.value.trim() : '';
        if (!path) { showStatus('err', 'Enter the path to your dashboard first.'); return; }
        withBusy(connectBtn, function () {
          return fetchJson('/api/connect/dashboard', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: path }),
          }).then(function (d) {
            showStatus('ok', 'Connected ' + (d.mode === 'dir' ? 'folder' : 'file') + ' — opening your dashboard…');
            window.setTimeout(function () { window.location.href = '/'; window.location.reload(); }, 350);
          }).catch(function (err) {
            showStatus('err', escapeHtml(err.message || 'Could not connect that path.'));
          });
        });
      });

      fetchJson('/api/connect/dashboard').then(function (d) {
        if (d && d.path) {
          showStatus('ok', 'Currently connected: <code>' + escapeHtml(d.path) + '</code> (' + (d.mode === 'dir' ? 'folder' : 'file') + ') —' + liveLinks);
          var input = document.getElementById('cd-path');
          if (input && !input.value) input.value = d.path;
          ciSetDashboardConnected(true);
        }
      }).catch(function () { /* no connection yet */ });
    }

    // Import a data model (Excel .xlsx or JSON) → tables, deduped, with as-of
    // snapshots. Analyze previews the schema; Import streams the pipeline live
    // into the rail and refreshes the Objects nav in place (no page reload).
    function renderImportData(body) {
      body.innerHTML =
        '<div class="cd-step">' +
          '<h4>Import a data model</h4>' +
          '<p>Pull a structured file (Excel <code>.xlsx</code> or JSON) into Lattice as real tables — entities, dimensions, and their links — so Lattice becomes the source of truth.</p>' +
          '<div class="cd-row">' +
            '<input class="cd-path" id="imp-path" type="text" placeholder="path to a .xlsx or .json file" aria-label="Import file path" />' +
            '<button class="cd-btn" id="imp-analyze" type="button">Analyze</button>' +
          '</div>' +
          '<div class="cd-or">or</div>' +
          '<label class="cd-btn imp-browse">Choose file&hellip;' +
            '<input type="file" id="imp-file" accept=".xlsx,.xls,.json" hidden />' +
          '</label>' +
        '</div>' +
        '<div id="imp-out"></div>';

      var pathInput = document.getElementById('imp-path');
      fetchJson('/api/connect/import/sources').then(function (s) {
        if (s.sources && s.sources.length && pathInput && !pathInput.value) pathInput.value = s.sources[0];
      }).catch(function () { /* no candidates */ });

      var out = document.getElementById('imp-out');
      var analyzeBtn = document.getElementById('imp-analyze');
      if (analyzeBtn) analyzeBtn.addEventListener('click', function () {
        var path = pathInput ? pathInput.value.trim() : '';
        if (!path) { out.innerHTML = '<div class="cd-status err">Enter the path to a .xlsx or .json file, or choose one below.</div>'; return; }
        withBusy(analyzeBtn, function () {
          return fetchJson('/api/connect/import/analyze', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: path }),
          }).then(function (r) {
            renderImportPlan(path, r.plan || {}, r.views || [], r.asOf, r.asOfCandidates, r.asOfColumns, r.schemaMatch);
          }).catch(function (err) {
            out.innerHTML = '<div class="cd-status err">' + escapeHtml(err.message || 'Analyze failed.') + '</div>';
          });
        });
      });

      // "Choose file…": a browser can't hand the server a path, so upload the
      // bytes to /stage, then run the normal path-based analyze on the result.
      var fileInput = document.getElementById('imp-file');
      if (fileInput) fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        out.innerHTML = '<div class="cd-status">Uploading ' + escapeHtml(f.name) + '&hellip;</div>';
        f.arrayBuffer().then(function (buf) {
          return fetch('/api/connect/import/stage', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(f.name) },
            body: buf,
          });
        }).then(function (res) { return res.json(); }).then(function (d) {
          if (d && d.path) {
            if (pathInput) pathInput.value = d.path;
            if (analyzeBtn) analyzeBtn.click();
          } else {
            out.innerHTML = '<div class="cd-status err">' + escapeHtml((d && d.error) || 'Upload failed.') + '</div>';
          }
        }).catch(function (err) {
          out.innerHTML = '<div class="cd-status err">' + escapeHtml(err.message || 'Upload failed.') + '</div>';
        });
      });

      function renderImportPlan(path, plan, views, asOf, candidates, asOfColumns, schemaMatch) {
        candidates = candidates || [];
        asOfColumns = asOfColumns || [];
        var ents = plan.entities || [];
        var dims = plan.dimensions || [];
        var links = plan.linkages || [];
        views = views || [];
        var parts = [];
        if (schemaMatch && schemaMatch.isKnownDocument) {
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
        parts.push('<div class="cd-row"><input class="cd-path" id="imp-asof" type="date" value="' + escapeHtml(asOf || '') + '" aria-label="As of date" /></div>');
        if (candidates.length > 1) {
          parts.push('<div class="cd-sub">Other candidates: ' + candidates.slice(1, 5).map(function (c) {
            return '<a href="#" class="imp-asof-alt" data-date="' + escapeHtml(c.date) + '" title="' + escapeHtml(c.evidence) + '">' + escapeHtml(c.date) + '</a>';
          }).join(', ') + '</div>');
        }
        if (asOfColumns.length) {
          var colOpts = asOfColumns.slice(0, 6).map(function (c) {
            return '<option value="' + escapeHtml(c.column) + '" title="' + escapeHtml(c.evidence) + '">' +
              escapeHtml(c.column) + ' (' + escapeHtml(c.entity) + ', ' + c.distinctDates +
              ' date' + (c.distinctDates === 1 ? '' : 's') + ')</option>';
          }).join('');
          parts.push('<label class="imp-percol"><input type="checkbox" id="imp-asof-percol"> ' +
            '<span>Date varies per row &mdash; use a date column instead (one file, many periods)</span></label>');
          parts.push('<div class="cd-row" id="imp-asof-col-row" style="display:none"><select class="cd-path" id="imp-asof-col">' + colOpts + '</select></div>');
        }
        parts.push('<h4 class="imp-sub">What should Lattice bring in?</h4>');
        parts.push('<div class="imp-modes">' +
          '<label><input type="radio" name="imp-mode" value="both" checked> <span><b>Data model + contents</b> — the schema, the taxonomy, and all the rows.</span></label>' +
          '<label><input type="radio" name="imp-mode" value="schema"> <span><b>Data model / schema only</b> — tables, dimension values, and views. No rows.</span></label>' +
          '<label><input type="radio" name="imp-mode" value="contents"> <span><b>Contents only</b> — the rows and their links, into tables that already exist.</span></label>' +
        '</div>');
        parts.push('<div class="cd-row"><button class="cd-btn cd-primary" id="imp-do" type="button">Import into Lattice</button></div>');
        parts.push('<div class="cd-sub">Progress streams into the activity panel on the right.</div>');
        out.innerHTML = parts.join('');
        out.querySelectorAll('.imp-asof-alt').forEach(function (a) {
          a.addEventListener('click', function (e) {
            e.preventDefault();
            var input = document.getElementById('imp-asof');
            if (input) input.value = a.getAttribute('data-date') || '';
          });
        });
        var perCol = document.getElementById('imp-asof-percol');
        if (perCol) perCol.addEventListener('change', function () {
          var row = document.getElementById('imp-asof-col-row');
          var dateEl = document.getElementById('imp-asof');
          if (row) row.style.display = perCol.checked ? '' : 'none';
          if (dateEl) dateEl.disabled = perCol.checked;
        });
        var doBtn = document.getElementById('imp-do');
        if (doBtn) doBtn.addEventListener('click', function () { runImport(path); });
      }

      function runImport(path) {
        var sel = out.querySelector('input[name="imp-mode"]:checked');
        var mode = sel ? sel.value : 'both';
        var asofEl = document.getElementById('imp-asof');
        var asOf = asofEl ? asofEl.value : '';
        var perColEl = document.getElementById('imp-asof-percol');
        var colSel = document.getElementById('imp-asof-col');
        var asOfColumn = (perColEl && perColEl.checked && colSel) ? colSel.value : '';
        var doBtn = document.getElementById('imp-do');
        if (doBtn) doBtn.disabled = true;

        // Move into the rail: close the modal + open a live import card.
        ciCloseModal();
        ciRailEmptyGone();
        var feedEl = ciRailFeed();
        var card = document.createElement('div');
        card.className = 'feed-item import-live';
        var icon = document.createElement('div');
        icon.className = 'feed-icon';
        icon.textContent = '⤓';
        var bodyEl = document.createElement('div');
        bodyEl.className = 'feed-body';
        var title = document.createElement('div');
        title.className = 'feed-summary';
        title.textContent = 'Importing your data…';
        var log = document.createElement('div');
        log.className = 'imp-card-log';
        bodyEl.appendChild(title);
        bodyEl.appendChild(log);
        card.appendChild(icon);
        card.appendChild(bodyEl);
        if (feedEl) { feedEl.appendChild(card); feedEl.scrollTop = feedEl.scrollHeight; }

        function addLine(text, cls) {
          var d = document.createElement('div');
          d.className = 'imp-card-line' + (cls ? ' ' + cls : '');
          d.textContent = text;
          log.appendChild(d);
          while (log.childNodes.length > 60) log.removeChild(log.firstChild);
          log.scrollTop = log.scrollHeight;
          if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
          return d;
        }
        addLine('Starting…');

        ciStreamNdjson('/api/connect/import/apply', { path: path, mode: mode, asOf: asOf, asOfColumn: asOfColumn }, function (evt) {
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
              upd.className = 'imp-card-line imp-done';
              upd.textContent = '✓ Done — ' + count + ' objects in your workspace';
            }).catch(function () {
              upd.className = 'imp-card-line imp-err';
              upd.textContent = 'Imported, but refreshing the view failed — reload to see your objects.';
            });
          } else if (evt.phase === 'error') {
            title.textContent = 'Import failed';
            addLine('Error: ' + (evt.message || 'import failed'), 'imp-err');
          } else if (evt.message) {
            addLine(evt.message);
          }
        });
      }
    }

    // The top-bar dashboard button is state-aware: "Connect dashboard" opens the
    // connect panel; once a dashboard is connected it becomes "Go to Dashboard"
    // and opens the served dashboard (/) in a new tab.
    var ciDashboardConnected = false;
    function ciApplyConnectButton() {
      var btn = document.getElementById('connect-dash-btn');
      if (!btn) return;
      var label = btn.querySelector('.connect-dash-label');
      if (ciDashboardConnected) {
        if (label) label.textContent = 'Go to Dashboard';
        btn.title = 'Open your dashboard in a new tab';
      } else {
        if (label) label.textContent = 'Connect dashboard';
        btn.title = 'Connect your own dashboard';
      }
    }
    function ciSetDashboardConnected(connected) {
      ciDashboardConnected = !!connected;
      ciApplyConnectButton();
    }
    function ciRefreshConnectButton() {
      fetchJson('/api/connect/dashboard')
        .then(function (d) { ciSetDashboardConnected(d && d.path); })
        .catch(function () { /* leave the button as-is on error */ });
    }
    function ciOpenImportModal() { renderImportData(ciOpenModal('Import Dashboard Data')); }
    function ciOpenConnectModal() { renderConnectDashboard(ciOpenModal('Connect a dashboard')); }

    (function ciWireButtons() {
      var importBtn = document.getElementById('import-data-btn');
      if (importBtn) importBtn.addEventListener('click', ciOpenImportModal);
      var connectBtn = document.getElementById('connect-dash-btn');
      if (connectBtn) connectBtn.addEventListener('click', function () {
        if (ciDashboardConnected) window.open('/', '_blank', 'noopener');
        else ciOpenConnectModal();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') ciCloseModal();
      });
      ciRefreshConnectButton();
    })();
`;
