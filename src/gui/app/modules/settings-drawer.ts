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
        mount.innerHTML =
          '<div class="fs-context-doc"><div class="md-body">' + mdToHtml(stripFrontmatter(raw)) + '</div></div>' +
          '<textarea class="fs-context-edit" spellcheck="false" aria-label="Edit record markdown"></textarea>' +
          '<div class="fs-context-status" aria-live="polite"></div>';
        mount.hidden = false;
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
          if (renderedBody) renderedBody.innerHTML = mdToHtml(stripFrontmatter(cur));
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
