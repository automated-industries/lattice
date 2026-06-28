// Auto-composed segment of the GUI client script (see modules/index.ts). Live
// brain-graph ingestion: on a source:'ingest' feed burst, while the graph is the
// visible view, re-fetch the authoritative graph and hand the fresh node/edge set
// to the LIVE force renderer — which animates the delta for free (new nodes fly in
// from the center and the layout reheats). Must stay INSIDE the client IIFE;
// inserted after systemTablesJs (it uses schemaGraphHandle/buildSchemaModel/
// schemaGraphData/graphModelCache from that segment).
export const graphIngestAnimationJs = `
    var graphIngestTimer = null;
    function scheduleGraphIngestAnim() {
      // Only animate when the brain graph is actually mounted (the active view).
      if (!document.getElementById('graph-mount')) return;
      if (graphIngestTimer) clearTimeout(graphIngestTimer);
      graphIngestTimer = setTimeout(runGraphIngestAnim, 250);
    }

    function graphReducedMotion() {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function runGraphIngestAnim() {
      // Need both the mounted view and a live handle to feed.
      if (!document.getElementById('graph-mount') || !schemaGraphHandle) return;
      var myGen = renderGen;
      fetchJson('/api/graph')
        .then(function (graph) {
          if (renderGen !== myGen) return; // navigated away mid-fetch
          if (!document.getElementById('graph-mount') || !schemaGraphHandle) return;
          var model = buildSchemaModel(graph);
          if (!model.nodes.length) return;
          graphModelCache = model;
          // Hand the authoritative set to the live engine; it diffs by id, flies
          // in new nodes from the center, and reheats — no manual delta animation.
          var data = schemaGraphData(model);
          schemaGraphHandle.setData(data.nodes, data.edges);
        })
        .catch(function () {
          /* best-effort delight; never disrupt ingest */
        });
    }
`;
