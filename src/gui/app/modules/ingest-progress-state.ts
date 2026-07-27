// Auto-composed segment of the GUI client script (see modules/index.ts). Ingest
// progress is now surfaced through the unified activity-menu BACKGROUND-TASK
// tracker (bgTask) instead of a bespoke sticky bar in the assistant feed. A single
// 'ingest' task tracks both browser batch uploads and server folder ingests;
// iiBatchIngestActive still mirrors the active state for the chat composer's
// ingestion-awareness. Must stay INSIDE the client IIFE (uses bgTask, hoisted).
export const ingestProgressStateJs = `
    var ingestProgressState = null;

    // Terminal labels are past-tense and honest about a capped run: a server
    // ingest can finish with done < total (per-import limit), so it reports
    // "Ingested N of M files" rather than pretending the whole set landed.
    //
    // A single-file job is phrased in the singular. A detached upload publishes
    // its stages as total:1 frames, and "Ingesting 0 of 1 files…" reads like a
    // stalled batch rather than one file being worked on.
    function ingestProgressLabel(s) {
      var one = s.total === 1;
      if (s.terminal) {
        if (s.kind === 'server') {
          return one && s.done === 1
            ? 'Ingested your file'
            : 'Ingested ' + s.done + ' of ' + s.total + ' files';
        }
        return one ? 'Analyzed your file' : 'Analyzed ' + s.total + ' files';
      }
      if (one) return s.kind === 'server' ? 'Ingesting your file…' : 'Analyzing your file…';
      return (s.kind === 'server' ? 'Ingesting' : 'Analyzing') + ' ' + s.done + ' of ' + s.total + ' files…';
    }

    function refreshIngestProgressBar() {
      // Mirror the batch-ingest active state onto the outer-scope flag the chat
      // composer reads for ingestion-awareness.
      iiBatchIngestActive = !!(ingestProgressState && !ingestProgressState.terminal);
      var s = ingestProgressState;
      if (!s) return;
      // Upsert the single 'ingest' task with the live label + progress; a
      // determinate total draws the tracker's progress bar.
      var h = bgTask('ingest', { label: ingestProgressLabel(s), total: s.total, done: s.done });
      if (s.terminal) {
        h.done(ingestProgressLabel(s)); // lingers briefly, then auto-removes
        ingestProgressState = null;
      }
    }

    // Returns { update(done, total, kind), done(kind) }. kind is optional
    // ('browser' or 'server', defaults to 'browser'). State is shared across both.
    function ingestProgress(total, kind) {
      kind = kind || 'browser';
      ingestProgressState = { done: 0, total: total, terminal: false, kind: kind };
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

    // Clear the ingest task AND its state entirely — used on a WORKSPACE switch.
    // An in-progress ingest belongs to the workspace you just left (its feed
    // events go to that workspace's feed, not the new one), so carrying it into
    // the new workspace would bleed a stale task where nothing is ingesting.
    function clearIngestProgress() {
      ingestProgressState = null;
      iiBatchIngestActive = false;
      clearBgTask('ingest');
    }
`;
