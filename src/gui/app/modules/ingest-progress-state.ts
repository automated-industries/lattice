// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const ingestProgressStateJs = `    // ────────────────────────────────────────────────────────────
    // Ingest progress rendering — state-driven, survives re-renders.
    // Maintains a single source of truth (state record) that tracks
    // both browser batch uploads and server folder ingests, painting
    // a persistent progress bar in the feed that re-mounts if needed
    // when the rail is rebuilt.
    // ────────────────────────────────────────────────────────────
    var ingestProgressState = null;
    // Returns { update(done, total, kind), done(kind) }. kind is optional ('browser' or 'server',
    // defaults to 'browser'). State is shared across both: update/done write to the shared
    // state record, then call the shared refresh function.
    function ingestProgress(total, kind) {
      kind = kind || 'browser';
      if (!ingestProgressState) {
        ingestProgressState = {
          done: 0,
          total: total,
          terminal: false,
          kind: kind,
        };
      } else {
        // A new batch is reusing live state (e.g. a second ingest starts right
        // after one finished). Cancel any pending terminal clear-out first, or
        // the old batch's timeout would remove the new batch's bar mid-run.
        if (ingestProgressState.__clearTimeout) {
          clearTimeout(ingestProgressState.__clearTimeout);
          ingestProgressState.__clearTimeout = null;
        }
        ingestProgressState.total = total;
        ingestProgressState.kind = kind;
        ingestProgressState.terminal = false;
      }
      refreshIngestProgressBar();
      return {
        update: function (n, t, k) {
          if (!ingestProgressState) {
            ingestProgressState = { done: n, total: t || total, terminal: false, kind: k || kind };
          } else {
            ingestProgressState.done = n;
            ingestProgressState.total = t || ingestProgressState.total;
            ingestProgressState.kind = k || ingestProgressState.kind;
          }
          refreshIngestProgressBar();
        },
        done: function () {
          if (ingestProgressState) ingestProgressState.terminal = true;
          refreshIngestProgressBar();
        },
      };
    }
    function refreshIngestProgressBar() {
      var feedEl = document.getElementById('rail-feed');
      if (!feedEl || !ingestProgressState) return;
      // Find the existing progress node or create one.
      var node = feedEl.querySelector('.ingest-progress');
      if (!node) {
        railEmptyGone();
        node = document.createElement('div');
        node.className = 'ingest-progress';
        // Build the structure ONCE. Rebuilding innerHTML every tick recreated the
        // fill node, so its width CSS transition never played (the bar jumped);
        // below we update the label text + fill width IN PLACE so it animates.
        node.innerHTML =
          '<div class="ingest-progress-label"></div>' +
          '<div class="ingest-progress-track"><div class="ingest-progress-fill"></div></div>';
        feedEl.insertBefore(node, feedEl.firstChild);
      }
      var s = ingestProgressState;
      // Terminal labels are past-tense and honest about a capped run: a server
      // ingest can finish with done < total (per-import limit), so it reports
      // "Ingested N of M files" rather than pretending the whole set landed.
      var labelText;
      if (s.terminal) {
        labelText = s.kind === 'server'
          ? ('Ingested ' + s.done + ' of ' + s.total + ' files')
          : ('Analyzed ' + s.total + ' file' + (s.total === 1 ? '' : 's'));
      } else {
        labelText = (s.kind === 'server' ? 'Ingesting' : 'Analyzing') + ' ' + s.done + ' of ' + s.total + ' files…';
      }
      var label = node.querySelector('.ingest-progress-label');
      if (label) label.textContent = labelText;
      var fill = node.querySelector('.ingest-progress-fill');
      if (fill) fill.style.width = Math.round((s.done / s.total) * 100) + '%';
      // After terminal, clear state and remove the node in ~2.5s. Re-query the
      // feed at fire time (not the captured feedEl) so a rail rebuilt during
      // the wait can't strand a zombie bar in the new tree.
      if (s.terminal && !ingestProgressState.__clearTimeout) {
        ingestProgressState.__clearTimeout = setTimeout(function () {
          var liveFeed = document.getElementById('rail-feed');
          var toRemove = liveFeed && liveFeed.querySelector('.ingest-progress');
          if (toRemove && toRemove.parentNode) toRemove.parentNode.removeChild(toRemove);
          ingestProgressState = null;
        }, 2500);
      }
    }
    // Clear the ingest progress bar AND its state entirely — used on a WORKSPACE switch.
    // An in-progress ingest belongs to the workspace you just left (its feed events go to
    // that workspace's feed, not the new one), so re-mounting it here would bleed a stale
    // bar into a workspace where nothing is ingesting. Remove the node + drop the state.
    function clearIngestProgress() {
      if (ingestProgressState && ingestProgressState.__clearTimeout) {
        clearTimeout(ingestProgressState.__clearTimeout);
      }
      ingestProgressState = null;
      var feedEl = document.getElementById('rail-feed');
      var node = feedEl && feedEl.querySelector('.ingest-progress');
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
`;
