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
        // Update total if it differs (e.g., server ingest starts after browser batch).
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
        feedEl.insertBefore(node, feedEl.firstChild);
      }
      var s = ingestProgressState;
      var label = s.kind === 'server' ? 'Ingesting' : 'Analyzing';
      var labelText = s.terminal
        ? (label + ' ' + s.total + ' file' + (s.total === 1 ? '' : 's'))
        : (label + ' ' + s.done + ' of ' + s.total + ' files…');
      node.innerHTML =
        '<div class="ingest-progress-label">' + labelText + '</div>' +
        '<div class="ingest-progress-track"><div class="ingest-progress-fill"></div></div>';
      var fill = node.querySelector('.ingest-progress-fill');
      if (fill) fill.style.width = Math.round((s.done / s.total) * 100) + '%';
      // After terminal, clear state and remove the node in ~2.5s.
      if (s.terminal && !ingestProgressState.__clearTimeout) {
        ingestProgressState.__clearTimeout = setTimeout(function () {
          var toRemove = feedEl.querySelector('.ingest-progress');
          if (toRemove && toRemove.parentNode) toRemove.parentNode.removeChild(toRemove);
          ingestProgressState = null;
        }, 2500);
      }
    }
    // Re-mount the ingest progress bar after the feed is rebuilt (e.g., thread/workspace switch).
    function remountIngestProgressBar() {
      if (ingestProgressState && !ingestProgressState.terminal) {
        refreshIngestProgressBar();
      }
    }
`;
