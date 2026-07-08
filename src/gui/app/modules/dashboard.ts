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
      'sql:function(q){return __lreq("sql",{sql:q});},' +
      'search:function(q){return __lreq("search",{query:q});},' +
      // Navigation-only, fire-and-forget. The page can ask the host to move the user
      // around the app (open Configure, an add-source flow, or the assistant) — the
      // same things they can do themselves — but NEVER read or write data through it.
      'act:function(name,arg){window.parent.postMessage({__lattice:true,op:"act",name:String(name||""),arg:(arg==null?"":String(arg))},"*");}};';

    // Parent-side broker: the ONLY bridge between the isolated frame and the data
    // API. Strictly READ-ONLY — it performs exactly three GET/search reads against
    // the existing same-origin API and nothing else (no create/update/delete, no
    // arbitrary path), and refuses system/credential tables. RLS still applies
    // server-side, so a cloud member only ever reads rows they may already see.
    function __latticeReadOnlyFetch(msg) {
      var op = msg && msg.op;
      var table = String((msg && msg.table) || '');
      var DENY = { secrets: 1, chat_threads: 1, chat_messages: 1 };
      // Table-LESS ops (search + sql) are handled BEFORE the table guard: they
      // carry no msg.table (search uses msg.query, sql uses msg.sql), so the
      // empty-table check below would wrongly reject them as "forbidden table".
      // Their protection is enforced server-side (search allowlist; the SQL
      // endpoint's SELECT-only shape + protected-table deny-list + row cap + a
      // Postgres READ ONLY txn). This is the bug that made EVERY sql-driven
      // dashboard (aggregations, GROUP BY) render "Error loading data: forbidden
      // table" — the most common dashboard shape.
      if (op === 'search') {
        // Workspace search is a GET (/api/search?q=…) — there is no POST route,
        // so the prior POST silently 404'd and search-driven dashboard sections
        // rendered empty with no error. Use the real GET endpoint.
        return fetch('/api/search?q=' + encodeURIComponent(String((msg && msg.query) || '')))
          .then(function (r) { return r.json(); }).then(function (j) { return { ok: true, data: j }; });
      }
      if (op === 'sql') {
        return fetch('/api/analytics/sql', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sql: String((msg && msg.sql) || '') }),
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (j && j.error) return { ok: false, error: String(j.error) };
          return { ok: true, data: j };
        });
      }
      // Table-scoped ops (query / get) must name an allowed table.
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
    // Navigation-ONLY host actions a rendered page may request via window.lattice.act().
    // Every branch just moves the user somewhere they could already reach by hand (open
    // Configure, an add-source flow, or the assistant with a prefilled question) — there
    // is deliberately NO data read/write path here, and an unknown name is ignored.
    function __latticeDashboardAction(name, arg) {
      if (name === 'configure') { if (typeof goConfigure === 'function') goConfigure(); return; }
      if (name === 'analytics') { if (typeof goAnalytics === 'function') goAnalytics(); return; }
      if (name === 'ask') {
        if (typeof goAnalytics === 'function') goAnalytics();
        setTimeout(function () {
          var inp = document.getElementById('chat-input');
          if (!inp) return;
          if (arg) inp.value = String(arg);
          inp.focus();
        }, 60);
        return;
      }
      var addBtn = { 'add-file': 'src-add-files', 'add-connector': 'src-add-connector', 'add-database': 'src-add-database' };
      if (Object.prototype.hasOwnProperty.call(addBtn, name)) {
        if (typeof goConfigure === 'function') goConfigure();
        var id = addBtn[name];
        setTimeout(function () { var b = document.getElementById(id); if (b) b.click(); }, 90);
        return;
      }
      // Unknown action \\u2014 ignore (fail closed).
    }
    var __latticeHtmlBrokerInstalled = false;
    function installHtmlFileBroker() {
      if (__latticeHtmlBrokerInstalled) return;
      __latticeHtmlBrokerInstalled = true;
      window.addEventListener('message', function (e) {
        var d = e.data;
        if (!d || d.__lattice !== true) return;
        // Identity check: only honour messages whose source IS a live sandboxed
        // page frame's window — an unforgeable handle. (The frames are null-origin,
        // so we can't match on e.origin; source identity is the real gate.) Any
        // .html-frame qualifies: the Configure file preview and the Analytics
        // dashboard canvas both render through this broker, and the hidden view's
        // frame may coexist in the DOM.
        var frame = null;
        var frames = document.querySelectorAll('iframe.html-frame');
        for (var fi = 0; fi < frames.length; fi++) {
          if (frames[fi].contentWindow && e.source === frames[fi].contentWindow) { frame = frames[fi]; break; }
        }
        if (!frame) return;
        // Navigation actions (op:'act') are fire-and-forget and need no reply — a
        // rendered dashboard asking to move the user around the app. Whitelisted +
        // navigation-only (see __latticeDashboardAction), so nothing sensitive rides
        // this even though any sandboxed frame can post it.
        if (d.op === 'act') { __latticeDashboardAction(String(d.name || ''), d.arg); return; }
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
    // Load the vendored Chart.js on demand (it's no longer inlined in the bundle —
    // ~275 KB off every startup's parse). Sets window.__LATTICE_CHART_LIB__; cached
    // after the first HTML-file preview. Fail-soft: on a load error the preview still
    // renders, just without chart support.
    function ensureChartLib() {
      if (window.__LATTICE_CHART_LIB__) return Promise.resolve();
      if (window.__latticeChartLibPromise) return window.__latticeChartLibPromise;
      window.__latticeChartLibPromise = new Promise(function (resolve) {
        var s = document.createElement('script');
        s.src = '/gui-assets/chart-lib.js';
        s.onload = function () { resolve(); };
        s.onerror = function () { resolve(); };
        document.head.appendChild(s);
      });
      return window.__latticeChartLibPromise;
    }
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
        // Ensure the chart lib is loaded, THEN set the srcdoc (re-resolve the frame
        // in case a re-render replaced it while the lib was fetching).
        ensureChartLib().then(function () {
          var f = document.getElementById('html-file-frame');
          if (f) f.srcdoc = htmlFileSrcdoc(row.extracted_text);
        });
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
    // ════════════════════════════════════════════════════════════
    // File-system workspace (the single view) + settings drawer
    //
    // Each object is a folder of tiles; clicking one opens the unified
    // record page (rendered doc / preview, click-to-edit, sharing,
    // provenance, connected objects, and the actions menu with the
    // structured fields editor + junction manager). The legacy classic
    // row/table editor was absorbed into that page and removed;
    // #/objects/* redirects here.
    // ════════════════════════════════════════════════════════════
    // The GUI has a SINGLE view: the file workspace. The former "Advanced View"
    // (classic row/table editor) and its Settings toggle were removed. advancedMode()
    // remains as a false constant so the call sites that branched on it all resolve
    // to the file-workspace routes (#/fs/…) with no dead toggle state.
    function advancedMode() {
      return false;
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
    // The record-namespace prefix for a section, so an in-section drill keeps its
    // section (and thus its lit tab + breadcrumb root). Folders records live under
    // #/fs, Graph under #/graph, Tables under #/tables — all rendered by the SAME
    // record/collection renderers, told which section they're in.
    function sectionHref(section, segs) {
      var p = section === 'graph' ? '#/graph/' : section === 'tables' ? '#/tables/' : '#/fs/';
      return p + segs.map(function (s) { return encodeURIComponent(s); }).join('/');
    }
    // The section a hash belongs to, from its prefix — used by in-place re-renders
    // (a mode toggle / save) that don't carry the section as an argument.
    function sectionOfHash(hash) {
      hash = hash || location.hash || '';
      if (hash.indexOf('#/graph/') === 0) return 'graph';
      if (hash.indexOf('#/tables/') === 0) return 'tables';
      return 'folders';
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

    function fsBreadcrumb(segs, crumbs, section) {
      // Rooted at the SECTION you drilled in from (Folders / Graph / Tables), so the
      // breadcrumb root matches the highlighted tab: <Section> ▸ <Object> ▸ <record>…
      section = section || 'folders';
      var rootHref = section === 'graph' ? '#/graph' : section === 'tables' ? '#/tables' : '#/folders';
      var rootLabel = section === 'graph' ? 'Graph' : section === 'tables' ? 'Tables' : 'Objects';
      var parts = ['<a href="' + rootHref + '">' + rootLabel + '</a>'];
      var t0 = segs[0];
      // The OBJECT crumb opens that section's real Object Page for t0 (Folders → the
      // icon grid, Graph → the entity graph, Tables → the rows list). 'artifacts' is
      // a VIRTUAL object (no real table) served only by renderArtifactsView via the
      // #/fs/artifacts special-case, so it must keep that self-view href in every
      // section — #/folders/artifacts would hit renderFolderEntity and dead-end.
      var objHref = t0 === 'artifacts' ? '#/fs/artifacts'
        : section === 'graph' ? '#/graph/' + encodeURIComponent(t0)
        : section === 'tables' ? '#/tables/' + encodeURIComponent(t0)
        : '#/folders/' + encodeURIComponent(t0);
      // Record/relation crumbs accumulate onto the section's RECORD prefix.
      var prefix = sectionHref(section, [t0]);
      // An artifact (a file carrying an artifact_type) reads as its own "Artifacts"
      // object, so its record breadcrumb roots at Artifacts rather than Files.
      var leafNode = (crumbs || []).filter(function (c) { return c.type === 'node'; }).pop();
      if (t0 === 'files' && leafNode && leafNode.row && leafNode.row.artifact_type) {
        parts.push('<a href="#/fs/artifacts">Artifacts</a>');
      } else {
        parts.push('<a href="' + objHref + '">' + escapeHtml(displayFor(t0).label) + '</a>');
      }
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
    // Rows-table page size + per-collection page index (keyed by the collection's
    // hash, so drilling into a record and back preserves your page). A fresh
    // collection key defaults to page 0.
    var PAGE_SIZE = 100;
    var fsPageByPath = {};

    // Shared rows-table renderer for the object + Artifacts pages: thead/body, the
    // whole-row-click affordance, and a Prev/Next pager with an "A–B of T" total.
    // The caller supplies the already-sliced page of rows + a pre-formatted
    // totalLabel ("123" or "1000+") + hasNext, so each caller owns its own
    // server-capped vs client-side paging semantics.
    // o = { breadcrumbHtml, icon, label, table, cols, rows, hrefFor, page,
    //       pageSize, totalLabel, hasNext, onPage, noteHtml }
    function paintRowsTable(content, o) {
      var rows = o.rows || [];
      var cols = o.cols;
      var pageSize = o.pageSize || PAGE_SIZE;
      var page = o.page || 0;
      var thead = cols.map(function (c) { return '<th>' + escapeHtml(fieldLabel(c)) + '</th>'; }).join('');
      var body = rows.map(function (r) {
        var href = o.hrefFor(r);
        var cells = cols.map(function (c, i) {
          var v = fsCellText(o.table, r, c);
          if (i === 0) {
            v = '<a href="' + href + '">' + (String(r[c] == null ? '' : r[c]).trim() ? v : '(untitled)') + '</a>';
          }
          return '<td>' + v + '</td>';
        }).join('');
        return '<tr class="fs-row-click" data-href="' + href + '">' + cells + '</tr>';
      }).join('');
      var tableHtml = rows.length
        ? '<table class="pv-table fs-rows-table"><thead><tr>' + thead + '</tr></thead><tbody>' + body + '</tbody></table>'
        : '<div class="fs-empty" style="padding:24px">' + escapeHtml(o.emptyText || 'Nothing here yet.') + '</div>';

      var first = rows.length ? page * pageSize + 1 : 0;
      var last = page * pageSize + rows.length;
      var info = rows.length
        ? first + '\\u2013' + last + ' of ' + escapeHtml(o.totalLabel)
        : '0 of ' + escapeHtml(o.totalLabel);
      var hasPrev = page > 0;
      var hasNext = !!o.hasNext;
      var pager =
        '<span class="rows-pager">' +
          '<span class="rows-pager-info">' + info + '</span>' +
          '<button type="button" class="btn rows-prev"' + (hasPrev ? '' : ' disabled') + '>\\u2039 Prev</button>' +
          '<button type="button" class="btn rows-next"' + (hasNext ? '' : ' disabled') + '>Next \\u203a</button>' +
        '</span>';

      content.innerHTML =
        o.breadcrumbHtml +
        '<div class="view-header">' +
          '<span class="entity-icon">' + o.icon + '</span>' +
          '<h1>' + escapeHtml(o.label) + '</h1>' +
          (o.headerExtraHtml || '') +
          (o.bodyOverrideHtml ? '' : pager) +
        '</div>' +
        (o.noteHtml || '') +
        (o.bodyOverrideHtml || tableHtml);

      content.querySelectorAll('.fs-rows-table tr.fs-row-click').forEach(function (tr) {
        tr.addEventListener('click', function (ev) {
          if (ev.target && ev.target.closest && ev.target.closest('a')) return;
          var h = tr.getAttribute('data-href');
          if (h) location.hash = h;
        });
      });
      var prevBtn = content.querySelector('.rows-prev');
      var nextBtn = content.querySelector('.rows-next');
      if (prevBtn && hasPrev) prevBtn.addEventListener('click', function () { o.onPage(page - 1); });
      if (nextBtn && hasNext) nextBtn.addEventListener('click', function () { o.onPage(page + 1); });
    }

    // A freshly-created computed view fills its AI-derived cells (ai_classify /
    // ai_transform) in the background, so those columns read blank for a moment.
    // When the definition actually has AI fields, drop an unobtrusive banner
    // under the "computed view" note so the blanks read as "still filling", not
    // "broken". Pure alias/calc/aggregate views fill synchronously and get no
    // banner. One small metadata GET (computed tables only); best-effort — a
    // failed hint must never break the collection view.
    function fsComputedAiBanner(content, table, gen) {
      fetchJson('/api/computed-tables/' + encodeURIComponent(table)).then(function (d) {
        if (gen !== renderGen) return; // superseded by a newer navigation
        var fields = (d && d.def && d.def.fields) || {};
        var hasAi = Object.keys(fields).some(function (k) {
          var kind = fields[k] && fields[k].kind;
          return kind === 'ai_classify' || kind === 'ai_transform';
        });
        if (!hasAi) return;
        var anchor = content.querySelector('.fs-computed-note');
        if (!anchor || content.querySelector('.fs-ai-pending-note')) return;
        var note = document.createElement('div');
        note.className = 'fs-computed-note fs-ai-pending-note';
        note.textContent = 'AI-derived fields fill in the background and may be blank briefly \\u2014 use Refresh values to update.';
        anchor.parentNode.insertBefore(note, anchor.nextSibling);
      }).catch(function () { /* best-effort hint — never break the collection view */ });
    }

    // Turn a server page envelope into paintRowsTable terms. env.rows was fetched
    // with limit PAGE_SIZE + 1 (a sentinel over-fetch): if the extra row came back
    // there IS a next page — a precise signal that works even when the count is
    // capped or the total is an exact multiple of the page size (no phantom page).
    // env.approxTotal is the bounded count (cap + 1 when capped → render "cap+").
    function fsServerPage(env) {
      var hasMore = env.rows.length > PAGE_SIZE;
      return {
        rows: env.rows.slice(0, PAGE_SIZE),
        approxTotal: env.approxTotal,
        totalLabel: env.totalIsCapped ? String(env.approxTotal - 1) + '+' : String(env.approxTotal),
        hasNext: hasMore,
      };
    }

    // Collection view — a folder of tiles for a NESTED relation path
    // (#/fs/<table>/<id>/<rel>). The top-level object page (#/fs/<table>) is the
    // data-provenance view (graph or table — how this object's rows are sourced).
    // Per-table collection view mode: 'formatted' (the rows) | 'markdown' (the
    // whole-table rollup file, read-only). Set to markdown when a rollup .md is
    // clicked in the Markdown tree.
    var collectionViewMode = {};
    function renderFsCollection(content, segs, section) {
      section = section || 'folders';
      var myGen = renderGen;
      clearUnseen(segs[0]);
      var topLevel = segs.length === 1;
      // Files keep their bespoke file-list table (folders + loose files).
      if (topLevel && segs[0] === 'files') { renderFilesRootView(content); return; }
      // Artifacts = the subset of files carrying an artifact_type, shown as their
      // own object/table (Tables ▸ Artifacts), not buried under Files.
      if (topLevel && segs[0] === 'artifacts') { renderArtifactsView(content); return; }
      var crumbsP = topLevel ? Promise.resolve([]) : fsWalk(segs);
      crumbsP.then(function (crumbs) {
        var base = sectionHref(section, segs);
        var page = fsPageByPath[base] || 0;
        var table, viewP;
        if (topLevel) {
          table = segs[0];
          if (!tableByName(table)) {
            setContent(content, myGen, '<div class="placeholder">Unknown entity: ' + escapeHtml(table) + '</div>');
            return;
          }
          // Server-side paging: fetch this page + ONE sentinel row (limit + 1) so
          // "is there a next page" is exact, plus the bounded approximate total.
          viewP = fetchRowsPage(table, { limit: PAGE_SIZE + 1, offset: page * PAGE_SIZE }).then(fsServerPage);
        } else {
          var last = crumbs[crumbs.length - 1];
          if (!last || last.type !== 'rel') throw new Error('Bad collection path');
          table = last.rel.targetTable;
          // Relation drill: fsRelatedRows returns a bounded array (JS-filtered by
          // membership), so page client-side over the full array.
          viewP = fsRelatedRows(last.parentTable, last.parentRow, last.rel).then(function (all) {
            return {
              rows: all.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
              approxTotal: all.length,
              totalLabel: String(all.length),
              hasNext: (page + 1) * PAGE_SIZE < all.length,
            };
          });
        }
        return viewP.then(function (view) {
          if (myGen !== renderGen) return; // superseded by a newer navigation
          // A stale page index (rows deleted under us, or a remembered deep page)
          // can land past the end → clamp to the last real page and re-render.
          if (!view.rows.length && page > 0) {
            var lastPage = Math.max(0, Math.ceil((view.approxTotal || 0) / PAGE_SIZE) - 1);
            if (lastPage !== page) { fsPageByPath[base] = lastPage; renderFsCollection(content, segs, section); return; }
          }
          var d = displayFor(table);
          // Computed tables are live, read-only projections: badge the header,
          // say where the values come from, and skip the Markdown toggle (a
          // computed view renders no rollup and offers nothing to edit).
          var tMeta = tableByName(table);
          var isComputed = !!(tMeta && tMeta.computedTable);
          // The collection has the SAME Formatted | Markdown duality as records:
          // Formatted = the rows; Markdown = the table's whole-table rollup file
          // (read-only — rollups are generated). Clicking a rollup .md in the
          // Markdown tree lands here in markdown mode.
          var colMode = topLevel && !isComputed ? (collectionViewMode[table] || 'formatted') : 'formatted';
          var toggleHtml = topLevel && !isComputed
            ? '<div class="fs-view-toggle">' +
                '<button type="button" data-colview="formatted"' + (colMode === 'formatted' ? ' class="on"' : '') + '>Formatted</button>' +
                '<button type="button" data-colview="markdown"' + (colMode === 'markdown' ? ' class="on"' : '') + '>Markdown</button>' +
              '</div>'
            : '';
          var badgeHtml = isComputed
            ? '<span class="fs-computed-badge" title="A live, read-only view">Computed</span>'
            : '';
          var noteHtml = isComputed
            ? '<div class="fs-computed-note">This is a computed view \\u2014 its values come from the records it\\u2019s built from.</div>'
            : '';
          // The object view is the table's ROWS in a table (mirroring the Files file
          // list), one page at a time with a Prev/Next pager. One consistent view.
          paintRowsTable(content, {
            breadcrumbHtml: fsBreadcrumb(segs, crumbs, section),
            icon: d.icon,
            label: d.label,
            headerExtraHtml: badgeHtml + toggleHtml,
            noteHtml: noteHtml,
            bodyOverrideHtml: colMode === 'markdown'
              ? '<div class="fs-context"><div class="fs-context-doc" id="collection-rollup-doc"><div class="muted" style="padding:12px">Loading\u2026</div></div></div>'
              : '',
            table: table,
            cols: objRowCols(tableByName(table)),
            rows: view.rows,
            hrefFor: function (r) { return base + '/' + encodeURIComponent(r.id); },
            page: page,
            pageSize: PAGE_SIZE,
            totalLabel: view.totalLabel,
            hasNext: view.hasNext,
            // Bump renderGen so a slow prior-page fetch can't paint over this one.
            onPage: function (p) { fsPageByPath[base] = p; renderGen++; renderFsCollection(content, segs, section); },
          });
          // Computed views with AI-derived fields fill those cells in the
          // background — hint at that so blank AI columns don't read as broken.
          if (isComputed) fsComputedAiBanner(content, table, myGen);
          // Formatted | Markdown toggle (top-level collections): markdown shows
          // the table's rollup file, fetched through the resolver (claimed
          // artifacts only). Rollups are generated files — read-only here.
          if (topLevel) {
            content.querySelectorAll('.fs-view-toggle [data-colview]').forEach(function (bb) {
              bb.addEventListener('click', function () {
                collectionViewMode[table] = bb.getAttribute('data-colview') === 'markdown' ? 'markdown' : 'formatted';
                renderFsCollection(content, segs, section);
              });
            });
            if (colMode === 'markdown') {
              fetchJson('/api/context/list?table=' + encodeURIComponent(table))
                .then(function (d) {
                  var entries = (d && d.entries) || [];
                  var rollup = entries.filter(function (e) { return e.kind === 'file'; })[0];
                  if (!rollup) throw new Error('no rollup rendered yet');
                  return fetchJson('/api/context/resolve?content=1&path=' + encodeURIComponent(rollup.path));
                })
                .then(function (r) {
                  var host = document.getElementById('collection-rollup-doc');
                  if (!host) return;
                  var md = stripFrontmatter((r && r.content) || '');
                  host.innerHTML = md.trim()
                    ? mdToHtml(md)
                    : '<div class="src-empty">This table has no rendered markdown yet.</div>';
                })
                .catch(function () {
                  var host = document.getElementById('collection-rollup-doc');
                  if (host) host.innerHTML = '<div class="src-empty">This table has no rendered markdown yet.</div>';
                });
            }
          }
        });
      }).catch(function (err) {
        if (myGen !== renderGen) return; // a stale error must not clobber a newer view
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // Artifacts object page: the files that carry an artifact_type, rendered as a
    // normal rows table (mirroring the object page), each row opening the file
    // record. Paged server-side (?artifactType=present) like any object page, so
    // every artifact is reachable. The breadcrumb roots at Artifacts (see fsBreadcrumb).
    function renderArtifactsView(content) {
      var myGen = renderGen;
      var base = '#/fs/artifacts';
      var page = fsPageByPath[base] || 0;
      fetchRowsPage('files', {
        artifactType: 'present',
        exclude: 'extracted_text,description',
        limit: PAGE_SIZE + 1,
        offset: page * PAGE_SIZE,
      })
        .then(function (env) {
          if (myGen !== renderGen) return; // superseded by a newer navigation
          var view = fsServerPage(env);
          if (!view.rows.length && page > 0) {
            var lastPage = Math.max(0, Math.ceil((view.approxTotal || 0) / PAGE_SIZE) - 1);
            if (lastPage !== page) { fsPageByPath[base] = lastPage; renderArtifactsView(content); return; }
          }
          var d = displayFor('artifacts');
          paintRowsTable(content, {
            breadcrumbHtml: fsBreadcrumb(['artifacts'], []),
            icon: d.icon,
            label: d.label,
            table: 'files',
            cols: objRowCols(tableByName('files')),
            rows: view.rows,
            hrefFor: function (r) { return '#/fs/files/' + encodeURIComponent(r.id); },
            page: page,
            pageSize: PAGE_SIZE,
            totalLabel: view.totalLabel,
            hasNext: view.hasNext,
            emptyText: 'Nothing created yet.',
            onPage: function (p) { fsPageByPath[base] = p; renderGen++; renderArtifactsView(content); },
          });
        })
        .catch(function (err) {
          if (myGen !== renderGen) return;
          content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
        });
    }

    // Columns to show in the object rows table: the object's own fields, minus
    // internal/system/binary columns, capped so a wide table stays readable.
    function objRowCols(t) {
      if (!t || !t.columns) return ['id'];
      var skip = {
        deleted_at: 1, blob_path: 1, extracted_text: 1, extraction_status: 1,
        embedding: 1, vector: 1, _access: 1, _pk: 1, ref_kind: 1,
      };
      var cols = t.columns.filter(function (c) {
        return !skip[c] && c.indexOf('_source_') !== 0 && c.toLowerCase().indexOf('embedding') < 0;
      });
      // Lead with a human-ish column when present, not the raw id.
      cols.sort(function (a, b) {
        var rank = function (c) { return c === 'id' ? 2 : (/(name|title|label)/i.test(c) ? 0 : 1); };
        return rank(a) - rank(b);
      });
      return cols.slice(0, 8);
    }

    // Compact one-line cell value (masked for secrets, truncated) for the rows table.
    function fsCellText(table, row, col) {
      var raw = row[col];
      if (raw == null || raw === '') return '<span class="fs-empty-val">—</span>';
      if (isSecretColumn(table, col) || looksEncrypted(raw)) return '<span class="muted">' + SECRET_MASK + '</span>';
      var s = String(raw).replace(/\\s+/g, ' ').trim();
      if (s.length > 90) s = s.slice(0, 88) + '…';
      return escapeHtml(s);
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
    // Tables ▸ Files ▸ <root> ▸ …folders… [▸ <leafLabel current>]. Folder crumbs
    // link to their #/folder route; leafLabel (a filename) is appended non-linked.
    function folderBreadcrumb(path, roots, leafLabel) {
      var parts = ['<a href="#/tables">Tables</a>', '<a href="#/fs/files">Files</a>'];
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
    // Render a folder's children (the Files object page + folder drill-ins) as a
    // TABLE — the single object view, no graph. Folders link to their drill-in;
    // files link to their record. (The name arg is unused now the center node is gone.)
    function paintFolderGraph(content, header, name, entries, filesByPath, emptyMsg) {
      if (!entries.length) {
        content.innerHTML = header + '<div class="fs-empty" style="padding:24px">' + emptyMsg + '</div>';
        return;
      }
      var fbp = filesByPath || {};
      var sorted = entries.slice().sort(function (a, b) {
        if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
        return String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase());
      });
      var rows = sorted.map(function (e) {
        var isFolder = e.kind === 'folder';
        var id = e.id || (e.path ? fbp[e.path] : '') || '';
        var href = isFolder
          ? '#/folder/' + encodeURIComponent(e.path)
          : (id ? '#/fs/files/' + encodeURIComponent(id) : '');
        var ic = isFolder ? '\\ud83d\\udcc1' : '\\ud83d\\udcc4';
        var nm = href ? '<a href="' + href + '">' + escapeHtml(e.name) + '</a>' : escapeHtml(e.name);
        var trAttr = href ? ' class="fs-row-click" data-href="' + href + '"' : '';
        return '<tr' + trAttr + '><td><span class="src-ic">' + ic + '</span> ' + nm + '</td>' +
          '<td>' + (isFolder ? 'Folder' : 'File') + '</td>' +
          '<td class="fs-files-path">' + escapeHtml(e.path || '') + '</td></tr>';
      }).join('');
      content.innerHTML = header +
        '<table class="pv-table fs-files-table"><thead><tr>' +
        '<th>Name</th><th>Type</th><th>Location</th></tr></thead><tbody>' + rows + '</tbody></table>';
      content.querySelectorAll('.fs-files-table tr.fs-row-click').forEach(function (tr) {
        tr.addEventListener('click', function (ev) {
          if (ev.target && ev.target.closest && ev.target.closest('a')) return;
          var h = tr.getAttribute('data-href');
          if (h) location.hash = h;
        });
      });
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
        paintFolderGraph(content, header, name, entries, filesByPath, 'This folder is empty.');
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
        var header = '<a class="breadcrumb" href="#/tables">\\u2190 Tables</a>' +
          '<div class="view-header"><span class="entity-icon">' + d.icon + '</span><h1>' + escapeHtml(d.label) + '</h1>' +
          '<span class="count">' + entries.length + ' item' + (entries.length === 1 ? '' : 's') + '</span></div>';
        paintFolderGraph(content, header, 'Files', entries, {}, 'No files yet. Add a folder or file from the sidebar.');
      }).catch(function (err) {
        if (myGen !== renderGen) return;
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // Item view — ONE record page for every row (regular, file, artifact): the
    // same chrome everywhere — Formatted|Markdown toggle, visibility/sharing,
    // Data provenance, Connected objects, and the record actions menu. View mode
    // is PER RECORD: 'formatted' (the rendered doc / file preview) | 'markdown'
    // (the editable raw markdown, or a file's source) | 'history' (the version
    // trail, entered from the actions menu, exited via the toggle).
    var recordViewMode = {};
    var currentRecordId = null;
    function setFsItemView(v) {
      if (currentRecordId == null) return;
      recordViewMode[currentRecordId] =
        v === 'markdown' || v === 'history' || v === 'fields' ? v : 'formatted';
      applyFsItemView();
    }
    function applyFsItemView() {
      var mode = (currentRecordId != null && recordViewMode[currentRecordId]) || 'formatted';
      var md = mode === 'markdown';
      var hist = mode === 'history';
      var flds = mode === 'fields';
      var ctx = document.getElementById('fs-context');
      var rendered = ctx && ctx.querySelector('.fs-context-doc');
      var editor = ctx && ctx.querySelector('.fs-context-edit');
      var status = ctx && ctx.querySelector('.fs-context-status');
      var relT = document.querySelector('#content .fs-rel-title');
      var relF = document.querySelector('#content .fs-rel-folders');
      var prov = document.getElementById('row-provenance');
      var histEl = document.getElementById('record-history');
      var fldsEl = document.getElementById('record-fields');
      // The relationship folders + provenance belong to the Formatted (reading)
      // view; hide them while editing (raw markdown or fields) or reading history.
      [relT, relF, prov].forEach(function (el) { if (el) el.style.display = (md || hist || flds) ? 'none' : ''; });
      if (ctx) ctx.style.display = (hist || flds) ? 'none' : '';
      if (rendered) rendered.style.display = md ? 'none' : '';
      if (editor) editor.style.display = md ? '' : 'none';
      if (status) status.style.display = md ? '' : 'none';
      if (histEl) histEl.hidden = !hist;
      if (fldsEl) fldsEl.hidden = !flds;
      document.querySelectorAll('#content .fs-view-toggle [data-fsview]').forEach(function (b) {
        b.classList.toggle('on', !hist && !flds && b.getAttribute('data-fsview') === mode);
      });
    }

    function renderFsItem(content, segs, section) {
      section = section || 'folders';
      var myGen = renderGen;
      fsWalk(segs).then(function (crumbs) {
        var leaf = crumbs[crumbs.length - 1];
        if (!leaf || leaf.type !== 'node') throw new Error('Bad item path');
        var table = leaf.table, id = leaf.id, row = leaf.row;
        var t = tableByName(table);
        if (!t) { location.hash = '#/'; return; } // table removed → dashboard
        // The open record was deleted out from under the view — fall back to this
        // section's object page rather than repaint a tombstone (respect trash view).
        if (!row || (row.deleted_at && tableViewMode[table] !== 'trash')) {
          location.hash = sectionHref(section, [table]);
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
        // ONE record page for every row: files + artifacts flow through the same
        // chrome as regular records (toggle, sharing, provenance, connected
        // objects) — only the CONTENT section differs (preview/source vs the
        // rendered row context).
        var isFile = table === 'files';
        // A computed-view row is read-only: no Formatted|Markdown editing
        // toggle, no actions menu (the server refuses writes anyway), a
        // "Computed" badge, and a note saying where the values come from.
        var isComputed = !!(t && t.computedTable);
        var rels = fsRelations(table);
        if (myGen !== renderGen) return; // superseded by a newer navigation while fsWalk resolved
        var base = sectionHref(section, segs);
        var folderTiles = rels.map(function (rel) {
          // The connected object's OWN emoji (not a folder icon) — these are objects.
          var relIcon = displayFor(rel.targetTable || rel.token).icon;
          return '<a class="fs-tile fs-folder" href="' + base + '/' + encodeURIComponent(rel.token) + '">' +
            '<div class="fs-tile-icon">' + relIcon + '</div>' +
            '<div class="fs-tile-label">' + escapeHtml(rel.label) + '</div>' +
            '<div class="fs-folder-count" data-count-for="' + escapeHtml(rel.token) + '">…</div>' +
          '</a>';
        }).join('');
        currentRecordId = id;
        content.innerHTML =
          fsBreadcrumb(segs, crumbs, section) +
          '<div class="view-header">' +
            '<span class="entity-icon">' + (isFile ? fileEmoji(row) : d.icon) + '</span>' +
            '<h1>' + escapeHtml(fsDisplayName(row) || d.label) + '</h1>' +
            (isComputed ? '<span class="fs-computed-badge" title="A live, read-only view">Computed</span>' : '') +
            // Formatted = the rendered doc (or file preview); Markdown = the
            // editable raw markdown (or a file's source). The toggle shows one.
            // A computed row is read-only \u2014 neither the editing toggle nor the
            // actions menu is offered.
            (isComputed ? '' :
            '<div class="fs-view-toggle">' +
              '<button type="button" data-fsview="formatted">Formatted</button>' +
              '<button type="button" data-fsview="markdown">Markdown</button>' +
            '</div>' +
            '<div class="actions file-menu-wrap">' +
              '<button class="btn file-menu-btn" id="file-menu-btn" aria-haspopup="menu" aria-expanded="false" title="Actions">\u22ef</button>' +
              '<div class="file-menu" id="file-menu" role="menu" hidden>' +
                '<button class="file-menu-item" data-act="fields" role="menuitem">Edit fields</button>' +
                '<button class="file-menu-item" data-act="history" role="menuitem">Version history</button>' +
                '<button class="file-menu-item danger" data-act="delete" role="menuitem">Delete</button>' +
              '</div>' +
            '</div>') +
          '</div>' +
          (isComputed ? '<div class="fs-computed-note">This is a computed view \\u2014 its values come from the records it\\u2019s built from.</div>' : '') +
          detailVisLineEl(row) +
          // #fs-context holds BOTH the rendered doc (.fs-context-doc) and the
          // editable raw view (.fs-context-edit); the fillers below build them and
          // applyFsItemView toggles which one shows.
          '<div class="fs-context" id="fs-context" hidden></div>' +
          '<div class="file-history-view" id="record-history" hidden></div>' +
          '<div class="detail" id="record-fields" hidden></div>' +
          // "Connected objects" — the related objects, shown only when they actually
          // have rows (count > 0). Rendered hidden; revealed once the counts resolve.
          (rels.length ? '<h3 class="fs-rel-title" hidden>Connected objects</h3><div class="fs-grid fs-rel-folders" hidden>' + folderTiles + '</div>' : '') +
          '<div id="row-provenance"></div>';
        if (isFile) loadFileContext(content, segs, row);
        else if (isComputed) loadComputedContext(table, row);
        else loadFsContext(table, id);
        content.querySelectorAll('.fs-view-toggle [data-fsview]').forEach(function (bb) {
          bb.addEventListener('click', function () { setFsItemView(bb.getAttribute('data-fsview')); });
        });
        wireRecordMenu(content, segs, table, id, row);
        // A computed row has only the read-only Formatted view — never restore a
        // markdown/fields/history mode remembered from another record's chrome.
        if (isComputed) recordViewMode[id] = 'formatted';
        var rvm = recordViewMode[id] || 'formatted';
        if (rvm === 'history') loadRowHistoryInto(content, table, id);
        if (rvm === 'fields') loadFieldsEditor(content, segs, table, id, row, section);
        applyFsItemView();
        // A file under a registered folder root upgrades the breadcrumb to its
        // real folder path.
        if (isFile && row.ref_uri) {
          var crumbGen = renderGen;
          fetchJson('/api/sources/roots').then(function (data) {
            if (crumbGen !== renderGen) return;
            var nav = content.querySelector('.fs-crumbs');
            if (nav) nav.outerHTML = folderBreadcrumb(fsDirname(row.ref_uri), (data && data.roots) || [], fsDisplayName(row) || d.label);
          }).catch(function () { /* keep the default breadcrumb */ });
        }
        // Collapsed, lazy-loaded "Data provenance" panel for this row.
        renderProvenancePanel(content.querySelector('#row-provenance'), table, id);
        // Per-row sharing controls — same affordance as the advanced detail view.
        wireRowSharing(content, table, id, row, function () { renderFsItem(content, segs, section); });
        // Resolve every relation's count, then reveal ONLY the non-empty ones and
        // drop the empties — "Connected objects" lists objects with count > 0. If
        // none have rows, the whole section stays hidden (removed).
        if (rels.length) {
          Promise.all(rels.map(function (rel) {
            return fsRelatedRows(table, row, rel)
              .then(function (rs) { return { rel: rel, n: rs.length }; })
              .catch(function () { return { rel: rel, n: 0 }; });
          })).then(function (counts) {
            if (myGen !== renderGen) return;
            var any = false;
            counts.forEach(function (c) {
              var el = content.querySelector('[data-count-for="' + c.rel.token + '"]');
              var tile = el ? el.closest('.fs-tile') : null;
              if (c.n > 0) {
                any = true;
                if (el) el.textContent = c.n + (c.n === 1 ? ' item' : ' items');
              } else if (tile && tile.parentNode) {
                tile.parentNode.removeChild(tile);
              }
            });
            var title = content.querySelector('.fs-rel-title');
            var grid = content.querySelector('.fs-rel-folders');
            if (any) { if (title) title.hidden = false; if (grid) grid.hidden = false; }
            else {
              if (title && title.parentNode) title.parentNode.removeChild(title);
              if (grid && grid.parentNode) grid.parentNode.removeChild(grid);
            }
          });
        }
      }).catch(function (err) {
        if (myGen !== renderGen) return; // a stale error must not clobber a newer view
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ── Structured FIELDS editor (absorbed from the legacy detail view) ────
    // The record actions menu's "Edit fields": every column as a typed input
    // (fieldFor), belongsTo pickers, and the junction manager — chips unlink
    // with x, the dropdown links, both atomic (no Save needed); scalar fields
    // save with the Save button. Renders into #record-fields inside the
    // unified page; Cancel returns to the Formatted view.
    function loadFieldsEditor(content, segs, table, id, row, section) {
      var host = content.querySelector('#record-fields');
      if (!host) return;
      host.innerHTML = '<div class="muted" style="padding:8px">Loading\u2026</div>';
      var t = tableByName(table);
      if (!t) return;
      var intrinsic = intrinsicColumns(t);
      var belongsTo = belongsToColumns(t);
      var junctions = junctionsFor(table);
      var fetches = [];
      belongsTo.forEach(function (b) { fetches.push(loadAllRows(b.rel.table)); });
      junctions.forEach(function (j) {
        fetches.push(loadAllRows(j.junction));
        fetches.push(loadAllRows(j.remoteRel.table));
      });
      Promise.all(fetches).then(function () {
        var rows = [];
        intrinsic.forEach(function (c) {
          rows.push('<dt' + titleAttr(colDesc(table, c)) + '>' + escapeHtml(fieldLabel(c)) + '</dt><dd>' + fieldFor(c, row[c], t) + '</dd>');
        });
        belongsTo.forEach(function (b) {
          rows.push('<dt>' + escapeHtml(titleCase(b.relName)) + '</dt><dd>' + fieldFor(b.rel.foreignKey, row[b.rel.foreignKey], t) + '</dd>');
        });
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
              '<a class="chip-link" href="#/fs/' + encodeURIComponent(j.remoteRel.table) +
                '/' + encodeURIComponent(remoteId) + '">' + escapeHtml(displayNameFor(ref)) + '</a>' +
              ' <button class="remove-link" title="Unlink">\u00d7</button></span>';
          }).join(' ');
          var picker = available.length
            ? '<select class="dm-add"' +
                ' data-junction="' + escapeHtml(j.junction) + '"' +
                ' data-localfk="' + escapeHtml(j.localFk) + '"' +
                ' data-remotefk="' + escapeHtml(j.remoteRel.foreignKey) + '"' +
                ' data-local="' + escapeHtml(row.id) + '">' +
              '<option value="">+ Add link\u2026</option>' +
              available.map(function (o) {
                return '<option value="' + escapeHtml(o.id) + '">' + escapeHtml(displayNameFor(o)) + '</option>';
              }).join('') +
              '</select>'
            : '';
          rows.push('<dt>' + escapeHtml(titleCase(j.remoteRel.table)) + '</dt>' +
                    '<dd>' + (chips || '<span class="muted">None yet</span>') + ' ' + picker + '</dd>');
        });
        host.innerHTML =
          '<dl class="editing">' + rows.join('') + '</dl>' +
          '<div class="fs-fields-actions">' +
            '<button class="btn primary" id="save-row">Save</button>' +
            '<button class="btn" id="cancel-edit">Cancel</button>' +
          '</div>';
        var rerender = function () { renderFsItem(content, segs, section); };
        host.querySelectorAll('.remove-link').forEach(function (btn) {
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
            }).then(function () { rerender(); showToast('Link removed', { undo: undoLast }); })
              .catch(function (err) { showToast('Unlink failed: ' + err.message, {}); });
          });
        });
        host.querySelectorAll('select.dm-add').forEach(function (sel) {
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
            }).then(function () { rerender(); showToast('Linked', { undo: undoLast }); })
              .catch(function (err) { showToast('Link failed: ' + err.message, {}); });
          });
        });
        var cancel = host.querySelector('#cancel-edit');
        if (cancel) cancel.addEventListener('click', function () { setFsItemView('formatted'); });
        var save = host.querySelector('#save-row');
        if (save) save.addEventListener('click', function () {
          var values = collectFormValues(host.querySelector('dl'));
          rowWrite('PATCH', '/api/tables/' + encodeURIComponent(table) + '/rows/' + encodeURIComponent(id), values).then(function (r) {
            recordViewMode[id] = 'formatted';
            if (r && r.queued) { rerender(); return; }
            invalidate(table);
            return refreshEntities().then(function () {
              rerender();
              showToast('Saved', { undo: undoLast });
            });
          }).catch(function (err) { showToast('Save failed: ' + err.message, {}); });
        });
      }).catch(function (e) {
        host.innerHTML = '<div class="muted" style="padding:8px">Failed: ' + escapeHtml(e.message) + '</div>';
      });
    }

    // ── File/artifact CONTENT filler for the unified record page ─────────
    // Files and artifacts use the same page chrome as every other record; only
    // the #fs-context filler differs: Formatted = the inline preview (image /
    // PDF / sandboxed HTML / description banner, with Open in Finder), Markdown
    // = the source (an artifact edits in place; an ingested file's extracted
    // text is read-only).
    function sourceTextOf(row) {
      return row && typeof row.extracted_text === 'string' ? row.extracted_text : '';
    }
    function loadFileContext(content, segs, row) {
      var ctx = content.querySelector('#fs-context');
      if (!ctx) return;
      var src = sourceTextOf(row);
      var editHtml = row.artifact_type
        ? '<div class="fs-context-edit" style="display:none"><div class="file-source">' +
            '<textarea id="file-source-text" class="file-source-text" spellcheck="false">' + escapeHtml(src) + '</textarea>' +
            '<div class="file-source-actions"><button class="btn primary" id="file-source-save">Save</button>' +
            '<span class="muted" style="font-size:12px">Editing updates this artifact in place; older versions are kept in Version History.</span></div>' +
          '</div></div>'
        : '<div class="fs-context-edit" style="display:none"><pre class="file-source-pre">' + escapeHtml(src || 'No source text.') + '</pre></div>';
      ctx.innerHTML =
        '<div class="fs-context-doc"><div class="file-preview" id="file-preview"></div></div>' + editHtml;
      ctx.hidden = false;
      renderFilePreview(row);
      var save = ctx.querySelector('#file-source-save');
      if (save) save.addEventListener('click', function () { saveFileSource(content, segs, row.id); });
    }

    // Computed-row CONTENT filler: a read-only field list built from the row we
    // already fetched (a computed view renders no context markdown and has no
    // editable raw view — its values are derived, not authored).
    function loadComputedContext(table, row) {
      var ctx = document.getElementById('fs-context');
      if (!ctx) return;
      var t = tableByName(table);
      var cols = (t && t.columns) || Object.keys(row);
      var rows = cols.map(function (c) {
        return '<dt>' + escapeHtml(fieldLabel(c)) + '</dt><dd>' + fsValInner(table, row, c) + '</dd>';
      }).join('');
      ctx.innerHTML = '<div class="fs-context-doc"><dl class="fs-computed-fields">' + rows + '</dl></div>';
      ctx.hidden = false;
      if (typeof applyFsItemView === 'function') applyFsItemView();
    }

    // ONE document-level outside-click closer for the record actions menu. The
    // menu + button are re-created with stable ids on every record render, so a
    // per-render listener would leak. Registered exactly once; reads by id.
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
    // The record actions menu (every record page): Version history + Delete.
    function wireRecordMenu(content, segs, table, id, row) {
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
          if (menu) menu.hidden = true;
          var act = it.getAttribute('data-act');
          if (act === 'delete') { removeRow(table, segs, id, row); return; }
          if (act === 'fields') {
            loadFieldsEditor(content, segs, table, id, row, sectionOfHash());
            setFsItemView('fields');
            return;
          }
          loadRowHistoryInto(content, table, id);
          setFsItemView('history');
        });
      });
    }

    // Load the row's version history into the record page's history block.
    function loadRowHistoryInto(content, table, id) {
      var host = content.querySelector('#record-history');
      if (!host) return;
      host.innerHTML = '<div class="muted" style="padding:8px">Loading history\u2026</div>';
      fetchJson('/api/tables/' + encodeURIComponent(table) + '/rows/' + encodeURIComponent(id) + '/history')
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
            b.addEventListener('click', function () { revertRowVersion(table, b.getAttribute('data-rev')); });
          });
        })
        .catch(function (e) {
          host.innerHTML = '<div class="muted" style="padding:8px">Failed: ' + escapeHtml(e.message) + '</div>';
        });
    }

    function revertRowVersion(table, auditId) {
      fetch('/api/history/revert/' + encodeURIComponent(auditId), { method: 'POST' })
        .then(function (r) { if (!r.ok) throw new Error('revert failed (' + r.status + ')'); return r.json(); })
        .then(function () { invalidate(table); return refreshEntities(); })
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
          setFsItemView('formatted'); // back to the formatted view
          showToast('Saved', { undo: undoLast });
          renderFsItem(content, segs, sectionOfHash());
        })
        .catch(function (e) { showToast('Save failed: ' + e.message, {}); });
    }

    // Soft-delete (Delete): recoverable, and for a file NEVER touches the
    // on-disk bytes — it only soft-deletes the Lattice record.
    function removeRow(table, segs, id, row) {
      fetch('/api/tables/' + encodeURIComponent(table) + '/rows/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
        .then(function (r) { if (!r.ok) throw new Error('delete failed (' + r.status + ')'); return r.json(); })
        .then(function () { invalidate(table); return refreshEntities(); })
        .then(function () {
          showToast('Deleted "' + (fsDisplayName(row) || 'record') + '"', { undo: undoLast });
          // Navigate to the collection in the SAME section the record was opened
          // from (Folders/Graph/Tables) — a hard-coded #/fs would yank the user
          // out of Graph/Tables into Folders.
          location.hash = sectionHref(sectionOfHash(), [table]);
        })
        .catch(function (e) { showToast('Delete failed: ' + e.message, {}); });
    }

    // Click-to-edit on rendered values. Reuses fieldFor() for the input and the
    // same PATCH → invalidate → refreshEntities chain as the fields editor's save.
`;
