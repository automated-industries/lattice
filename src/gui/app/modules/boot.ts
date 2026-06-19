// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const bootJs = `    // ────────────────────────────────────────────────────────────
    // Boot
    // ────────────────────────────────────────────────────────────
    // Global boot interstitial (Feature C). Idempotent: fades the overlay out,
    // clears aria-busy, then hides it after the 0.25s fade. Wired to init() ONLY
    // (every terminal path + a failsafe) — never to a workspace switch.
    var appLoadingHidden = false;
    function hideAppLoading() {
      if (appLoadingHidden) return;
      appLoadingHidden = true;
      var el = document.getElementById('app-loading');
      if (!el) return;
      el.classList.add('is-hidden');
      el.removeAttribute('aria-busy');
      setTimeout(function () { el.hidden = true; }, 250);
    }

    function init() {
      // Restore the persisted rail width synchronously, before any fetch, so it's
      // applied on the first paint (no width flash) and isn't gated behind the
      // async bootstrap. initRailResize re-applies it (idempotent) + wires the
      // drag handle once the app has booted.
      var savedRail = parseInt(window.localStorage.getItem(RAIL_KEY) || '', 10);
      if (!isNaN(savedRail)) applyRailWidth(savedRail);
      // The version chip + manual-upgrade link live in the static shell (present
      // from first paint, in both the normal and virgin-state boots), so wire the
      // click handler and run the first availability check here — independent of
      // the async workspace bootstrap. checkServerVersion() refreshes it later.
      wireUpdateLink();
      checkUpdateAvailable();
      // Failsafe: never leave the overlay up forever if a fetch hangs without
      // rejecting, or a future early-return (e.g. the virgin-state screen)
      // bypasses the .then() tail. Idempotent, so a later real hide is a no-op.
      setTimeout(hideAppLoading, 9000);
      // Registry first (DB-free): when the server reports virgin:true there is NO
      // active DB, so the boot data routes would 409 — show the first-run welcome
      // screen and skip the data bootstrap. Gate on the server's virgin flag, NOT
      // an empty workspace list: a plain --config GUI has an active DB but no
      // .lattice registry (empty list) and must still boot normally.
      fetchJson('/api/workspaces').catch(function () { return null; }).then(function (wsBoot) {
        if (wsBoot && wsBoot.virgin === true) {
          renderVirginState();
          hideAppLoading();
          return undefined;
        }
        return bootWorkspace();
      }).catch(function (err) {
        var content = document.getElementById('content');
        if (content) content.innerHTML =
          '<div class="placeholder"><h2>Failed to load</h2>' + escapeHtml(err.message) + '</div>';
        hideAppLoading();
      });
    }

    function bootWorkspace() {
      return Promise.all([
        fetchJson('/api/entities'),
        fetchJson('/api/gui-meta').catch(function () { return {}; }),
        fetchJson('/api/gui-meta/columns').catch(function () { return {}; }),
        fetchJson('/api/system-tables').catch(function () { return { tables: [] }; }),
        fetchJson('/api/userconfig/preferences').catch(function () { return { show_system_tables: false, analytics: true }; }),
        fetchJson('/api/workspaces').catch(function () { return null; }),
        fetchJson('/api/dbconfig').catch(function () { return {}; }),
      ]).then(function (results) {
        state.entities = results[0];
        state.iconOverrides = results[1] || {};
        state.columnMeta = results[2] || {};
        state.systemTables = (results[3] && results[3].tables) || [];
        state.preferences = results[4] || { show_system_tables: false, analytics: true };
        state.analyticsEffective = !!(results[4] && results[4].analytics_effective);
        // local_open defaults true (the server defaults it on) — drives whether the
        // file view offers "Open in Finder". Treat a missing field as enabled.
        state.localOpen = !results[4] || results[4].local_open !== false;
        // Boot analytics with the resolved consent (no network contact when off),
        // then record the session open. advanced_mode is a boolean — safe to send.
        if (window.LatticeGA) window.LatticeGA.init(state.analyticsEffective);
        // Deduplicate unique users in GA: set the GA user_id to a SHA-256 hash of
        // the operator's email. Anonymized — the plaintext is hashed in-browser and
        // never sent (analytics.ts only accepts a hex digest). Without a user_id,
        // GA counts each session/device as a new user (active-users ≈ events).
        // Best-effort + only when analytics consent is on.
        if (window.LatticeGA && state.analyticsEffective && window.crypto && window.crypto.subtle) {
          fetchJson('/api/userconfig/identity')
            .then(function (id) {
              var email = id && id.email ? String(id.email).trim().toLowerCase() : '';
              if (!email) return undefined;
              return window.crypto.subtle
                .digest('SHA-256', new TextEncoder().encode(email))
                .then(function (buf) {
                  var hex = Array.prototype.map
                    .call(new Uint8Array(buf), function (b) {
                      return ('0' + b.toString(16)).slice(-2);
                    })
                    .join('');
                  window.LatticeGA.setUser(hex);
                });
            })
            .catch(function () {
              /* best-effort — GA still functions without a user_id */
            });
        }
        gaTrack('app_open', { advanced_mode: advancedMode() });
        document.body.classList.toggle('advanced-mode', advancedMode());
        wireSettingsDrawer();
        renderWsSwitcher(results[5]);
        // Swap the default topbar mark for the cloud owner's logo (if set). Null
        // logoEtag (local workspace / unset) leaves the default Lattice SVG.
        applyWorkspaceLogo((results[6] || {}).logoEtag);
        renderSidebar();
        wireHistoryControls();
        refreshHistoryState();
        renderRoute();
        startEventStream();
        initSearch();
        initLastEdited();
        initOffline();
        initRailResize();
        initRailDrawer();
        initRailDragDrop();
        renderComposer();
        initThreadControls();
        checkNativeSetup();
        // App is fully populated — reveal it (Feature C).
        hideAppLoading();
      }).catch(function (err) {
        document.getElementById('content').innerHTML =
          '<div class="placeholder"><h2>Failed to load</h2>' + escapeHtml(err.message) + '</div>';
        // Reveal the error rather than leaving a permanent spinner (no silent
        // failure masked behind the interstitial).
        hideAppLoading();
      });
    }

`;
