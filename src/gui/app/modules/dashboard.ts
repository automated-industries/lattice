// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const dashboardJs = `    // ────────────────────────────────────────────────────────────
    // Detail view (with edit / delete)
    // ────────────────────────────────────────────────────────────
    // Minimal, safe Markdown → HTML for file previews. Escapes first, then
    // applies a known-tag subset (headings, lists, bold/italic, inline code,
    // paragraphs). Regexes use char classes + fromCharCode for the backtick so
    // there are no backslashes/backticks to fight the inline template literal.
    var MD_MIMES = [
      'text/markdown',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    function mdToHtml(src) {
      var bt = String.fromCharCode(96);
      function inline(s) {
        s = s.replace(new RegExp(bt + '([^' + bt + ']+?)' + bt, 'g'), '<code>$1</code>');
        s = s.replace(new RegExp('[*][*]([^*]+?)[*][*]', 'g'), '<strong>$1</strong>');
        s = s.replace(new RegExp('[*]([^*]+?)[*]', 'g'), '<em>$1</em>');
        return s;
      }
      var lines = escapeHtml(src).split('\\n');
      var html = '';
      var inList = false;
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        var h = 0;
        while (ln.charAt(h) === '#' && h < 6) h++;
        if (h > 0 && ln.charAt(h) === ' ') {
          if (inList) { html += '</ul>'; inList = false; }
          html += '<h' + h + '>' + inline(ln.slice(h + 1)) + '</h' + h + '>';
          continue;
        }
        if (ln.indexOf('- ') === 0 || ln.indexOf('* ') === 0) {
          if (!inList) { html += '<ul>'; inList = true; }
          html += '<li>' + inline(ln.slice(2)) + '</li>';
          continue;
        }
        if (inList) { html += '</ul>'; inList = false; }
        if (ln.trim() !== '') html += '<p>' + inline(ln) + '</p>';
      }
      if (inList) html += '</ul>';
      return html;
    }

    // Drop a leading YAML frontmatter block (--- … ---) so the rendered
    // document shows the body, not the generator metadata. Uses the same
    // real-newline split convention as mdToHtml.
    function stripFrontmatter(s) {
      var lines = String(s).split('\\n');
      if (lines[0] !== '---') return String(s);
      for (var i = 1; i < lines.length; i++) {
        if (lines[i] === '---') return lines.slice(i + 1).join('\\n').replace(/^\\n+/, '');
      }
      return String(s);
    }

    // A row is backed by a streamable local file when it has a local_ref
    // (ref_uri) or an owned blob (blob_path). Cloud refs aren't served.
    function hasLocalFile(row) {
      return !!(
        (row.ref_kind === 'local_ref' && row.ref_uri) ||
        (row.ref_kind === 'blob' && row.blob_path)
      );
    }
    // Bytes are viewable when there's a local copy OR an S3-backed cloud_ref — the
    // /blob route resolves local-or-S3 transparently, so the browser just hits it.
    function hasViewableFile(row) {
      return hasLocalFile(row) || isS3File(row);
    }
    // The file's bytes live in S3 (cloud). Download (not Open in Finder) applies.
    function isS3File(row) {
      return row.ref_kind === 'cloud_ref' && row.ref_provider === 's3' && !!(row.ref_uri || row.blob_path);
    }
    // True when the row's bytes are reachable on THIS machine's disk (so "Open in
    // Finder" is meaningful). Mirrors the server's localPathOf: a local_ref, or a
    // blob/cloud_ref whose blob_path was kept locally.
    function hasLocalBytes(row) {
      return !!(
        (row.ref_kind === 'local_ref' && row.ref_uri) ||
        ((row.ref_kind === 'blob' || row.ref_kind === 'cloud_ref') && row.blob_path)
      );
    }
    var IMAGE_EXTS = ['png','jpg','jpeg','gif','webp','bmp','svg','avif','heic','heif','ico','tif','tiff'];
    function isImageFile(row) {
      // Detect by mime, FALLING BACK to the filename extension — an upload that
      // didn't record a mime still previews (the inline image was silently missing).
      if (String(row.mime || '').indexOf('image/') === 0) return true;
      var name = String(row.original_name || '').toLowerCase();
      var dot = name.lastIndexOf('.');
      return dot >= 0 && IMAGE_EXTS.indexOf(name.slice(dot + 1)) >= 0;
    }
    // Which action affordances the file view offers for a row (extracted so it
    // can be unit-tested). A file rendered inline (image / PDF with viewable
    // bytes) needs neither. Anything else with bytes gets a browser Download so
    // the underlying file is ALWAYS reachable — including office docs, audio, and
    // video, and even when "Open in Finder" is unavailable (a remote GUI, or
    // LATTICE_LOCAL_OPEN off). "Open in Finder" is additionally offered when the
    // bytes live on this machine and local-open is enabled.
    function fileActions(row, localOpenOn) {
      var viewable = hasViewableFile(row);
      var inline = viewable && (isImageFile(row) || String(row.mime || '') === 'application/pdf');
      return {
        inline: inline,
        open: hasLocalBytes(row) && !!localOpenOn,
        download: (isS3File(row) && !hasLocalBytes(row)) || (hasLocalBytes(row) && !inline),
      };
    }
    // ── Inline HTML files: isolation model ──────────────────────────────────
    // An authored HTML file is UNTRUSTED code. It runs in an iframe sandboxed
    // WITHOUT allow-same-origin, so it loads in an opaque (null) origin and cannot
    // touch the host GUI (no window.parent DOM/storage/cookies) and — with the CSP
    // below — has ZERO network egress (connect-src 'none'). It therefore cannot
    // fetch anything itself; all data access is mediated by the parent through the
    // postMessage broker below, which is READ-ONLY and table-gated. So even a fully
    // compromised page (e.g. via injected row data) can neither exfiltrate nor write.

    // Injected into the frame: a tiny window.lattice data API that talks to the
    // parent broker over postMessage and returns Promises. Written as a plain string
    // (double-quoted internals) so it survives the template literal untouched and
    // never contains a literal closing-script token. The page calls
    // window.lattice.query/get/search — it cannot reach the network directly.
    var __LATTICE_DATA_BRIDGE =
      'window.__lp={};window.__ls=0;' +
      'window.addEventListener("message",function(e){' +
      'var d=e.data;if(!d||d.__latticeReply!==true||e.source!==window.parent)return;' +
      'var p=window.__lp[d.rid];if(!p)return;delete window.__lp[d.rid];' +
      'if(d.ok)p.resolve(d.data);else p.reject(new Error(d.error||"lattice request failed"));});' +
      'function __lreq(op,extra){return new Promise(function(res,rej){' +
      'var rid="r"+(++window.__ls);window.__lp[rid]={resolve:res,reject:rej};' +
      'var m={__lattice:true,rid:rid,op:op};for(var k in extra)m[k]=extra[k];' +
      'window.parent.postMessage(m,"*");' +
      'setTimeout(function(){if(window.__lp[rid]){delete window.__lp[rid];rej(new Error("lattice request timed out"));}},15000);});}' +
      'window.lattice={' +
      'query:function(t,o){o=o||{};return __lreq("query",{table:t,limit:o.limit,offset:o.offset});},' +
      'get:function(t,id){return __lreq("get",{table:t,id:id});},' +
      'search:function(q){return __lreq("search",{query:q});}};';

    // Parent-side broker: the ONLY bridge between the isolated frame and the data
    // API. Strictly READ-ONLY — it performs exactly three GET/search reads against
    // the existing same-origin API and nothing else (no create/update/delete, no
    // arbitrary path), and refuses system/credential tables. RLS still applies
    // server-side, so a cloud member only ever reads rows they may already see.
    function __latticeReadOnlyFetch(msg) {
      var op = msg && msg.op;
      var table = String((msg && msg.table) || '');
      var DENY = { secrets: 1, chat_threads: 1, chat_messages: 1 };
      if (op === 'search') {
        return fetch('/api/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: String((msg && msg.query) || '') }),
        }).then(function (r) { return r.json(); }).then(function (j) { return { ok: true, data: j }; });
      }
      if (!table || table.charAt(0) === '_' || DENY[table]) {
        return Promise.resolve({ ok: false, error: 'forbidden table' });
      }
      if (op === 'query') {
        var lim = Math.min(Math.max(parseInt(msg.limit, 10) || 50, 1), 500);
        var off = Math.max(parseInt(msg.offset, 10) || 0, 0);
        return fetch('/api/tables/' + encodeURIComponent(table) + '/rows?limit=' + lim + '&offset=' + off)
          .then(function (r) { return r.json(); }).then(function (j) { return { ok: true, data: j }; });
      }
      if (op === 'get') {
        return fetch('/api/tables/' + encodeURIComponent(table) + '/rows/' + encodeURIComponent(String(msg.id || '')))
          .then(function (r) { return r.json(); }).then(function (j) { return { ok: true, data: j }; });
      }
      return Promise.resolve({ ok: false, error: 'unsupported op' });
    }
    var __latticeHtmlBrokerInstalled = false;
    function installHtmlFileBroker() {
      if (__latticeHtmlBrokerInstalled) return;
      __latticeHtmlBrokerInstalled = true;
      window.addEventListener('message', function (e) {
        var d = e.data;
        if (!d || d.__lattice !== true) return;
        // Identity check: only honour messages whose source IS the live HTML-file
        // frame's window — an unforgeable handle. (The frame is null-origin, so we
        // can't match on e.origin; source identity is the real gate.)
        var frame = document.getElementById('html-file-frame');
        if (!frame || !frame.contentWindow || e.source !== frame.contentWindow) return;
        var rid = d.rid;
        var reply = function (payload) {
          payload.__latticeReply = true;
          payload.rid = rid;
          try { frame.contentWindow.postMessage(payload, '*'); } catch (x) { /* frame gone */ }
        };
        __latticeReadOnlyFetch(d).then(function (res) {
          reply({ ok: !!res.ok, data: res.data, error: res.error });
        }).catch(function (err) {
          reply({ ok: false, error: String((err && err.message) || err) });
        });
      });
    }

    // Build the document for an HTML-file frame's srcdoc. The CSP <meta> MUST be the
    // very first thing the parser sees — a meta policy only governs content that
    // FOLLOWS it, and the authored document is untrusted, so we must never splice the
    // CSP into the author's markup (anything the author places before it — including
    // a leading <script>, or a <head> token hidden in a comment — would otherwise run
    // with no policy and could open a network channel). Instead we emit OUR OWN
    // document head (CSP first, then the chart lib + data bridge) and place the entire
    // authored document inside OUR <body>. The browser flattens the author's own
    // <html>/<head>/<body> tags into this body, so every authored script runs after
    // (and is therefore governed by) our CSP; an author-supplied CSP <meta> can only
    // intersect/further-restrict ours, never loosen it.
    // The CSP grants inline script/style only, NO network at all (connect-src 'none'
    // + every fetch-directive 'none'/data:), and no nested browsing contexts — data
    // comes through the postMessage broker, not the network.
    function htmlFileSrcdoc(rawHtml) {
      var csp = '<meta http-equiv="Content-Security-Policy" content="' +
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "img-src data:; font-src data:; media-src data:; connect-src 'none'; " +
        "child-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; " +
        "manifest-src 'none'; base-uri 'none'; form-action 'none'" +
        '">';
      var lib = '';
      try {
        var b64 = window.__LATTICE_CHART_LIB__;
        // Split the script tags so this source never contains a literal closing
        // script tag (which would terminate the GUI's own inline script early). The
        // vendored library is ASCII and contains no closing script tag of its own.
        if (b64) lib = '<scr' + 'ipt>' + atob(b64) + '</scr' + 'ipt>';
      } catch (e) { lib = ''; }
      var bridge = '<scr' + 'ipt>' + __LATTICE_DATA_BRIDGE + '</scr' + 'ipt>';
      // CSP first, unconditionally — the authored document is confined to <body>.
      return '<!doctype html><html><head>' + csp + lib + bridge + '</head><body>' +
        String(rawHtml || '') + '</body></html>';
    }
    function renderFilePreview(row) {
      var host = document.getElementById('file-preview'); if (!host || !row) return;
      var id = row.id;
      var mime = row.mime || '';
      var blobUrl = '/api/files/' + encodeURIComponent(id) + '/blob';
      var viewable = hasViewableFile(row);
      var isHtmlFile = mime === 'text/html' && row.artifact_type === 'html';
      var html = '';
      // System-created artifact: a small pill above the rendered content. An HTML
      // file gets its own badge so it reads as a live page, not a markdown note.
      if (isHtmlFile) html += '<div class="artifact-badge html-badge">🌐 HTML</div>';
      else if (row.artifact_type) html += '<div class="artifact-badge">✦ Artifact</div>';
      if (row.description) html += '<div class="file-desc">' + escapeHtml(row.description) + '</div>';
      if (isHtmlFile) {
        // Render the saved HTML live in a fully isolated inline frame. The srcdoc is
        // set as a PROPERTY below (no attribute-escaping for a large document).
        // sandbox WITHOUT allow-same-origin → opaque (null) origin: the page cannot
        // touch the host GUI, and the injected CSP gives it no network at all. Data
        // reads go through the parent's read-only postMessage broker.
        html +=
          '<iframe id="html-file-frame" class="html-frame" title="HTML file"' +
          ' sandbox="allow-scripts"></iframe>';
      } else if (isImageFile(row) && viewable) {
        html += '<img src="' + blobUrl + '" alt="' + escapeHtml(row.original_name || 'image') + '">';
      } else if (mime === 'application/pdf' && viewable) {
        html += '<iframe src="' + blobUrl + '" title="PDF preview"></iframe>';
      } else if (row.extracted_text && MD_MIMES.indexOf(mime) >= 0) {
        html += '<div class="md-body">' + mdRender(String(row.extracted_text).slice(0, 40000)) + '</div>';
      } else if (row.extracted_text) {
        html += '<pre>' + escapeHtml(String(row.extracted_text).slice(0, 20000)) + '</pre>';
      } else {
        html += '<div class="file-unsupported">No inline preview for this file type' +
          (mime ? ' (' + escapeHtml(mime) + ')' : '') + '.</div>';
      }
      // Action affordances — see fileActions. A non-inline file with bytes
      // (office doc, audio, video, an S3-only file) is downloadable; local bytes
      // also open in Finder when local-open is on.
      var acts = fileActions(row, state.localOpen);
      if (acts.open || acts.download) {
        html += '<div class="file-actions">' +
          (acts.open ? '<button class="btn" id="file-open">Open in Finder</button>' : '') +
          (acts.download ? '<a class="btn" href="' + blobUrl + '" download="' + escapeHtml(row.original_name || 'file') + '">Download</a>' : '') +
        '</div>';
      }
      host.innerHTML = html;
      if (isHtmlFile) {
        // Install the read-only data broker (once) and set the frame content as a
        // property (no attribute-escaping needed). Re-runs on every re-render, so a
        // chat edit that rewrites this row's extracted_text reloads the frame with
        // the new page in place — no page refresh.
        installHtmlFileBroker();
        var frame = document.getElementById('html-file-frame');
        if (frame) frame.srcdoc = htmlFileSrcdoc(row.extracted_text);
      }
      var openBtn = document.getElementById('file-open');
      if (openBtn) openBtn.addEventListener('click', function () {
        fetch('/api/files/' + encodeURIComponent(id) + '/open-in-finder', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.enabled === false) {
              var localPath = row.ref_kind === 'local_ref' ? row.ref_uri : null;
              if (localPath && navigator.clipboard) {
                navigator.clipboard.writeText(localPath).then(function () {
                  showToast('Path copied — set LATTICE_LOCAL_OPEN=1 to open directly', {});
                });
              } else {
                showToast('Set LATTICE_LOCAL_OPEN=1 to open files locally', {});
              }
            } else if (j && j.opened === false) {
              showToast('Could not open: ' + (j.error || 'unknown'), {});
            }
          })
          .catch(function (e) { showToast('Open failed: ' + e.message, {}); });
      });
    }

    // Detail-view row visibility line (2.2). Owner: status + everyone/private
    // toggle + a "Specific people…" / "Manage access" control that opens the
    // grants checklist (the table view's "open to manage" affordance lands
    // here). Non-owner: read-only status.
    function detailVisLineEl(row) {
      var a = row._access;
      if (!a) return '';
      var vis = effectiveVisibility(a);
      var labelMap = { everyone: 'Visible to everyone', private: 'Private to you', custom: 'Shared with specific people' };
      // Clear visual indicator: a lock when private, an eye when shared (everyone
      // or specific people), with a hover tooltip. The shared helper keeps the
      // .detail-vis-icon class (existing tint) and adds the title tooltip.
      var visIcon = visIndicator(a, 'detail-vis-icon');
      if (!a.ownedByMe) {
        var seen = vis === 'custom' ? 'Shared with you' : (labelMap[vis] || '');
        return '<div class="detail-vis muted" style="display:flex;align-items:center;gap:6px;margin:6px 0;font-size:13px">' +
          visIcon + '<span>' + escapeHtml(seen) + '</span></div>';
      }
      var info = visInfoLabel(a);
      var buttons;
      if (vis === 'custom') {
        // Leaving custom stops the grant list from applying — the toggle
        // handler asks for confirmation. The grants themselves are kept
        // server-side, so reopening "Manage access" restores the list.
        buttons = '<button class="btn" id="detail-vis-manage">Manage access</button>' +
          '<button class="btn" id="detail-vis-toggle" data-vis-cur="custom" data-vis-next="everyone">Share with everyone</button>';
      } else {
        var btnLabel = vis === 'everyone' ? 'Make private' : 'Share with everyone';
        var next = vis === 'everyone' ? 'private' : 'everyone';
        buttons = '<button class="btn" id="detail-vis-toggle" data-vis-cur="' + vis + '" data-vis-next="' + next + '">' + btnLabel + '</button>' +
          '<button class="btn" id="detail-vis-manage">Specific people…</button>';
      }
      return '<div class="detail-vis" style="display:flex;align-items:center;gap:8px;margin:6px 0;font-size:13px;flex-wrap:wrap">' +
        visIcon +
        '<span class="muted" id="detail-vis-info">' + escapeHtml(info) + '</span>' + buttons +
        '</div>' +
        '<div class="grants-panel" id="grants-panel" hidden></div>';
    }

    // Wire the per-row sharing controls produced by detailVisLineEl. Shared by the
    // advanced detail view AND the simple fs-item view, so per-object sharing is
    // reachable in both. reRender re-paints the caller's view after a toggle.
    function wireRowSharing(content, tableName, id, row, reRender) {
      function postVisibility(next) {
        return fetchJson('/api/cloud/share', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ table: tableName, pk: id, visibility: next }),
        });
      }
      var detailVisBtn = content.querySelector('#detail-vis-toggle');
      if (detailVisBtn) detailVisBtn.addEventListener('click', function () {
        var cur = detailVisBtn.getAttribute('data-vis-cur');
        var next = detailVisBtn.getAttribute('data-vis-next') || (cur === 'everyone' ? 'private' : 'everyone');
        if (cur === 'custom') {
          var cnt = (row._access && row._access.grantees ? row._access.grantees.length : 0);
          var who = cnt === 1 ? '1 specific person' : cnt + ' specific people';
          if (!confirm('This row is shared with ' + who + '. The custom list will stop applying (it is kept and reapplies if you return to specific people). Continue?')) return;
        }
        withBusy(detailVisBtn, function () {
          return postVisibility(next).then(function () {
            invalidate(tableName);
            reRender();
            showToast(next === 'everyone' ? 'Shared with everyone' : 'Made private', {});
          }).catch(function (e) { showToast('Visibility update failed: ' + e.message, {}); });
        });
      });
      var access = row._access || {};

      // Render the staged member checklist + a single "Save sharing" / "Cancel"
      // into the panel. Checkbox toggles mutate ONLY the local desired map —
      // NO network call per toggle (the old design auto-saved live, one POST per
      // checkbox, and each grant's pg_notify collapsed the panel). A single batch
      // request fires on Save. members is the already-fetched list; desired
      // seeds from the row's current grantees (or a caller-supplied staged map
      // when re-opening after a soft re-render).
      function populateGrantsPanel(panel, members, desired) {
        // Snapshot the CURRENT (committed) grantees so Save can diff desired-vs-
        // current into adds/removes. effectiveVisibility decides whether we're
        // actually switching INTO specific-people mode (custom-0 reads as private).
        var current = {};
        (access.grantees || []).forEach(function (g) { current[g] = true; });
        if (members.length === 0) {
          panel.innerHTML = '<div class="muted">No other members in this workspace yet.</div>';
          panel.hidden = false;
          return;
        }
        function dirtyCount() {
          var n = 0;
          members.forEach(function (m) {
            if (!!desired[m.role] !== !!current[m.role]) n++;
          });
          return n;
        }
        function render() {
          var changed = dirtyCount();
          panel.innerHTML = '<div class="grants-title">Who can see this</div>' +
            members.map(function (m) {
              var label = m.name || m.email || m.role;
              return '<label class="grants-row"><input type="checkbox" data-grant-role="' + escapeHtml(m.role) + '"' +
                (desired[m.role] ? ' checked' : '') + '> ' + escapeHtml(label) + '</label>';
            }).join('') +
            '<div class="grants-actions">' +
              '<button class="btn primary" id="grants-save"' + (changed ? '' : ' disabled') + '>Save sharing</button>' +
              '<button class="btn" id="grants-cancel">Cancel</button>' +
              '<span class="grants-dirty muted">' + (changed ? (changed === 1 ? '1 change' : changed + ' changes') : 'No changes') + '</span>' +
            '</div>';
          panel.querySelectorAll('[data-grant-role]').forEach(function (cb) {
            cb.addEventListener('change', function () {
              var role = cb.getAttribute('data-grant-role');
              if (cb.checked) desired[role] = true; else delete desired[role];
              render(); // re-render to refresh the dirty indicator + Save state
            });
          });
          var cancelBtn = panel.querySelector('#grants-cancel');
          if (cancelBtn) cancelBtn.addEventListener('click', function () { closeGrantsPanel(panel); });
          var saveBtn = panel.querySelector('#grants-save');
          if (saveBtn) saveBtn.addEventListener('click', function () {
            var toAdd = [];
            var toRemove = [];
            members.forEach(function (m) {
              var want = !!desired[m.role];
              var have = !!current[m.role];
              if (want && !have) toAdd.push(m.role);
              if (!want && have) toRemove.push(m.role);
            });
            if (toAdd.length === 0 && toRemove.length === 0) { closeGrantsPanel(panel); return; }
            // Confirm the mode change ONCE, here — only when actually switching
            // INTO specific-people mode (effective vis isn't already custom AND we
            // are adding at least one grantee). Never per checkbox.
            if (effectiveVisibility(access) !== 'custom' && toAdd.length > 0) {
              if (!confirm('Sharing this with specific people switches it off "everyone"/"private". The chosen people will be able to see it. Continue?')) return;
            }
            withBusy(saveBtn, function () {
              return fetchJson('/api/cloud/row-grants', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ table: tableName, pk: id, grant: toAdd, revoke: toRemove }),
              }).then(function () {
                // Mirror the committed state locally so the re-render's indicator
                // is correct. The first grant flips the row to custom server-side;
                // revoking the last leaves custom-0, which effectiveVisibility
                // renders as private.
                var list = [];
                members.forEach(function (m) { if (desired[m.role]) list.push(m.role); });
                access.grantees = list;
                if (list.length > 0) access.visibility = 'custom';
                openGrantsPanel = null; // a successful save closes the staging session
                invalidate(tableName);
                showToast('Sharing updated', {});
                reRender();
              }).catch(function (e) {
                // Surface loudly + leave the staged selection intact so the user
                // can retry; no silent partial-success.
                showToast('Sharing update failed: ' + e.message, {});
              });
            });
          });
          panel.hidden = false;
        }
        render();
      }

      function closeGrantsPanel(panel) {
        if (panel) panel.hidden = true;
        openGrantsPanel = null;
      }

      // Open (or toggle shut) the manage-access panel. Fetches the member list,
      // then stages from the row's current grantees. Opening must NOT pre-flip
      // the row to 'custom' — that left a never-shared row stuck at "custom (0)".
      function openManagePanel(triggerBtn) {
        var panel = content.querySelector('#grants-panel');
        if (!panel) return;
        if (!panel.hidden) { closeGrantsPanel(panel); return; }
        withBusy(triggerBtn, function () {
          return fetchJson('/api/cloud/members').then(function (d) {
            // The grant target is a member ROLE: lattice_grant_row keys on the
            // role, and _access.grantees holds role names. List every member
            // except the owner (you don't grant the owner their own row).
            var members = ((d && d.members) || []).filter(function (m) { return !m.isYou && m.status !== 'owner'; });
            var desired = {};
            (access.grantees || []).forEach(function (g) { desired[g] = true; });
            openGrantsPanel = { table: tableName, pk: id };
            populateGrantsPanel(panel, members, desired);
          }).catch(function (e) { showToast('Could not load members: ' + e.message, {}); });
        });
      }

      var detailVisManage = content.querySelector('#detail-vis-manage');
      if (detailVisManage) detailVisManage.addEventListener('click', function () {
        openManagePanel(detailVisManage);
      });

      // Preserve an open panel across a soft re-render: if the tracked panel
      // matches the row this view just repainted, re-open it and re-populate the
      // checklist from the freshly-fetched row._access WITHOUT any network call,
      // so a concurrent edit by another client doesn't lose a staged selection.
      if (openGrantsPanel && openGrantsPanel.table === tableName && openGrantsPanel.pk === id) {
        var rpanel = content.querySelector('#grants-panel');
        if (rpanel) {
          fetchJson('/api/cloud/members').then(function (d) {
            // Only re-populate if THIS panel is still the tracked-open one (a
            // newer navigation/save may have cleared it while members loaded).
            if (!openGrantsPanel || openGrantsPanel.table !== tableName || openGrantsPanel.pk !== id) return;
            var members = ((d && d.members) || []).filter(function (m) { return !m.isYou && m.status !== 'owner'; });
            var desired = {};
            (access.grantees || []).forEach(function (g) { desired[g] = true; });
            populateGrantsPanel(rpanel, members, desired);
          }).catch(function () { /* best-effort restore; a click reopens it */ });
        }
      }
    }
    function renderDetail(content, tableName, id) {
      var myGen = renderGen;
      var t = tableByName(tableName);
      if (!t) {
        // The entity/table was removed (e.g. the assistant dropped it) — return to
        // the dashboard rather than painting a dead "Unknown entity" view.
        location.hash = '#/';
        return;
      }
      var d = displayFor(tableName);
      var intrinsic = intrinsicColumns(t);
      var belongsTo = belongsToColumns(t);
      var junctions = junctionsFor(tableName);

      var fetches = [
        fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id)),
      ];
      belongsTo.forEach(function (b) { fetches.push(loadAllRows(b.rel.table)); });
      junctions.forEach(function (j) {
        fetches.push(loadAllRows(j.junction));
        fetches.push(loadAllRows(j.remoteRel.table));
      });

      Promise.all(fetches).then(function (results) {
        if (myGen !== renderGen) return; // superseded by a newer navigation
        var row = results[0];

        // The open record was deleted out from under the view (assistant, another
        // client, or a hard delete) — don't repaint a tombstone. Fall back to the
        // parent table, unless the user is intentionally browsing this table's trash.
        if (!row || (row.deleted_at && tableViewMode[tableName] !== 'trash')) {
          location.hash = '#/objects/' + encodeURIComponent(tableName);
          return;
        }

        function paint(editing) {
          var rows = [];
          intrinsic.forEach(function (c) {
            var secret = isSecretColumn(tableName, c) || looksEncrypted(row[c]);
            var dd;
            if (editing) {
              dd = fieldFor(c, row[c], t);
            } else if (row[c] == null || row[c] === '') {
              dd = '<span class="muted">—</span>';
            } else if (secret) {
              dd = '<span class="muted">' + SECRET_MASK + '</span>';
            } else {
              dd = escapeHtml(row[c]);
            }
            rows.push('<dt' + titleAttr(colDesc(tableName, c)) + '>' + escapeHtml(fieldLabel(c)) + '</dt><dd>' + dd + '</dd>');
          });
          belongsTo.forEach(function (b) {
            var dd;
            if (editing) {
              dd = fieldFor(b.rel.foreignKey, row[b.rel.foreignKey], t);
            } else {
              var ref = (loadedTables[b.rel.table] || []).find(function (x) { return x.id === row[b.rel.foreignKey]; });
              dd = chipLink(b.rel.table, ref);
            }
            rows.push('<dt>' + escapeHtml(titleCase(b.relName)) + '</dt><dd>' + dd + '</dd>');
          });
          // Junctions: always editable inline. Click × on a chip to unlink,
          // pick from the dropdown to link. Mutations are atomic — no Save.
          junctions.forEach(function (j) {
            var matches = (loadedTables[j.junction] || []).filter(function (jr) { return jr[j.localFk] === row.id; });
            var linkedIds = new Set(matches.map(function (m) { return m[j.remoteRel.foreignKey]; }));
            var available = (loadedTables[j.remoteRel.table] || []).filter(function (o) { return !linkedIds.has(o.id); });
            var chips = matches.map(function (jr) {
              var remoteId = jr[j.remoteRel.foreignKey];
              var ref = (loadedTables[j.remoteRel.table] || []).find(function (x) { return x.id === remoteId; });
              if (!ref) return '';
              return '<span class="chip-removable"' +
                ' data-junction="' + escapeHtml(j.junction) + '"' +
                ' data-localfk="' + escapeHtml(j.localFk) + '"' +
                ' data-remotefk="' + escapeHtml(j.remoteRel.foreignKey) + '"' +
                ' data-local="' + escapeHtml(row.id) + '"' +
                ' data-remote="' + escapeHtml(remoteId) + '">' +
                '<a class="chip-link" href="#/objects/' + encodeURIComponent(j.remoteRel.table) +
                  '/' + encodeURIComponent(remoteId) + '">' + escapeHtml(displayNameFor(ref)) + '</a>' +
                ' <button class="remove-link" title="Unlink">×</button></span>';
            }).join(' ');
            var picker = available.length
              ? '<select class="dm-add"' +
                  ' data-junction="' + escapeHtml(j.junction) + '"' +
                  ' data-localfk="' + escapeHtml(j.localFk) + '"' +
                  ' data-remotefk="' + escapeHtml(j.remoteRel.foreignKey) + '"' +
                  ' data-local="' + escapeHtml(row.id) + '">' +
                '<option value="">+ Add link…</option>' +
                available.map(function (o) {
                  return '<option value="' + escapeHtml(o.id) + '">' + escapeHtml(displayNameFor(o)) + '</option>';
                }).join('') +
                '</select>'
              : '';
            rows.push('<dt>' + escapeHtml(titleCase(j.remoteRel.table)) + '</dt>' +
                      '<dd>' + (chips || '<span class="muted">None yet</span>') + ' ' + picker + '</dd>');
          });

          var actions = editing
            ? '<button class="btn primary" id="save-row">Save</button>' +
              '<button class="btn" id="cancel-edit">Cancel</button>'
            : '<button class="btn" id="edit-row">Edit</button>' +
              '<button class="btn danger" id="del-row">Delete</button>';

          content.innerHTML =
            '<a class="breadcrumb" href="#/objects/' + tableName + '">← ' + escapeHtml(d.label) + '</a>' +
            '<div class="view-header">' +
              '<span class="entity-icon">' + d.icon + '</span>' +
              '<h1>' + escapeHtml(displayNameFor(row) || d.label) + '</h1>' +
              '<div class="actions">' + actions + '</div>' +
            '</div>' +
            detailVisLineEl(row) +
            lastEditedLineEl(tableName, id) +
            (tableName === 'files' ? '<div class="file-preview" id="file-preview"></div>' : '') +
            '<div class="detail"><dl class="' + (editing ? 'editing' : '') + '">' + rows.join('') + '</dl></div>' +
            '<div id="row-context"></div>' +
            (editing ? '' : '<div id="row-provenance"></div>');

          // Seed "last edited by" for this table (cloud only; no-op locally).
          if (!editing) seedLastEdited(tableName);
          // Skip the context fetch while editing — the just-PATCHed row may
          // not have re-rendered yet, so we'd flash stale content.
          if (!editing) loadRowContext(tableName, id);
          // Collapsed, lazy-loaded "Data provenance" panel for this row.
          if (!editing) renderProvenancePanel(content.querySelector('#row-provenance'), tableName, id);
          if (!editing && tableName === 'files') renderFilePreview(row);

          // Per-row sharing controls (shared with the simple fs-item view).
          wireRowSharing(content, tableName, id, row, function () {
            renderDetail(content, tableName, id);
          });

          // Junction link/unlink handlers (active in both read and edit modes).
          content.querySelectorAll('.remove-link').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
              e.preventDefault();
              e.stopPropagation();
              var chip = btn.closest('[data-junction]');
              var body = {};
              body[chip.getAttribute('data-localfk')] = chip.getAttribute('data-local');
              body[chip.getAttribute('data-remotefk')] = chip.getAttribute('data-remote');
              fetchJson('/api/tables/' + encodeURIComponent(chip.getAttribute('data-junction')) + '/unlink', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }).then(function () {
                invalidate(chip.getAttribute('data-junction'));
                return refreshEntities();
              }).then(function () {
                renderDetail(content, tableName, id);
                showToast('Link removed', { undo: undoLast });
              }).catch(function (err) { showToast('Unlink failed: ' + err.message, {}); });
            });
          });
          content.querySelectorAll('select.dm-add').forEach(function (sel) {
            sel.addEventListener('change', function () {
              if (!sel.value) return;
              var body = {};
              body[sel.getAttribute('data-localfk')] = sel.getAttribute('data-local');
              body[sel.getAttribute('data-remotefk')] = sel.value;
              fetchJson('/api/tables/' + encodeURIComponent(sel.getAttribute('data-junction')) + '/link', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }).then(function () {
                invalidate(sel.getAttribute('data-junction'));
                return refreshEntities();
              }).then(function () {
                renderDetail(content, tableName, id);
                showToast('Linked', { undo: undoLast });
              }).catch(function (err) { showToast('Link failed: ' + err.message, {}); });
            });
          });

          if (editing) {
            document.getElementById('cancel-edit').addEventListener('click', function () { paint(false); });
            document.getElementById('save-row').addEventListener('click', function () {
              var values = collectFormValues(content.querySelector('.detail dl'));
              rowWrite('PATCH', '/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id), values).then(function (r) {
                if (r && r.queued) { renderDetail(content, tableName, id); return; }
                invalidate(tableName);
                return refreshEntities().then(function () {
                  renderDetail(content, tableName, id);
                  showToast(d.label.replace(/s$/, '') + ' modified', { undo: undoLast });
                });
              }).catch(function (err) {
                showToast('Save failed: ' + err.message, {});
              });
            });
          } else {
            document.getElementById('edit-row').addEventListener('click', function () { paint(true); });
            document.getElementById('del-row').addEventListener('click', function () {
              rowWrite('DELETE', '/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id), null).then(function (r) {
                if (r && r.queued) { location.hash = '#/objects/' + tableName; return; }
                invalidate(tableName);
                return refreshEntities().then(function () {
                  location.hash = '#/objects/' + tableName;
                  showToast(d.label.replace(/s$/, '') + ' deleted', { undo: undoLast });
                });
              }).catch(function (err) {
                showToast('Delete failed: ' + err.message, {});
              });
            });
          }
        }

        paint(false);
      }).catch(function (err) {
        // A 404 means the row was hard-deleted out from under the view — go to the
        // parent table instead of a dead "Failed" pane. Other errors still surface.
        if (/not found|404|no row|does not exist/i.test(err.message || '')) {
          location.hash = '#/objects/' + encodeURIComponent(tableName);
          return;
        }
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ════════════════════════════════════════════════════════════
    // File-system workspace (default view) + settings drawer
    //
    // The default GUI presents each object as a folder of file/folder
    // tiles; clicking a tile opens an "item view" that renders the row
    // as a document (built from its columns, click-to-edit) plus its
    // relationships as sub-folders you can drill into. The classic
    // row/table editor (renderTable / renderDetail) is preserved behind
    // an "Advanced mode" toggle in the settings drawer.
    // ════════════════════════════════════════════════════════════
    var FS_KEYS = { advanced: 'lattice-advanced-mode' };

    function advancedMode() {
      return window.localStorage.getItem(FS_KEYS.advanced) === '1';
    }
    function setAdvancedMode(on) {
      gaTrack('setting_change', { setting: 'advanced_mode', value: !!on }); // coarse enum + bool
      window.localStorage.setItem(FS_KEYS.advanced, on ? '1' : '0');
      document.body.classList.toggle('advanced-mode', on);
      // Preserve context: map the current location between the file-system
      // (#/fs/…) and the classic (#/objects/…) route families.
      var cur = location.hash || '#/';
      var mapped = mapHashForMode(cur, on);
      renderSidebar();
      if (mapped && mapped !== cur) location.hash = mapped; // triggers hashchange → renderRoute
      // Same-hash advanced-mode toggle re-renders the current pane in place — a
      // soft refresh so it never flashes the loading frame (the data is already
      // loaded; only the display-config changed).
      else renderRoute({ soft: true });
    }

    // Parse "#/fs/a/b/c…" into its decoded segment list (or null).
    function fsParse(hash) {
      var m = /^#\\/fs\\/(.+)$/.exec(hash || '');
      if (!m) return null;
      return m[1].split('/').map(function (s) { return decodeURIComponent(s); });
    }
    // Build a "#/fs/…" hash from a segment list.
    function fsHref(segs) {
      return '#/fs/' + segs.map(function (s) { return encodeURIComponent(s); }).join('/');
    }
    // Resolve the terminal (table, id) of a drill path WITHOUT fetching —
    // relation metadata alone is enough. Used for mode switching.
    function fsTerminal(segs) {
      var table = segs[0];
      var id = null;
      var i = 1;
      while (i < segs.length) {
        id = segs[i]; i++;
        if (i < segs.length) {
          var rel = resolveRelation(table, segs[i]); i++;
          if (!rel) return { table: table, id: id };
          table = rel.targetTable; id = null;
        }
      }
      return { table: table, id: id };
    }
    function mapHashForMode(hash, advanced) {
      if (advanced) {
        var fsegs = fsParse(hash);
        if (!fsegs) return hash;
        var term = fsTerminal(fsegs);
        return term.id
          ? '#/objects/' + encodeURIComponent(term.table) + '/' + encodeURIComponent(term.id)
          : '#/objects/' + encodeURIComponent(term.table);
      }
      var m = /^#\\/objects\\/([^/]+)(?:\\/(.+))?$/.exec(hash);
      if (!m) return hash;
      return m[2]
        ? '#/fs/' + encodeURIComponent(m[1]) + '/' + encodeURIComponent(m[2])
        : '#/fs/' + encodeURIComponent(m[1]);
    }

    // A human label for one row: first non-empty title-ish column; failing that
    // a short snippet of a body/description field; failing that a short id.
    function fsDisplayName(row) {
      if (!row) return '';
      var primary = row.name || row.title || row.label || row.original_name || row.subject;
      if (primary) return String(primary);
      var secondary = row.summary || row.description || row.body || row.content || row.url;
      if (secondary) return truncate(String(secondary).replace(/\\s+/g, ' '), 60);
      // No conventional label column — fall back to the first meaningful cell
      // value (skip id / timestamp / foreign-key columns) so an inferred entity
      // still reads as something human, not a bare #id. Mirrors the server's
      // rowLabel() so a card and its activity-feed bubble agree.
      for (var k in row) {
        if (!Object.prototype.hasOwnProperty.call(row, k)) continue;
        if (k === 'id' || /_id$|_at$/.test(k)) continue;
        var v = row[k];
        if (typeof v === 'number') return String(v);
        if (typeof v === 'string' && v.trim()) return truncate(v.trim().replace(/\\s+/g, ' '), 60);
      }
      return row.id ? '#' + String(row.id).slice(0, 8) : '(untitled)';
    }
    // File-type glyph for native files-entity rows.
    function fileEmoji(row) {
      var m = (row && row.mime) || '';
      if (m === 'text/html' && row && row.artifact_type === 'html') return '🌐';
      if (m.indexOf('image/') === 0) return '🖼️';
      if (m === 'application/pdf') return '📕';
      if (MD_MIMES.indexOf(m) >= 0 || m.indexOf('text/') === 0) return '📝';
      return '📄';
    }

    // The navigable "sub-folder" relations of a table: reverse-1:N (other
    // entities that belongsTo this one) + many-to-many (junctions). Forward
    // belongsTo relations are NOT folders — they render as inline parent links.
    function fsRelations(tableName) {
      var out = [];
      var tables = (state.entities && state.entities.tables) || [];
      // Reverse 1:N — non-junction tables with a belongsTo pointing here.
      tables.forEach(function (t) {
        if (isJunction(t)) return;
        var belongs = Object.entries(t.relations || {}).filter(function (kv) {
          return kv[1].type === 'belongsTo' && kv[1].table === tableName;
        });
        belongs.forEach(function (kv) {
          var rel = kv[1];
          // Disambiguate when one source table points here more than once.
          var token = belongs.length > 1 ? (t.name + '~' + rel.foreignKey) : t.name;
          var label = displayFor(t.name).label + (belongs.length > 1 ? ' (' + titleCase(kv[0]) + ')' : '');
          out.push({ token: token, label: label, kind: 'hasMany', targetTable: t.name, foreignKey: rel.foreignKey });
        });
      });
      // Many-to-many — junctions where this table is one side.
      junctionsFor(tableName).forEach(function (j) {
        out.push({
          token: j.junction, label: displayFor(j.remoteRel.table).label, kind: 'm2m',
          targetTable: j.remoteRel.table, junction: j.junction, localFk: j.localFk, remoteRel: j.remoteRel,
        });
      });
      return out;
    }
    function resolveRelation(tableName, token) {
      return fsRelations(tableName).find(function (r) { return r.token === token; }) || null;
    }
    // Resolve the rows on the far side of a relation for one parent row.
    function fsRelatedRows(parentTable, parentRow, rel) {
      if (rel.kind === 'hasMany') {
        return loadAllRows(rel.targetTable).then(function (rows) {
          return rows.filter(function (r) { return r[rel.foreignKey] === parentRow.id; });
        });
      }
      return Promise.all([loadAllRows(rel.junction), loadAllRows(rel.targetTable)]).then(function (res) {
        var jrows = res[0], targets = res[1];
        var ids = {};
        jrows.forEach(function (jr) {
          if (jr[rel.localFk] === parentRow.id) ids[jr[rel.remoteRel.foreignKey]] = true;
        });
        return targets.filter(function (x) { return ids[x.id]; });
      });
    }

    // Walk a drill path, fetching each (table,id) node row and resolving each
    // relation token. Returns an ordered crumb list: 'node' crumbs (a row) and
    // 'rel' crumbs (a relation from the preceding node).
    function fsWalk(segs) {
      var crumbs = [];
      var table = segs[0];
      var i = 1;
      function step() {
        if (i >= segs.length) return Promise.resolve();
        var id = segs[i]; i++;
        return fetchJson('/api/tables/' + encodeURIComponent(table) + '/rows/' + encodeURIComponent(id)).then(function (row) {
          crumbs.push({ type: 'node', table: table, id: id, row: row });
          if (i >= segs.length) return;
          var relToken = segs[i]; i++;
          var rel = resolveRelation(table, relToken);
          if (!rel) throw new Error('Unknown relation "' + relToken + '" on ' + table);
          crumbs.push({ type: 'rel', parentTable: table, parentId: id, parentRow: row, relToken: relToken, rel: rel });
          table = rel.targetTable;
          return step();
        });
      }
      return step().then(function () { return crumbs; });
    }

    function fsBreadcrumb(segs, crumbs) {
      var parts = ['<a href="#/">Home</a>'];
      var t0 = segs[0];
      var prefix = '#/fs/' + encodeURIComponent(t0);
      parts.push('<a href="' + prefix + '">' + escapeHtml(displayFor(t0).label) + '</a>');
      (crumbs || []).forEach(function (c) {
        if (c.type === 'node') {
          prefix += '/' + encodeURIComponent(c.id);
          parts.push('<a href="' + prefix + '">' + escapeHtml(fsDisplayName(c.row)) + '</a>');
        } else {
          prefix += '/' + encodeURIComponent(c.relToken);
          parts.push('<a href="' + prefix + '">' + escapeHtml(c.rel.label) + '</a>');
        }
      });
      return '<nav class="fs-crumbs">' + parts.join('<span class="fs-sep">▸</span>') + '</nav>';
    }

    // Columns never offered for click-to-edit (identity / system / file-binary).
    var READONLY_COLS = ['id', 'created_at', 'updated_at', 'deleted_at', 'original_name',
      'mime', 'size_bytes', 'path', 'blob_path', 'extracted_text', 'extraction_status'];
    // Columns rendered as formatted markdown (also any value containing newlines).
    var FS_LONGFORM = ['body', 'summary', 'transcript', 'description', 'bio', 'notes',
      'content', 'text', 'abstract', 'review', 'message'];

    function fsIsReadonly(table, col) {
      return READONLY_COLS.indexOf(col) >= 0 || isSecretColumn(table, col);
    }
    // The rendered (display) HTML for a single value — markdown for long-form
    // fields, masked for secrets, plain otherwise.
    function fsValInner(table, row, col) {
      var raw = row[col];
      if (raw == null || raw === '') return '<span class="fs-empty-val">—</span>';
      if (isSecretColumn(table, col) || looksEncrypted(raw)) return '<span class="muted">' + SECRET_MASK + '</span>';
      var s = String(raw);
      if (FS_LONGFORM.indexOf(col) >= 0 || s.indexOf('\\n') >= 0) {
        return '<div class="md-body">' + mdToHtml(s.slice(0, 40000)) + '</div>';
      }
      return escapeHtml(s);
    }
    function fsFieldHtml(table, row, col) {
      var ro = fsIsReadonly(table, col);
      var cls = 'fs-field-val' + (ro ? ' readonly' : ' ce');
      var attr = ro ? '' : ' data-col="' + escapeHtml(col) + '" title="Click to edit"';
      return '<div class="fs-field"><div class="fs-field-label"' + titleAttr(colDesc(table, col)) + '>' + escapeHtml(fieldLabel(col)) + '</div>' +
        '<div class="' + cls + '"' + attr + '>' + fsValInner(table, row, col) + '</div></div>';
    }

    // Per-object view mode for the top-level object page: 'graph' (default — a
    // focused zoom-in of the brain graph) or 'list' (the tile grid).
    var fsObjectView = {};
    // Collection view — a folder of tiles. Top-level (#/fs/<table>) shows every
    // row; a nested path (#/fs/<table>/<id>/<rel>) shows the related rows.
    function renderFsCollection(content, segs) {
      var myGen = renderGen;
      clearUnseen(segs[0]);
      var topLevel = segs.length === 1;
      // The top-level object page defaults to the data-provenance view (graph or
      // table — how this object's rows are sourced); "List view" switches to the
      // row tile grid. Nested relation paths always use the grid.
      if (topLevel && fsObjectView[segs[0]] !== 'list' && tableByName(segs[0])) {
        renderProvenance(content, segs[0], provenanceView[segs[0]] || 'graph');
        return;
      }
      var crumbsP = topLevel ? Promise.resolve([]) : fsWalk(segs);
      crumbsP.then(function (crumbs) {
        var table, rowsP;
        if (topLevel) {
          table = segs[0];
          if (!tableByName(table)) {
            setContent(content, myGen, '<div class="placeholder">Unknown entity: ' + escapeHtml(table) + '</div>');
            return;
          }
          rowsP = fetchRows(table, '');
        } else {
          var last = crumbs[crumbs.length - 1];
          if (!last || last.type !== 'rel') throw new Error('Bad collection path');
          table = last.rel.targetTable;
          rowsP = fsRelatedRows(last.parentTable, last.parentRow, last.rel);
        }
        return rowsP.then(function (rows) {
          if (myGen !== renderGen) return; // superseded by a newer navigation
          var d = displayFor(table);
          var base = fsHref(segs);
          var rowTiles = rows.length
            ? rows.map(function (r) {
                var icon = (table === 'files') ? fileEmoji(r) : '📁';
                // Per-row privacy indicator in the tile corner (lock = private, eye
                // = shared); '' on a local workspace (no _access). Same component +
                // tooltip as the entity-detail header.
                return '<a class="fs-tile" href="' + base + '/' + encodeURIComponent(r.id) + '">' +
                  visIndicator(r._access, 'fs-tile-vis') +
                  '<div class="fs-tile-icon">' + icon + '</div>' +
                  '<div class="fs-tile-label">' + escapeHtml(fsDisplayName(r)) + '</div>' +
                '</a>';
              }).join('')
            : (topLevel ? '' : '<div class="fs-empty">Nothing here yet.</div>');
          content.innerHTML =
            fsBreadcrumb(segs, crumbs) +
            '<div class="view-header">' +
              '<span class="entity-icon">' + d.icon + '</span>' +
              '<h1>' + escapeHtml(d.label) + '</h1>' +
              '<span class="count">' + rows.length + ' item' + (rows.length === 1 ? '' : 's') + '</span>' +
              (topLevel
                ? '<div class="actions">' +
                    '<a class="btn primary" href="' + fsHref([table, 'new']) + '">New ' + escapeHtml(d.label) + '</a>' +
                    '<button class="btn" id="fsg-view-graph" type="button">Provenance</button>' +
                  '</div>'
                : '') +
            '</div>' +
            '<div class="fs-grid">' + rowTiles + '</div>';
          var gv = content.querySelector('#fsg-view-graph');
          if (gv) gv.addEventListener('click', function () {
            fsObjectView[table] = 'graph';
            renderFsCollection(content, segs);
          });
        });
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ── Object page as a focused graph ──────────────────────────────────────
    // A zoom-in of the brain graph centered on ONE object: the object node in the
    // middle, its entity rows around it (bounded for egress safety), and its
    // related objects on the rim. Click an entity → open its tab; click a related
    // → zoom into THAT object's graph. Reuses forceLayout + the graph CSS.
    var FS_GRAPH_ROW_CAP = 50;
    var FS_GRAPH_ROW_MAX = 250; // hard ceiling for "Show more"
    var fsGraphCap = {}; // per-table cap override when the user clicks "Show more"
    function renderFsObjectGraph(content, table) {
      // Files are special: their object page is the on-disk FOLDER hierarchy
      // (roots + loose files, drillable), not a flat list of file rows.
      if (table === 'files') { renderFilesRootView(content); return; }
      var myGen = renderGen;
      clearUnseen(table);
      var t = tableByName(table);
      var d = displayFor(table);
      var cap = fsGraphCap[table] || FS_GRAPH_ROW_CAP;
      var total = (t && t.rowCount != null) ? t.rowCount : 0;
      // Build the whole view AFTER the bounded fetch (mirrors renderFsCollection):
      // on a hard nav the router shows its loading frame while this is in flight;
      // on a soft (live) refresh the existing graph stays on screen until the new
      // one is ready, so the pane never flashes a loading frame.
      //
      // Bounded, egress-safe fetch: only the capped number of rows, with the heavy
      // text columns projected out (never load a whole table onto a hot path). The
      // total comes from the cached entity meta, so there is no count query.
      fetchJson('/api/tables/' + encodeURIComponent(table) + '/rows?limit=' + cap +
        '&exclude=' + encodeURIComponent('extracted_text,description'))
        .then(function (resp) {
          if (myGen !== renderGen) return;
          // No setTabTitle — object pages share the one exploration (graph) tab,
          // which stays labeled "Brain Graph"; the breadcrumb shows the location.
          var rows = (resp && resp.rows) || [];
          var model = buildObjectGraphModel(table, d, t, rows);
          var header =
            fsBreadcrumb([table], []) +
            '<div class="view-header">' +
              '<span class="entity-icon">' + d.icon + '</span>' +
              '<h1>' + escapeHtml(d.label) + '</h1>' +
              '<span class="count">' + total + ' item' + (total === 1 ? '' : 's') + '</span>' +
              '<div class="actions">' +
                '<a class="btn" href="' + fsHref([table, 'new']) + '">+ New ' + escapeHtml(d.label) + '</a>' +
                '<button class="btn" id="fsg-view-list" type="button">List view</button>' +
              '</div>' +
            '</div>';
          if (!rows.length && model.nodes.length <= 1) {
            content.innerHTML = header +
              '<div class="brain-graph object-graph"><div id="fsg-mount">' +
                '<div class="fs-empty" style="padding:24px">Nothing here yet. ' +
                '<a href="' + fsHref([table, 'new']) + '">Create the first ' + escapeHtml(d.label) + '</a>.</div>' +
              '</div></div>';
          } else {
            forceLayout(model.nodes, model.links, 360);
            content.innerHTML = header +
              '<div class="brain-graph object-graph"><div id="fsg-mount">' + objectGraphSvg(model) + '</div></div>';
            var mount = document.getElementById('fsg-mount');
            if (mount) {
              wireObjectGraph(mount, model, table);
              var hidden = (total || rows.length) - rows.length;
              if (hidden > 0 && cap < FS_GRAPH_ROW_MAX) {
                var more = document.createElement('button');
                more.className = 'btn fsg-more';
                more.type = 'button';
                more.textContent = 'Show more (' + rows.length + ' of ' + total + ')';
                more.addEventListener('click', function () {
                  fsGraphCap[table] = Math.min(FS_GRAPH_ROW_MAX, cap + FS_GRAPH_ROW_CAP);
                  renderFsObjectGraph(content, table);
                });
                mount.appendChild(more);
              }
            }
          }
          var lv = content.querySelector('#fsg-view-list');
          if (lv) lv.addEventListener('click', function () {
            fsObjectView[table] = 'list';
            renderFsCollection(content, [table]);
          });
        })
        .catch(function (err) {
          if (myGen !== renderGen) return;
          content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
        });
    }

    // Build the focused-graph model: center object + entity rows + related-object
    // rim nodes (deduped; only related objects that have rows). Links connect the
    // center to each node.
    function buildObjectGraphModel(table, d, t, rows) {
      var byName = {};
      ((state.entities && state.entities.tables) || []).forEach(function (e) { byName[e.name] = e; });
      var nodes = [{ kind: 'object', name: table, label: d.label, icon: d.icon, r: 26, x: 0, y: 0, vx: 0, vy: 0 }];
      var links = [];
      rows.forEach(function (row) {
        var idx = nodes.length;
        nodes.push({
          kind: 'entity', id: row.id, label: fsDisplayName(row) || '(untitled)',
          icon: (table === 'files') ? fileEmoji(row) : '', r: 13, x: 0, y: 0, vx: 0, vy: 0,
        });
        links.push({ si: 0, ti: idx });
      });
      var rim = {};
      fsRelations(table).forEach(function (r) { if (r.targetTable) rim[r.targetTable] = true; });
      belongsToColumns(t || { relations: {} }).forEach(function (b) { if (b.rel && b.rel.table) rim[b.rel.table] = true; });
      delete rim[table];
      Object.keys(rim).forEach(function (rt) {
        var rc = (byName[rt] && byName[rt].rowCount != null) ? byName[rt].rowCount : 0;
        if (rc <= 0) return; // only related objects that actually have rows
        var idx = nodes.length;
        nodes.push({ kind: 'related', name: rt, label: displayFor(rt).label, icon: displayFor(rt).icon, r: 19, x: 0, y: 0, vx: 0, vy: 0 });
        links.push({ si: 0, ti: idx });
      });
      return { nodes: nodes, links: links };
    }

    function objectGraphSvg(model) {
      var nodes = model.nodes, links = model.links;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      nodes.forEach(function (nd) {
        minX = Math.min(minX, nd.x - nd.r); minY = Math.min(minY, nd.y - nd.r);
        maxX = Math.max(maxX, nd.x + nd.r); maxY = Math.max(maxY, nd.y + nd.r);
      });
      var pad = 50;
      var vb = [minX - pad, minY - pad, (maxX - minX) + 2 * pad, (maxY - minY) + 2 * pad];
      var edgeSvg = links.map(function (l) {
        var a = nodes[l.si], b = nodes[l.ti];
        return '<line class="dm-edge" data-si="' + l.si + '" data-ti="' + l.ti + '" x1="' + a.x.toFixed(1) +
          '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) +
          '" stroke="#3b82f6" stroke-width="1.4" opacity="0.5"></line>';
      }).join('');
      var nodeSvg = nodes.map(function (nd, i) {
        var label = nd.label.length > 22 ? nd.label.slice(0, 21) + '…' : nd.label;
        var attr = nd.kind === 'entity' ? (' data-kind="entity" data-id="' + escapeHtml(String(nd.id)) + '"')
          : nd.kind === 'related' ? (' data-kind="related" data-table="' + escapeHtml(nd.name) + '"')
          : nd.kind === 'folder' ? (' data-kind="folder" data-path="' + escapeHtml(String(nd.path)) + '"')
          : nd.kind === 'file' ? (' data-kind="file" data-path="' + escapeHtml(String(nd.path || '')) + '" data-id="' + escapeHtml(String(nd.id || '')) + '"')
          : ' data-kind="object"';
        var iconSvg = nd.icon
          ? '<text class="gnode-icon" y="' + (nd.r * 0.34).toFixed(1) + '" text-anchor="middle" font-size="' + (nd.r * 0.9).toFixed(1) + '">' + nd.icon + '</text>'
          : '';
        return '<g class="gnode ognode-' + nd.kind + '" data-i="' + i + '"' + attr +
          ' transform="translate(' + nd.x.toFixed(1) + ',' + nd.y.toFixed(1) + ')">' +
          '<circle class="gnode-glow" r="' + (nd.r + 8).toFixed(1) + '"/>' +
          '<circle class="gnode-dot" r="' + nd.r.toFixed(1) + '"/>' +
          iconSvg +
          '<text class="gnode-label" y="' + (nd.r + 15).toFixed(1) + '" text-anchor="middle">' + escapeHtml(label) + '</text>' +
          '<title>' + escapeHtml(nd.label) + '</title>' +
          '</g>';
      }).join('');
      return '<svg class="dm-graph" viewBox="' + vb.join(' ') + '" preserveAspectRatio="xMidYMid meet">' +
        '<g class="dm-stage">' + edgeSvg + nodeSvg + '</g></svg>';
    }

    function wireObjectGraph(mount, model, table) {
      var svg = mount.querySelector('svg.dm-graph'); if (!svg) return;
      var nodeEls = {};
      mount.querySelectorAll('g.gnode').forEach(function (g) { nodeEls[g.getAttribute('data-i')] = g; });
      var edgeEls = mount.querySelectorAll('line.dm-edge');
      function vb() { return svg.getAttribute('viewBox').split(' ').map(Number); }
      function setVb(a) { svg.setAttribute('viewBox', a.join(' ')); syncGraphLabelScale(svg); }
      var fitVb = vb();
      syncGraphLabelScale(svg);
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(function () { syncGraphLabelScale(svg); }).observe(svg);
      function toData(ev) {
        var rect = svg.getBoundingClientRect(); var b = vb();
        return { x: b[0] + ((ev.clientX - rect.left) / rect.width) * b[2], y: b[1] + ((ev.clientY - rect.top) / rect.height) * b[3] };
      }
      function updateNode(i) {
        var nd = model.nodes[i]; var g = nodeEls[i]; if (!nd || !g) return;
        g.setAttribute('transform', 'translate(' + nd.x.toFixed(1) + ',' + nd.y.toFixed(1) + ')');
        edgeEls.forEach(function (ln) {
          if (ln.getAttribute('data-si') === String(i)) { ln.setAttribute('x1', nd.x.toFixed(1)); ln.setAttribute('y1', nd.y.toFixed(1)); }
          if (ln.getAttribute('data-ti') === String(i)) { ln.setAttribute('x2', nd.x.toFixed(1)); ln.setAttribute('y2', nd.y.toFixed(1)); }
        });
      }
      svg.addEventListener('wheel', function (ev) {
        ev.preventDefault();
        var b = vb(); var pt = toData(ev);
        var dd = Math.max(-50, Math.min(50, ev.deltaY));
        var factor = Math.pow(1.0018, dd);
        var nw = b[2] * factor, nh = b[3] * factor;
        if (nw >= fitVb[2] || nh >= fitVb[3]) { setVb(fitVb.slice()); return; }
        setVb([pt.x - (pt.x - b[0]) * (nw / b[2]), pt.y - (pt.y - b[1]) * (nh / b[3]), nw, nh]);
      }, { passive: false });
      var drag = null;
      svg.addEventListener('pointerdown', function (ev) {
        var g = ev.target.closest && ev.target.closest('g.gnode');
        if (g) drag = { kind: 'node', i: g.getAttribute('data-i'), moved: false };
        else drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vb: vb() };
        svg.setPointerCapture(ev.pointerId);
      });
      svg.addEventListener('pointermove', function (ev) {
        if (!drag) return;
        if (drag.kind === 'node') {
          var pt = toData(ev); var nd = model.nodes[Number(drag.i)];
          if (nd) { nd.x = pt.x; nd.y = pt.y; updateNode(Number(drag.i)); drag.moved = true; }
        } else {
          var rect = svg.getBoundingClientRect(); var b = drag.vb;
          setVb([b[0] - (ev.clientX - drag.sx) * (b[2] / rect.width), b[1] - (ev.clientY - drag.sy) * (b[3] / rect.height), b[2], b[3]]);
        }
      });
      svg.addEventListener('pointerup', function (ev) {
        if (drag && drag.kind === 'node' && !drag.moved) {
          var nd = model.nodes[Number(drag.i)];
          if (nd && nd.kind === 'entity') location.hash = '#/fs/' + encodeURIComponent(table) + '/' + encodeURIComponent(nd.id);
          else if (nd && nd.kind === 'related') location.hash = '#/fs/' + encodeURIComponent(nd.name);
          else if (nd && nd.kind === 'folder') location.hash = '#/folder/' + encodeURIComponent(nd.path);
          else if (nd && nd.kind === 'file') openGraphFile(nd);
        }
        drag = null;
        try { svg.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
      });
    }

    // ── Folder navigation (the Files object's on-disk hierarchy) ─────────────
    // The Files object opens as its folder roots + loose files; drilling into a
    // folder (#/folder/<abs path>) shows that folder's immediate sub-folders +
    // files as graph nodes — click a folder to go deeper, a file to open it. Paths
    // come from the backend platform-native, so handle BOTH "/" and "\\" (Windows).
    function fsBasename(p) {
      var s = String(p || '').replace(/[\\\\/]+$/, ''); // strip trailing separators
      var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\\\'));
      return i >= 0 ? s.slice(i + 1) : s;
    }
    function fsDirname(p) {
      var s = String(p || '');
      var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\\\'));
      if (i < 0) return '';
      if (i === 0) return s.slice(0, 1); // root: keep the leading separator
      return s.slice(0, i);
    }
    // True when child is parent or sits beneath it (separator-aware).
    function fsUnder(child, parent) {
      if (child === parent) return true;
      if (child.indexOf(parent) !== 0) return false;
      var c = child.charAt(parent.length);
      return c === '/' || c === '\\\\';
    }
    function openGraphFile(nd) {
      if (nd.id) { location.hash = '#/fs/files/' + encodeURIComponent(nd.id); return; }
      if (nd.path && typeof openSourceFile === 'function') openSourceFile(nd.path); // ingest-then-open
    }
    // Home ▸ Files ▸ <root> ▸ …folders… [▸ <leafLabel current>]. Folder crumbs link
    // to their #/folder route; leafLabel (a filename) is appended non-linked.
    function folderBreadcrumb(path, roots, leafLabel) {
      var parts = ['<a href="#/graph">Home</a>', '<a href="#/fs/files">Files</a>'];
      var root = null;
      (roots || []).forEach(function (r) {
        if (r.kind !== 'folder') return;
        if (fsUnder(path, r.path) && (!root || r.path.length > root.path.length)) root = r;
      });
      if (root) {
        // Rebuild crumb paths with the SAME native separator the path uses.
        var sep = root.path.indexOf('\\\\') >= 0 ? '\\\\' : '/';
        parts.push('<a href="#/folder/' + encodeURIComponent(root.path) + '">' + escapeHtml(root.name || fsBasename(root.path)) + '</a>');
        var rel = path.slice(root.path.length).replace(/^[\\\\/]+/, '');
        var acc = root.path;
        if (rel) {
          rel.split(/[\\\\/]+/).forEach(function (seg) {
            if (!seg) return;
            acc = acc + sep + seg;
            parts.push('<a href="#/folder/' + encodeURIComponent(acc) + '">' + escapeHtml(seg) + '</a>');
          });
        }
      } else if (!leafLabel) {
        parts.push('<span class="fs-crumb-cur">' + escapeHtml(fsBasename(path)) + '</span>');
      }
      if (leafLabel) parts.push('<span class="fs-crumb-cur">' + escapeHtml(leafLabel) + '</span>');
      return '<nav class="fs-crumbs">' + parts.join('<span class="fs-sep">▸</span>') + '</nav>';
    }
    // center object + folder/file children → graph model (reuses objectGraphSvg).
    function buildFolderGraphModel(centerLabel, entries, filesByPath) {
      var nodes = [{ kind: 'object', name: centerLabel, label: centerLabel, icon: '📂', r: 24, x: 0, y: 0, vx: 0, vy: 0 }];
      var links = [];
      (entries || []).forEach(function (e) {
        var idx = nodes.length;
        if (e.kind === 'folder') {
          nodes.push({ kind: 'folder', path: e.path, label: e.name, icon: '📁', r: 18, x: 0, y: 0, vx: 0, vy: 0 });
        } else {
          var id = e.id || (filesByPath ? filesByPath[e.path] : '') || '';
          nodes.push({ kind: 'file', path: e.path || '', id: id, label: e.name, icon: '📄', r: 12, x: 0, y: 0, vx: 0, vy: 0 });
        }
        links.push({ si: 0, ti: idx });
      });
      return { nodes: nodes, links: links };
    }
    function paintFolderGraph(content, header, name, entries, filesByPath, emptyMsg, listToggle) {
      if (!entries.length) {
        content.innerHTML = header +
          '<div class="brain-graph object-graph"><div id="fsg-mount"><div class="fs-empty" style="padding:24px">' +
          emptyMsg + '</div></div></div>';
      } else {
        var model = buildFolderGraphModel(name, entries, filesByPath || {});
        forceLayout(model.nodes, model.links, 360);
        content.innerHTML = header +
          '<div class="brain-graph object-graph"><div id="fsg-mount">' + objectGraphSvg(model) + '</div></div>';
        var mount = document.getElementById('fsg-mount');
        if (mount) wireObjectGraph(mount, model, 'files');
      }
      if (listToggle) {
        var lv = content.querySelector('#fsg-view-list');
        if (lv) lv.addEventListener('click', function () { fsObjectView['files'] = 'list'; renderFsCollection(content, ['files']); });
      }
    }
    // #/folder/<abs path> — one folder's immediate children as a graph.
    function renderFolderView(content, path) {
      var myGen = renderGen;
      var name = fsBasename(path) || 'Folder';
      // No setTabTitle — folder drilling stays in the shared exploration tab.
      Promise.all([
        fetchJson('/api/sources/list?path=' + encodeURIComponent(path)).catch(function () { return { entries: [] }; }),
        fetchJson('/api/tables/files/rows?limit=500&exclude=' + encodeURIComponent('extracted_text,description')).catch(function () { return { rows: [] }; }),
        fetchJson('/api/sources/roots').catch(function () { return { roots: [] }; }),
      ]).then(function (res) {
        if (myGen !== renderGen) return;
        var entries = (res[0] && res[0].entries) || [];
        var truncated = res[0] && res[0].truncated;
        var filesByPath = {};
        ((res[1] && res[1].rows) || []).forEach(function (r) {
          if (!r.deleted_at && r.ref_kind === 'local_ref' && r.ref_uri) filesByPath[r.ref_uri] = r.id;
        });
        var roots = (res[2] && res[2].roots) || [];
        var header = folderBreadcrumb(path, roots) +
          '<div class="view-header"><span class="entity-icon">📂</span><h1>' + escapeHtml(name) + '</h1>' +
          '<span class="count">' + entries.length + (truncated ? '+' : '') + ' item' + (entries.length === 1 ? '' : 's') + '</span></div>';
        paintFolderGraph(content, header, name, entries, filesByPath, 'This folder is empty.', false);
      }).catch(function (err) {
        if (myGen !== renderGen) return;
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }
    // The Files object page (#/fs/files): the folder roots + loose files.
    function renderFilesRootView(content) {
      var myGen = renderGen;
      // No setTabTitle — the Files object page shares the exploration tab.
      Promise.all([
        fetchJson('/api/sources/roots').catch(function () { return { roots: [] }; }),
        fetchJson('/api/tables/files/rows?limit=500&exclude=' + encodeURIComponent('extracted_text,description')).catch(function () { return { rows: [] }; }),
      ]).then(function (res) {
        if (myGen !== renderGen) return;
        var roots = (res[0] && res[0].roots) || [];
        var rows = ((res[1] && res[1].rows) || []).filter(function (r) { return !r.deleted_at && !r.artifact_type; });
        var folderPaths = roots.filter(function (r) { return r.kind === 'folder'; }).map(function (r) { return r.path; });
        var entries = [];
        roots.forEach(function (r) { if (r.kind === 'folder') entries.push({ kind: 'folder', path: r.path, name: r.name || fsBasename(r.path) }); });
        rows.forEach(function (r) {
          var under = r.ref_uri && folderPaths.some(function (p) { return fsUnder(r.ref_uri, p); });
          if (!under) entries.push({ kind: 'file', path: r.ref_uri || '', name: r.name || r.original_name || 'Untitled', id: r.id });
        });
        var d = displayFor('files');
        var header = fsBreadcrumb(['files'], []) +
          '<div class="view-header"><span class="entity-icon">' + d.icon + '</span><h1>' + escapeHtml(d.label) + '</h1>' +
          '<span class="count">' + entries.length + ' item' + (entries.length === 1 ? '' : 's') + '</span>' +
          '<div class="actions"><button class="btn" id="fsg-view-list" type="button">List view</button></div></div>';
        paintFolderGraph(content, header, 'Files', entries, {}, 'No files yet. Add a folder or file from the sidebar.', true);
      }).catch(function (err) {
        if (myGen !== renderGen) return;
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // Create a new object from the simple view — a form styled like the item
    // page with blank fields + a Save button, plus a select-menu + "+" for each
    // many-to-many link. Reuses fieldFor() (intrinsic + belongsTo) and the
    // existing row-create + junction-row endpoints (no new backend).
    // Inline create view (#/fs/<table>/new) — mirrors renderFsItem's formatted
    // layout (.fs-doc/.fs-field) with blank fields + Save/Cancel, instead of a
    // modal. Reuses fieldFor() + the row-create + junction /link endpoints.
    function renderFsCreate(content, segs) {
      var table = segs[0];
      var t = tableByName(table);
      if (!t) { content.innerHTML = '<div class="placeholder">Unknown entity: ' + escapeHtml(table) + '</div>'; return; }
      var d = displayFor(table);
      var bt = belongsToColumns(t);
      var juncs = junctionsFor(table);
      var collectionHref = fsHref([table]);
      // Preload FK + junction-remote target rows so the <select> menus populate.
      var needed = bt.map(function (b) { return b.rel.table; })
        .concat(juncs.map(function (j) { return j.remoteRel.table; }));
      Promise.all(needed.map(loadAllRows)).then(function () {
        var fieldsHtml = '';
        intrinsicColumns(t).forEach(function (c) {
          fieldsHtml += '<div class="fs-field"><div class="fs-field-label">' + escapeHtml(titleCase(c)) + '</div>' +
            '<div class="fs-field-val">' + fieldFor(c, '', t) + '</div></div>';
        });
        bt.forEach(function (b) {
          fieldsHtml += '<div class="fs-field"><div class="fs-field-label">' + escapeHtml(titleCase(b.relName)) + '</div>' +
            '<div class="fs-field-val">' + fieldFor(b.rel.foreignKey, '', t) + '</div></div>';
        });
        juncs.forEach(function (j) {
          var remoteRows = loadedTables[j.remoteRel.table] || [];
          var opts = '<option value="">(none)</option>' + remoteRows.map(function (r) {
            return '<option value="' + escapeHtml(r.id) + '">' + escapeHtml(displayNameFor(r)) + '</option>';
          }).join('');
          fieldsHtml += '<div class="fs-field"><div class="fs-field-label">' + escapeHtml(titleCase(j.remoteRel.table)) + ' (links)</div>' +
            '<div class="fs-field-val">' +
              '<div class="fs-link-stage" data-junction="' + escapeHtml(j.junction) + '" data-local-fk="' + escapeHtml(j.localFk) + '" data-remote-fk="' + escapeHtml(j.remoteRel.foreignKey) + '">' +
                '<select class="fs-link-select">' + opts + '</select>' +
              '</div>' +
              '<button type="button" class="btn fs-link-add">+ Add another</button>' +
            '</div></div>';
        });
        content.innerHTML =
          '<nav class="fs-crumbs"><a href="#/">Home</a><span class="fs-sep">▸</span>' +
            '<a href="' + collectionHref + '">' + escapeHtml(d.label) + '</a><span class="fs-sep">▸</span>' +
            '<span>New</span></nav>' +
          '<div class="view-header">' +
            '<span class="entity-icon">' + d.icon + '</span>' +
            '<h1>New ' + escapeHtml(d.label) + '</h1>' +
          '</div>' +
          '<div class="fs-doc fs-create-form">' + fieldsHtml + '</div>' +
          '<div class="fs-create-actions">' +
            '<button class="btn" id="fs-create-cancel">Cancel</button>' +
            '<button class="btn primary" id="fs-create-save">Save</button>' +
          '</div>';
        content.querySelectorAll('.fs-link-add').forEach(function (addBtn) {
          addBtn.addEventListener('click', function () {
            var stage = addBtn.previousElementSibling; // the .fs-link-stage
            var firstSel = stage && stage.querySelector('.fs-link-select');
            if (!firstSel) return;
            var clone = firstSel.cloneNode(true);
            clone.value = '';
            stage.appendChild(clone);
          });
        });
        content.querySelector('#fs-create-cancel').addEventListener('click', function () {
          location.hash = collectionHref;
        });
        var saveBtn = content.querySelector('#fs-create-save');
        saveBtn.addEventListener('click', function () {
          var values = {};
          content.querySelectorAll('.fs-create-form [name]').forEach(function (el) {
            var v = el.value;
            if (v !== '' && v != null) values[el.getAttribute('name')] = v;
          });
          var links = [];
          content.querySelectorAll('.fs-link-stage').forEach(function (stage) {
            var junction = stage.getAttribute('data-junction');
            var localFk = stage.getAttribute('data-local-fk');
            var remoteFk = stage.getAttribute('data-remote-fk');
            stage.querySelectorAll('.fs-link-select').forEach(function (sel) {
              if (sel.value) links.push({ junction: junction, localFk: localFk, remoteFk: remoteFk, remoteId: sel.value });
            });
          });
          withBusy(saveBtn, function () {
            return rowWrite('POST', '/api/tables/' + encodeURIComponent(table) + '/rows', values).then(function (res) {
              var newId = res && (res.id || (res.row && res.row.id));
              var chain = Promise.resolve();
              links.forEach(function (lk) {
                chain = chain.then(function () {
                  // Junction /link endpoint (INSERT OR IGNORE on the two FKs) —
                  // works for pk-less junctions + is idempotent.
                  var jrow = {};
                  jrow[lk.localFk] = newId;
                  jrow[lk.remoteFk] = lk.remoteId;
                  return rowWrite('POST', '/api/tables/' + encodeURIComponent(lk.junction) + '/link', jrow);
                });
              });
              return chain.then(function () { return newId; });
            }).then(function (newId) {
              invalidate(table);
              return refreshEntities().then(function () {
                showToast('Created', {});
                location.hash = newId ? fsHref([table, String(newId)]) : collectionHref;
              });
            }).catch(function (err) { showToast('Create failed: ' + err.message, {}); });
          });
        });
      }).catch(function (err) { content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>'; });
    }

    // Item view — one row as a document (click-to-edit) + its relationship folders.
    function renderFsItem(content, segs) {
      var myGen = renderGen;
      fsWalk(segs).then(function (crumbs) {
        var leaf = crumbs[crumbs.length - 1];
        if (!leaf || leaf.type !== 'node') throw new Error('Bad item path');
        var table = leaf.table, id = leaf.id, row = leaf.row;
        var t = tableByName(table);
        if (!t) { location.hash = '#/'; return; } // table removed → dashboard
        // The open record was deleted out from under the view — fall back to the
        // parent folder rather than repaint a tombstone (respect an explicit trash view).
        if (!row || (row.deleted_at && tableViewMode[table] !== 'trash')) {
          location.hash = '#/fs/' + encodeURIComponent(table);
          return;
        }
        var d = displayFor(table);
        // The tab shows the open RECORD's name (e.g. an entity row), not the
        // object/table name. Guard: only retitle a RECORD ('item:') tab — never the
        // shared Brain Graph ('graph') tab, even if a record render briefly runs
        // while the hash still resolves to the graph (which would rename 🧠).
        if (typeof setTabTitle === 'function') {
          var fsItemKey = tabKeyForHash(location.hash);
          if (fsItemKey && fsItemKey.indexOf('item:') === 0) {
            setTabTitle(fsItemKey, fsDisplayName(row) || d.label);
          }
        }
        // Files + artifacts get the two-view document layout (formatted display +
        // a View Source toggle) with a Version History + Delete dropdown — not the
        // column-by-column field dump or the "Inside" grid.
        if (table === 'files') { renderFsDocItem(content, segs, crumbs, id, row, d); return; }
        var bt = belongsToColumns(t);
        var rels = fsRelations(table);
        // Preload belongsTo targets so parent links can show names.
        Promise.all(bt.map(function (b) { return loadAllRows(b.rel.table); })).then(function () {
          if (myGen !== renderGen) return; // superseded by a newer navigation
          var fields = [];
          intrinsicColumns(t).forEach(function (c) { fields.push(fsFieldHtml(table, row, c)); });
          bt.forEach(function (b) {
            var ref = (loadedTables[b.rel.table] || []).find(function (x) { return x.id === row[b.rel.foreignKey]; });
            var dd = ref
              ? '<a class="fs-link" href="#/fs/' + encodeURIComponent(b.rel.table) + '/' + encodeURIComponent(ref.id) + '">📁 ' + escapeHtml(fsDisplayName(ref)) + '</a>'
              : '<span class="fs-empty-val">—</span>';
            fields.push('<div class="fs-field"><div class="fs-field-label">' + escapeHtml(titleCase(b.relName)) +
              '</div><div class="fs-field-val">' + dd + '</div></div>');
          });
          var base = fsHref(segs);
          var folderTiles = rels.map(function (rel) {
            return '<a class="fs-tile fs-folder" href="' + base + '/' + encodeURIComponent(rel.token) + '">' +
              '<div class="fs-tile-icon">📁</div>' +
              '<div class="fs-tile-label">' + escapeHtml(rel.label) + '</div>' +
              '<div class="fs-folder-count" data-count-for="' + escapeHtml(rel.token) + '">…</div>' +
            '</a>';
          }).join('');
          content.innerHTML =
            fsBreadcrumb(segs, crumbs) +
            '<div class="view-header">' +
              '<span class="entity-icon">' + (table === 'files' ? fileEmoji(row) : d.icon) + '</span>' +
              '<h1>' + escapeHtml(fsDisplayName(row) || d.label) + '</h1>' +
            '</div>' +
            detailVisLineEl(row) +
            (table === 'files' ? '<div class="file-preview" id="file-preview"></div>' : '') +
            // Formatted markdown (rendered context) sits ABOVE the column-by-column
            // data view; the raw fields follow underneath.
            '<div class="fs-context" id="fs-context" hidden></div>' +
            '<div class="fs-doc">' + fields.join('') + '</div>' +
            (rels.length ? '<h3 class="fs-rel-title">Inside</h3><div class="fs-grid fs-rel-folders">' + folderTiles + '</div>' : '') +
            '<div id="row-provenance"></div>';
          if (table === 'files') renderFilePreview(row);
          loadFsContext(table, id);
          wireFsEdit(content, table, id, t, row);
          // Collapsed, lazy-loaded "Data provenance" panel for this row.
          renderProvenancePanel(content.querySelector('#row-provenance'), table, id);
          // Per-row sharing controls — same affordance as the advanced detail view.
          wireRowSharing(content, table, id, row, function () { renderFsItem(content, segs); });
          rels.forEach(function (rel) {
            fsRelatedRows(table, row, rel).then(function (rs) {
              var el = content.querySelector('[data-count-for="' + rel.token + '"]');
              if (el) el.textContent = rs.length + (rs.length === 1 ? ' item' : ' items');
            }).catch(function () { /* count is best-effort */ });
          });
        });
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ── File / artifact document view (two-view: Display ↔ Source) ──────
    // Per-open-item view state (display | source), so each tab toggles
    // independently and re-renders in place without navigating.
    var fileViewMode = {};
    function sourceTextOf(row) {
      return row && typeof row.extracted_text === 'string' ? row.extracted_text : '';
    }
    function renderFsDocItem(content, segs, crumbs, id, row, d) {
      // The tab shows the FILE's name (e.g. "Properties Dashboard"), not the
      // object name ("Files").
      if (typeof setTabTitle === 'function') {
        var fsDocKey = tabKeyForHash(location.hash);
        if (fsDocKey && fsDocKey.indexOf('item:') === 0) {
          setTabTitle(fsDocKey, fsDisplayName(row) || d.label);
        }
      }
      var mode = fileViewMode[id] || 'display';
      // Actions live in a dropdown menu next to the title; View source / Version
      // history are full-page modes (they replace the body, not overlay it).
      content.innerHTML =
        fsBreadcrumb(segs, crumbs) +
        '<div class="view-header">' +
          '<span class="entity-icon">' + fileEmoji(row) + '</span>' +
          '<h1>' + escapeHtml(fsDisplayName(row) || d.label) + '</h1>' +
          '<div class="actions file-menu-wrap">' +
            '<button class="btn file-menu-btn" id="file-menu-btn" aria-haspopup="menu" aria-expanded="false" title="Actions">⋯</button>' +
            '<div class="file-menu" id="file-menu" role="menu" hidden>' +
              (mode !== 'display' ? '<button class="file-menu-item" data-act="display" role="menuitem">Formatted view</button>' : '') +
              (mode !== 'source' ? '<button class="file-menu-item" data-act="source" role="menuitem">View source</button>' : '') +
              (mode !== 'history' ? '<button class="file-menu-item" data-act="history" role="menuitem">Version history</button>' : '') +
              '<button class="file-menu-item danger" data-act="delete" role="menuitem">Delete</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div id="file-body">' + fileBodyHtml(mode, row) + '</div>';
      if (mode === 'display') renderFilePreview(row);
      else if (mode === 'history') loadFileHistoryInto(content, id);
      wireFsDocToolbar(content, segs, id, row);
      // Upgrade the breadcrumb to the file's FOLDER path (Home ▸ Files ▸ Downloads
      // ▸ <file>) when it lives under a registered folder root.
      if (row.ref_uri) {
        var crumbGen = renderGen;
        fetchJson('/api/sources/roots').then(function (data) {
          if (crumbGen !== renderGen) return;
          var nav = content.querySelector('.fs-crumbs');
          if (nav) nav.outerHTML = folderBreadcrumb(fsDirname(row.ref_uri), (data && data.roots) || [], fsDisplayName(row) || d.label);
        }).catch(function () { /* keep the default breadcrumb */ });
      }
    }

    // The body for the current view mode (display | source | history).
    function fileBodyHtml(mode, row) {
      if (mode === 'source') {
        var src = sourceTextOf(row);
        // An artifact (Lattice-created) edits in place; an ingested file's source
        // is read-only extracted text.
        return row.artifact_type
          ? '<div class="file-source">' +
              '<textarea id="file-source-text" class="file-source-text" spellcheck="false">' + escapeHtml(src) + '</textarea>' +
              '<div class="file-source-actions"><button class="btn primary" id="file-source-save">Save</button>' +
              '<span class="muted" style="font-size:12px">Editing updates this artifact in place; older versions are kept in Version History.</span></div>' +
            '</div>'
          : '<pre class="file-source-pre">' + escapeHtml(src || 'No source text.') + '</pre>';
      }
      if (mode === 'history') {
        return '<div class="file-history-view" id="file-history-view"><div class="muted" style="padding:8px">Loading history…</div></div>';
      }
      return '<div class="file-preview" id="file-preview"></div>';
    }

    // ONE document-level outside-click closer for the file-actions menu. The menu
    // + button are re-created with stable ids on every renderFsDocItem, so a
    // per-render listener would leak (stale closures accumulating on document and
    // firing on every click). Registered exactly once; reads the current nodes by id.
    var fileMenuDocWired = false;
    function wireFileMenuGlobal() {
      if (fileMenuDocWired) return;
      fileMenuDocWired = true;
      document.addEventListener('click', function (e) {
        var menu = document.getElementById('file-menu');
        var btn = document.getElementById('file-menu-btn');
        if (!menu || menu.hidden) return;
        if ((btn && btn.contains(e.target)) || menu.contains(e.target)) return;
        menu.hidden = true; if (btn) btn.setAttribute('aria-expanded', 'false');
      });
    }
    function wireFsDocToolbar(content, segs, id, row) {
      var btn = content.querySelector('#file-menu-btn');
      var menu = content.querySelector('#file-menu');
      if (btn && menu) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var willShow = menu.hidden;
          menu.hidden = !willShow;
          btn.setAttribute('aria-expanded', willShow ? 'true' : 'false');
        });
        wireFileMenuGlobal();
      }
      content.querySelectorAll('.file-menu-item').forEach(function (it) {
        it.addEventListener('click', function (e) {
          e.stopPropagation();
          var act = it.getAttribute('data-act');
          if (act === 'delete') { removeFile(segs, id, row); return; }
          fileViewMode[id] = act; // display | source | history
          renderFsItem(content, segs); // re-render this item in the new mode
        });
      });
      var save = content.querySelector('#file-source-save');
      if (save) save.addEventListener('click', function () { saveFileSource(content, segs, id); });
    }

    // Load the row's version history into the full-page history view.
    function loadFileHistoryInto(content, id) {
      var host = content.querySelector('#file-history-view');
      if (!host) return;
      fetchJson('/api/tables/files/rows/' + encodeURIComponent(id) + '/history')
        .then(function (data) {
          var hist = (data && data.history) || [];
          if (!hist.length) { host.innerHTML = '<div class="muted" style="padding:8px">No prior versions yet.</div>'; return; }
          host.innerHTML = '<ul class="file-history-list">' +
            hist.map(function (h) {
              return '<li class="file-history-item">' +
                '<span class="fh-op">' + escapeHtml(h.operation) + '</span>' +
                '<span class="fh-ts">' + escapeHtml(h.ts) + '</span>' +
                (h.undone ? '<span class="fh-undone">undone</span>' : '') +
                '<button class="btn fh-revert" data-rev="' + escapeHtml(h.id) + '">Revert</button></li>';
            }).join('') + '</ul>';
          host.querySelectorAll('.fh-revert').forEach(function (b) {
            b.addEventListener('click', function () { revertFileVersion(b.getAttribute('data-rev')); });
          });
        })
        .catch(function (e) {
          host.innerHTML = '<div class="muted" style="padding:8px">Failed: ' + escapeHtml(e.message) + '</div>';
        });
    }

    function revertFileVersion(auditId) {
      fetch('/api/history/revert/' + encodeURIComponent(auditId), { method: 'POST' })
        .then(function (r) { if (!r.ok) throw new Error('revert failed (' + r.status + ')'); return r.json(); })
        .then(function () { invalidate('files'); return refreshEntities(); })
        .then(function () { showToast('Reverted', { undo: undoLast }); renderRoute({ soft: true }); })
        .catch(function (e) { showToast('Revert failed: ' + e.message, {}); });
    }

    function saveFileSource(content, segs, id) {
      var ta = content.querySelector('#file-source-text');
      if (!ta) return;
      fetch('/api/tables/files/rows/' + encodeURIComponent(id) + '/content', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: ta.value }),
      })
        .then(function (r) { if (!r.ok) throw new Error('save failed (' + r.status + ')'); return r.json(); })
        .then(function () { invalidate('files'); return refreshEntities(); })
        .then(function () {
          fileViewMode[id] = 'display'; // back to the formatted view
          showToast('Saved', { undo: undoLast });
          renderFsItem(content, segs);
        })
        .catch(function (e) { showToast('Save failed: ' + e.message, {}); });
    }

    // Soft-delete (Delete): recoverable, and NEVER touches the on-disk file — it
    // only soft-deletes the Lattice record. Closes the item's tab afterward.
    function removeFile(segs, id, row) {
      fetch('/api/tables/files/rows/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
        .then(function (r) { if (!r.ok) throw new Error('delete failed (' + r.status + ')'); return r.json(); })
        .then(function () { invalidate('files'); return refreshEntities(); })
        .then(function () {
          showToast('Deleted "' + (fsDisplayName(row) || 'file') + '"', { undo: undoLast });
          if (typeof closeTab === 'function') closeTab(tabKeyForHash(location.hash));
          else location.hash = '#/graph';
        })
        .catch(function (e) { showToast('Delete failed: ' + e.message, {}); });
    }

    // Click-to-edit on rendered values. Reuses fieldFor() for the input and the
    // same PATCH → invalidate → refreshEntities chain as renderDetail's save.
    function wireFsEdit(content, table, id, t, row) {
      content.querySelectorAll('.fs-field-val.ce').forEach(function (cell) {
        cell.addEventListener('click', function (e) {
          if (cell.classList.contains('editing')) return;
          if (e.target && e.target.closest('a, button, input, textarea, select')) return;
          var col = cell.getAttribute('data-col');
          var current = row[col];
          cell.classList.add('editing');
          cell.innerHTML = fieldFor(col, current == null ? '' : current, t);
          var input = cell.querySelector('input, textarea, select');
          if (!input) { cell.classList.remove('editing'); cell.innerHTML = fsValInner(table, row, col); return; }
          input.focus();
          if (input.select) { try { input.select(); } catch (_) { /* ignore */ } }
          var done = false;
          function repaint() { cell.classList.remove('editing'); cell.innerHTML = fsValInner(table, row, col); }
          function finish(save) {
            if (done) return; done = true;
            if (!save) { repaint(); return; }
            var val = input.value === '' ? null : input.value;
            var before = current == null ? '' : String(current);
            if ((val == null ? '' : String(val)) === before) { repaint(); return; }
            var body = {}; body[col] = val;
            fetchJson('/api/tables/' + encodeURIComponent(table) + '/rows/' + encodeURIComponent(id), {
              method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            }).then(function () {
              row[col] = val; invalidate(table); return refreshEntities();
            }).then(function () {
              repaint(); showToast('Updated', { undo: undoLast });
            }).catch(function (err) { showToast('Save failed: ' + err.message, {}); repaint(); });
          }
          input.addEventListener('blur', function () { finish(true); });
          input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
            else if (ev.key === 'Enter' && input.tagName !== 'TEXTAREA') { ev.preventDefault(); finish(true); }
            else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); finish(true); }
          });
        });
      });
    }

`;
