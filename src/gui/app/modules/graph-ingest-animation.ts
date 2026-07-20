// Auto-composed segment of the GUI client script (see modules/index.ts). Live
// brain-graph ingestion: on a source:'ingest' feed burst, while the graph is the
// visible view, re-fetch the authoritative graph and hand the fresh node/edge set
// to the LIVE force renderer — which animates the delta for free (new nodes fly in
// from the center and the layout reheats). Must stay INSIDE the client IIFE;
// inserted after systemTablesJs (it uses schemaGraphHandle/buildSchemaModel/
// schemaGraphData/graphModelCache from that segment).
export const graphIngestAnimationJs = `
    var graphIngestTimer = null;
    // The live ingest animation only applies to the TOP-LEVEL schema graph
    // (#/graph), whose nodes are tables. The entity drill-down graph
    // (#/graph/<obj>) reuses the same #graph-mount + schemaGraphHandle but its
    // nodes are ROWS ("table:rowId"); pushing the schema (table) node set at it
    // via setData would remove every row node and silently swap in the wrong
    // graph. Gate on the exact top-level hash — same guard wiremerge uses.
    function graphIngestAnimApplies() {
      return location.hash === '#/graph' && !!document.getElementById('graph-mount');
    }
    function scheduleGraphIngestAnim() {
      // Only animate when the TOP-LEVEL brain graph is the active view.
      if (!graphIngestAnimApplies()) return;
      if (graphIngestTimer) clearTimeout(graphIngestTimer);
      graphIngestTimer = setTimeout(runGraphIngestAnim, 250);
    }

    function graphReducedMotion() {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function runGraphIngestAnim() {
      // Re-check on fire: the 250ms debounce may have outlived a navigation from
      // #/graph to a drill-down (#/graph/<obj>) or away entirely. Only the
      // top-level schema graph may receive the table-node delta.
      if (!graphIngestAnimApplies()) return;
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
          // Re-check the route AFTER the async fetch — a drill-in during the
          // round-trip must not receive the schema (table) node delta.
          if (!graphIngestAnimApplies()) return;
          if (!schemaGraphHandle) { renderSchemaGraph(); return; }
          var model = buildSchemaModel(graph);
          if (!model.nodes.length) return;
          graphModelCache = model;
          // Cancel any in-flight opening wave-reveal: it replays a STALE node
          // prefix (captured before this ingest) and its next wave's setData
          // would remove the node we're about to add. Bumping graphRevealGen
          // stops the wave loop; this ingest paints the full authoritative set
          // at once, which supersedes the progressive reveal.
          if (typeof graphRevealGen !== 'undefined') graphRevealGen++;
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
