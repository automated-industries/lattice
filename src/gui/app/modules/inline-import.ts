// Auto-composed segment of the GUI client script. The structured-source importer
// is reachable ONLY by dropping a file into the assistant chat: an upload that the
// server recognizes as a structured source comes back with an autoImport proposal,
// and this segment imports it — with NO decisions to make. There is no confirm card
// and no modal: every recognized case (a brand-new dataset, a known-document
// re-import) materializes silently through the apply route. Running an import is a
// long background job, so it reports through the shared background-task tracker in the
// activity menu, next to ingestion and renders — nothing is painted into the
// conversation. Reuses the shared globals defined earlier in the composed script:
// bgTask, refreshEntities, renderSidebar, renderRoute, state. Like every segment this
// is ONE template literal — no raw backticks or ${...} inside (they would break the
// literal).
export const inlineImportJs = `
    // ── Inline structured-source import (confirm card in the assistant rail) ──
    function iiRailFeed() { return document.getElementById('rail-feed'); }
    function iiRailEmptyGone() {
      var e = document.getElementById('rail-empty');
      if (e) e.parentNode && e.parentNode.removeChild(e);
    }

    // The background-task tracker (bgTask) is declared inside the main client
    // closure, which has already ended by the time this segment runs — the same
    // scope boundary iiBatchIngestActive crosses in the other direction. The
    // closure hands it over on window; see the data-model segment.
    // An import with nowhere to report its progress would run invisibly, so a
    // missing tracker is a hard error, raised BEFORE any work starts rather than
    // swallowed into a silent import.
    // This segment is composed INSIDE the main client IIFE, so the tracker is a
    // direct wrapper-scope reference. Still guarded: an import that cannot report
    // progress must fail before it starts rather than run somewhere invisible.
    function iiTracker() {
      if (typeof bgTask !== 'function') {
        throw new Error('Background-task tracker unavailable — cannot report import progress');
      }
      return bgTask;
    }

    // Auto-run the data-model planner on the freshly-imported tables — it applies safe
    // normalizations immediately (and surfaces the rest as one-click suggestions in the
    // Data Model panel), so an import lands already-tidied instead of needing a manual
    // reorg. Fire-and-forget + a re-refresh so any auto-applied change shows right away.
    function iiAutoTidy() {
      fetch('/api/data-model/plan')
        .then(function () { return refreshEntities(); })
        .then(function () { renderSidebar(); renderRoute(); })
        .catch(function () {});
    }

    // In-progress signal so a chat turn can be made AWARE that ingestion is running: the
    // composer passes ingestOrImportActive() to /api/chat and the server tells the model
    // some data may still be loading. Counts silent structured imports PLUS any browser/
    // server file-ingest batch (the shared ingestProgressState).
    var iiActiveImports = 0;
    // ingestProgressState (browser/server file-ingest batches) lives inside an EARLIER IIFE
    // and is NOT in scope here, so the batch-ingest signal is mirrored onto this outer-scope
    // flag by the progress renderer (ingest-progress-state sets it on every state change).
    // Structured imports count via iiActiveImports.
    var iiBatchIngestActive = false;
    function ingestOrImportActive() {
      return iiActiveImports > 0 || iiBatchIngestActive;
    }

    // Read a newline-delimited-JSON response body, invoking onEvent(obj) per line.
    // Self-contained on purpose — this segment must not depend on any other.
    function iiStreamNdjson(url, payload, onEvent) {
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

    // Dispatch an upload's autoImport proposal. Every recognized case imports silently —
    // no confirm card, no decisions. A brand-new dataset creates its tables directly; a
    // known-dataset re-import with no detectable date is filed by the apply route as a NEW
    // dated snapshot (the import date), so the prior import is preserved rather than
    // overwritten. There is nothing to ask.
    function handleAutoImport(autoImport) {
      if (!autoImport || !autoImport.reason) return;
      runInlineImportSilent(autoImport);
    }

    // One tracked task per import, so a batch drop that produces several structured
    // sources gets a row each instead of overwriting one shared task.
    function iiTaskId(fileId) { return 'import:' + String(fileId); }

    // Silent import: materialize every base table + row plus ALL detected computed views
    // immediately (no opt-in UI) — there is no Apply gate. Marginal/uncertain links are left
    // as plain columns and reported on the feed (the apply route never fabricates them).
    // Progress is reported on the background-task tracker; nothing about the run is painted
    // into the conversation.
    function runInlineImportSilent(autoImport) {
      if (!autoImport || !autoImport.fileId) return;
      var bg = iiTracker(); // throws before any work starts if there is nowhere to report
      iiActiveImports++; // chat-awareness: a turn sent now knows the import is running
      // Auto-select every detected computed view (the silent path has no opt-in card).
      var computedSel = (autoImport.computedProposals || []).map(function (p) {
        return { table: p.table, fields: (p.fields || []).map(function (f) { return f.name; }) };
      });
      var taskId = iiTaskId(autoImport.fileId);
      var task = bg(taskId, { label: 'Importing your data…' });
      iiStreamNdjson('/api/import/apply', {
        fileId: autoImport.fileId,
        mode: 'both',
        // Use the document's OWN reporting date when one was confidently detected
        // (autoImport.asOf, e.g. a period-end in the file), so a brand-new dataset is
        // filed under the date it reports rather than the day it happened to be
        // imported. Absent a detected date, '' lets the apply route stamp the import
        // day as the snapshot date (its no-overwrite default).
        asOf: autoImport.asOf || '',
        asOfColumn: '',
        // Echo the threshold the proposal was inferred under so apply bands links identically.
        linkConfidence: autoImport.linkConfidence,
        computed: computedSel,
      }, function (evt) {
        if (!evt) return;
        if (evt.phase === 'done') {
          iiActiveImports = Math.max(0, iiActiveImports - 1);
          var r = evt.result || {};
          var rbt = r.rowsByTable || {};
          var names = Object.keys(rbt);
          var total = 0;
          names.forEach(function (n) { total += (rbt[n] || 0); });
          var summary = 'Imported ' + names.length + ' table' + (names.length === 1 ? '' : 's') +
            ', ' + total + ' row' + (total === 1 ? '' : 's');
          // The rows have landed but the views still show the old shape, so the
          // task stays running until the refresh completes.
          bg(taskId, { label: 'Updating your objects…' });
          refreshEntities().then(function () {
            renderSidebar();
            renderRoute();
            task.done(summary);
            iiAutoTidy();
          }).catch(function () {
            task.fail('Imported, but refreshing the view failed — reload to see your objects.');
          });
        } else if (evt.phase === 'error') {
          iiActiveImports = Math.max(0, iiActiveImports - 1);
          // A passive drop that could not be modeled as tables is NOT data loss — the file was
          // already saved as a reference you can open. Say that instead of "Import failed".
          task.fail((evt.message || 'Could not model this as tables') + ' — kept as a file you can open');
        } else if (evt.message) {
          bg(taskId, { label: evt.message });
        }
      });
    }
`;
