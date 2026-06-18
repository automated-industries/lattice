// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const toastJs = `    // ────────────────────────────────────────────────────────────
    // Workspace-switch progress on the STABLE header button.
    // The old menu-item spinner (withBusy on the open-menu db-item) is lost the
    // moment the menu closes or rebuilds mid-switch. We additionally surface
    // "switching" on the always-visible #ws-button for the ENTIRE switch (POST +
    // reloadEverything), so the user always sees a live signal. The menu-item
    // withBusy spinner is kept too.
    // ────────────────────────────────────────────────────────────
    var wsSwitching = false;
    function beginWsSwitching() {
      wsSwitching = true;
      var btn = document.getElementById('ws-button');
      var nameEl = document.getElementById('ws-name');
      var iconEl = btn && btn.querySelector('.db-icon');
      if (btn) { btn.classList.add('is-switching'); btn.classList.remove('is-switch-error'); }
      if (iconEl) iconEl.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
      if (nameEl) nameEl.textContent = 'Switching…';
    }
    function endWsSwitching(failed) {
      wsSwitching = false;
      var btn = document.getElementById('ws-button');
      var iconEl = btn && btn.querySelector('.db-icon');
      if (iconEl) iconEl.textContent = '📂';
      if (btn) {
        btn.classList.remove('is-switching');
        if (failed) btn.classList.add('is-switch-error');
        else btn.classList.remove('is-switch-error');
      }
      // The label writes inside reloadEverything ran while wsSwitching was still
      // true (guarded out to preserve "Switching…"), and they already completed
      // BEFORE this call — so nothing else will apply the NEW workspace name. Now
      // that the switch resolved, re-render the switcher so the real name lands
      // (otherwise #ws-name stays stuck on "Switching…").
      if (!failed) {
        fetchJson('/api/workspaces')
          .then(function (d) {
            if (d) renderWsSwitcher(d);
          })
          .catch(function () {
            /* best-effort: the next reload re-renders the switcher anyway */
          });
      }
    }

    // The default topbar mark (the inline Lattice SVG), captured the first time
    // applyWorkspaceLogo runs so "remove logo" can restore it without a reload.
    var defaultBrandMark = null;
    // Swap the topbar brand-logo node for the cloud owner's logo (an <img> served
    // by /api/cloud/workspace-logo, cache-busted by the content etag). A null/empty
    // etag restores the default mark. Fail-safe: any error leaves the default.
    function applyWorkspaceLogo(logoEtag) {
      try {
        var brand = document.querySelector('.brand');
        if (!brand) return;
        var cur = brand.querySelector('.brand-logo');
        if (!cur) return;
        if (!defaultBrandMark && cur.tagName.toLowerCase() === 'svg') {
          defaultBrandMark = cur.cloneNode(true);
        }
        if (!logoEtag) {
          // Remove → restore the default mark (skip if it's already the SVG).
          if (defaultBrandMark && cur.tagName.toLowerCase() !== 'svg') {
            cur.replaceWith(defaultBrandMark.cloneNode(true));
          }
          return;
        }
        var img = document.createElement('img');
        img.className = 'brand-logo';
        img.alt = 'Workspace logo';
        img.src = '/api/cloud/workspace-logo?v=' + encodeURIComponent(logoEtag);
        img.onerror = function () {
          if (defaultBrandMark && img.parentNode) {
            img.parentNode.replaceChild(defaultBrandMark.cloneNode(true), img);
          }
        };
        cur.replaceWith(img);
      } catch (e) {
        /* any failure → the default mark stays */
      }
    }

    var wsOutsideClickBound = false;
    function renderWsSwitcher(data) {
      activeWsId = (data && data.current) || null; // keys the per-workspace chat-thread memory
      var wrap = document.getElementById('ws-switcher');
      var btn = document.getElementById('ws-button');
      var menu = document.getElementById('ws-menu');
      var nameEl = document.getElementById('ws-name');
      if (!wrap || !btn || !menu || !nameEl) return;
      // The workspace switcher is the SINGLE switcher: every database — local or
      // cloud, created or joined — is a workspace under the .lattice root, and
      // the GUI always has a root (see ensureRootForGui). No database mode.
      wrap.hidden = false;
      var list = (data && data.workspaces) || [];
      var current = list.filter(function (w) { return w.id === (data && data.current); })[0];
      // Don't clobber the "Switching…" label/icon while a switch is in flight —
      // renderWsSwitcher runs mid-reload, and the new workspace label should only
      // land once the switch resolves (endWsSwitching → next render).
      if (!wsSwitching) nameEl.textContent = (current && current.label) || 'workspace';
      var curKind = (current && current.kind) || 'local';
      setStatusPill(curKind, curKind === 'cloud' ? 'connecting' : 'local');

      function buildMenu() {
        var currentId = data && data.current;
        var items = list.map(function (w) {
          var isCurrent = w.id === currentId;
          var isCloud = w.kind === 'cloud';
          var dotClass = isCloud ? 'is-cloud-connected' : '';
          var chipText = isCloud ? 'Cloud' : 'Local';
          var chipBg = isCloud ? 'var(--accent-soft)' : 'rgba(255,255,255,0.06)';
          var chipColor = isCloud ? 'var(--accent)' : 'var(--text-muted)';
          return '<button class="db-item' + (isCurrent ? ' active' : '') +
            '" data-id="' + escapeHtml(w.id) + '">' +
            '<span class="db-item-status db-status ' + dotClass + '" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' +
              (isCloud ? 'var(--accent)' : 'var(--warn)') +
            ';flex-shrink:0"></span>' +
            '<span style="flex:1;text-align:left">' + escapeHtml(w.label) + '</span>' +
            '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:' + chipBg + ';color:' + chipColor + ';text-transform:uppercase;letter-spacing:0.04em">' + chipText + '</span>' +
            '</button>';
        }).join('');
        menu.innerHTML =
          '<div class="db-section">Workspaces</div>' + items +
          '<div class="db-create">' +
            '<button class="btn primary" id="ws-create-btn" style="width:100%;">+ New workspace…</button>' +
          '</div>';
        menu.querySelectorAll('button.db-item').forEach(function (b) {
          b.addEventListener('click', function () {
            var id = b.getAttribute('data-id');
            if (id === currentId) { menu.hidden = true; return; }
            gaTrack('workspace_switch', {}); // event only — never the workspace id/name
            // Surface "switching" on the stable header button for the WHOLE
            // switch (POST + reloadEverything), independent of the ephemeral
            // menu-item withBusy spinner — the menu can close/rebuild mid-switch.
            beginWsSwitching();
            // Repaint the content area to a loading frame IMMEDIATELY so the
            // switch shows the new workspace opening — a cloud open is several
            // network round-trips — rather than leaving the previous workspace's
            // view frozen on screen. Bumping renderGen invalidates any in-flight
            // render from the workspace being left so it can't clobber this.
            renderGen++;
            var switchContent = document.getElementById('content');
            if (switchContent) switchContent.innerHTML = routeLoadingHtml();
            withBusy(b, function () {
              return fetchJson('/api/workspaces/switch', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: id }),
              }).then(function () {
                // Keep the menu OPEN with the item's spinner through the reload —
                // for a CLOUD workspace the slow part (connecting + fetching
                // against the remote DB) happens here in reloadEverything, AFTER
                // the switch POST. Hiding the menu now (the old behavior) hid the
                // only progress signal, so a cloud switch looked unresponsive.
                // renderWsSwitcher (inside reloadEverything) only re-binds the
                // toggle + updates the label, so the spinning item survives.
                return reloadEverything();
              }).then(function () {
                menu.hidden = true;
                endWsSwitching(false);
                // Conversations + activity both live in the workspace DB. Drop
                // the old workspace's thread + activity cards, reconnect the feed
                // to THIS workspace, and reload its thread list (+ latest convo).
                newChat();
                clearActivityFeed();
                refreshThreadList(true);
                showToast('Switched workspace', {});
              }).catch(function (err) { menu.hidden = true; endWsSwitching(true); showToast('Switch failed: ' + err.message, {}); });
            });
          });
        });
        // Create + Join both live in the 3-step wizard (local / cloud / join) —
        // the single entry point for adding any workspace.
        document.getElementById('ws-create-btn').addEventListener('click', function () {
          menu.hidden = true;
          showCreateDatabaseWizard();
        });
      }

      btn.onclick = function (e) {
        e.stopPropagation();
        if (menu.hidden) buildMenu();
        menu.hidden = !menu.hidden;
      };
      // Attach the outside-click closer ONCE — renderWsSwitcher runs on every
      // reload, so adding it each time leaked a listener per render. Re-fetch
      // the elements by id inside the handler so it never holds a stale closure.
      if (!wsOutsideClickBound) {
        wsOutsideClickBound = true;
        document.addEventListener('click', function (e) {
          var m = document.getElementById('ws-menu');
          var b = document.getElementById('ws-button');
          if (!m || m.hidden) return;
          if (!m.contains(e.target) && e.target !== b && (!b || !b.contains(e.target))) {
            m.hidden = true;
          }
        });
      }
    }

    /** Reload icon overrides after a save, then re-render the current view. */
    function refreshIcons() {
      return fetchJson('/api/gui-meta').then(function (data) {
        state.iconOverrides = data || {};
        renderSidebar();
        renderRoute();
      });
    }

    window.addEventListener('hashchange', renderRoute);

`;
