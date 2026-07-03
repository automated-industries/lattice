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
      // Restore the persisted Outputs-column width synchronously, before any fetch,
      // so it's applied on the first paint (no width flash) and isn't gated behind
      // the async bootstrap. initOutputsResize re-applies it (idempotent) + wires
      // the drag handle once the app has booted.
      var savedOutputs = parseInt(window.localStorage.getItem(OUT_KEY) || '', 10);
      if (!isNaN(savedOutputs)) applyOutputsWidth(savedOutputs);
      // The version chip + manual-upgrade link live in the static shell (present
      // from first paint, in both the normal and virgin-state boots), so wire the
      // click handler and run the first availability check here — independent of
      // the async workspace bootstrap. checkServerVersion() refreshes it later.
      wireUpdateLink();
      checkUpdateAvailable();
      // Re-poll on a slow cadence so a window left open for hours/days still
      // surfaces a newer version. checkServerVersion() also refreshes this on
      // every socket reconnect, but a stable connection never reconnects, so a
      // long-open desktop/web window would otherwise never re-check.
      setInterval(checkUpdateAvailable, 30 * 60 * 1000);
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
        // Own catch so a read-degraded active workspace (its first data read 500s)
        // can't reject the whole boot — otherwise renderWsSwitcher below never runs
        // and the user is BRICKED (can't switch away from the broken workspace).
        fetchJson('/api/entities-summary').catch(function () { return { tables: [], __failed: true }; }),
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
        // Key the per-workspace navigation history to the booted workspace.
        if (results[5] && results[5].current && typeof navSetWorkspace === 'function') {
          navSetWorkspace(results[5].current, true);
        }
        state.analyticsEffective = !!(results[4] && results[4].analytics_effective);
        // local_open defaults true (the server defaults it on) — drives whether the
        // file view offers "Open in Finder". Treat a missing field as enabled.
        state.localOpen = !results[4] || results[4].local_open !== false;
        // Boot analytics with the resolved consent AND a stable, anonymized
        // client_id from the server, so a machine's reloads/relaunches collapse
        // into ONE user instead of one-per-session (the webview drops gtag's own
        // client-id cookie between sessions). The same identity fetch also yields
        // the operator email, hashed in-browser into the GA user_id for cross-
        // device dedup — the plaintext is never sent (analytics.ts only accepts a
        // hex digest). All best-effort: analytics still works if the fetch fails;
        // init makes NO network contact when consent is off.
        if (window.LatticeGA) {
          var gaEnabled = state.analyticsEffective;
          var startGa = function (clientId, emailHash) {
            window.LatticeGA.init(gaEnabled, clientId);
            if (emailHash) window.LatticeGA.setUser(emailHash);
            gaTrack('app_open', { advanced_mode: advancedMode() });
          };
          if (gaEnabled) {
            fetchJson('/api/userconfig/identity')
              .then(function (id) {
                var clientId =
                  id && id.analyticsClientId ? String(id.analyticsClientId) : undefined;
                var email = id && id.email ? String(id.email).trim().toLowerCase() : '';
                if (email && window.crypto && window.crypto.subtle) {
                  return window.crypto.subtle
                    .digest('SHA-256', new TextEncoder().encode(email))
                    .then(function (buf) {
                      var hex = Array.prototype.map
                        .call(new Uint8Array(buf), function (b) {
                          return ('0' + b.toString(16)).slice(-2);
                        })
                        .join('');
                      startGa(clientId, hex);
                    });
                }
                startGa(clientId, null);
                return undefined;
              })
              .catch(function () {
                startGa(undefined, null); // best-effort — GA still functions without ids
              });
          } else {
            startGa(undefined, null);
          }
        }
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
        // The active workspace opened but its data couldn't be read — the switcher
        // is mounted (above), so surface a clear escape hatch instead of a blank pane.
        if (results[0] && results[0].__failed) {
          var failEl = document.getElementById('content');
          if (failEl) failEl.innerHTML =
            '<div class="placeholder"><h2>This workspace could not load</h2>' +
            '<p>Its data could not be read. Pick another workspace from the switcher above, ' +
            'or check the database connection, then reload.</p></div>';
        }
        startEventStream();
        // Kick the stale-connector sync (fire-and-forget): in a fresh process
        // connector/database tables only exist after their first sync registers
        // them — without this they stay invisible until a manual refresh. The
        // server no-ops when nothing is stale.
        fetch('/api/connectors/sync-if-stale', { method: 'POST' }).catch(function () {});
        fetch('/api/db-sources/sync-if-stale', { method: 'POST' }).catch(function () {});
        initLastEdited();
        initOffline();
        initOutputsResize();
        initColumnCollapse();
        initWireMerge();
        initAskLattice();
        initActivityHeader();
        renderOutputs();
        renderComposer();
        initThreadControls();
        // Warm up on-device voice in the background shortly after boot so dictation
        // is ready on first use — no visible model-loading step, ever.
        if (typeof voicePreload === 'function') setTimeout(voicePreload, 1500);
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
