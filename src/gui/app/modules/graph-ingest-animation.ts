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
      // The graph view must be mounted; bail otherwise.
      if (!document.getElementById('graph-mount')) return;
      // If the graph mounted while the workspace was EMPTY there is no live handle
      // yet (renderSchemaGraph painted the empty-state and returned). setData only
      // updates an existing renderer, so the first objects ingested would never
      // appear. A full re-render builds the handle and paints them — realtime, as
      // files stream in. Once a handle exists, take the cheap setData delta path.
      if (!schemaGraphHandle) { renderSchemaGraph(); return; }
      var myGen = renderGen;
      fetchJson('/api/graph?schema=1')
        .then(function (graph) {
          if (renderGen !== myGen) return; // navigated away mid-fetch
          if (!document.getElementById('graph-mount')) return;
          if (!schemaGraphHandle) { renderSchemaGraph(); return; }
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
