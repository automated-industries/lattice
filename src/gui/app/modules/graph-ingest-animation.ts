// Auto-composed segment of the GUI client script (see modules/index.ts). Live
// brain-graph ingestion animation: on a source:'ingest' feed burst, while the
// graph is the visible view, re-fetch the authoritative graph, seed new-node
// positions from the prior layout, run a short relax so existing nodes barely
// move, re-render, then animate only the delta (new nodes bubble in, new edges
// draw). Must stay INSIDE the client IIFE; inserted after systemTablesJs (it uses
// buildSchemaModel/forceLayout/schemaGraphSvg/wireSchemaGraph + graphModelCache).
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
      var mount = document.getElementById('graph-mount');
      if (!mount) return;
      var myGen = renderGen;
      fetchJson('/api/graph')
        .then(function (graph) {
          if (renderGen !== myGen) return; // navigated away mid-fetch
          var liveMount = document.getElementById('graph-mount');
          if (!liveMount) return;
          var model = buildSchemaModel(graph);
          if (!model.nodes.length) return;

          var prior = graphModelCache;
          var priorPos = {};
          var priorNames = {};
          var priorEdges = {};
          if (prior) {
            prior.nodes.forEach(function (n) {
              priorPos[n.name] = { x: n.x, y: n.y };
              priorNames[n.name] = true;
            });
            prior.links.forEach(function (l) { priorEdges[l.kind + ':' + l.s + '|' + l.t] = true; });
          }
          // Seed existing nodes from the prior layout so they barely move.
          model.nodes.forEach(function (n) {
            if (priorPos[n.name]) { n.x = priorPos[n.name].x; n.y = priorPos[n.name].y; }
          });
          var newNodeNames = {};
          model.nodes.forEach(function (n) { if (!priorNames[n.name]) newNodeNames[n.name] = true; });
          // Place each brand-new node next to a linked neighbor that already has a spot.
          model.links.forEach(function (l) {
            var s = model.nodes[l.si], t = model.nodes[l.ti];
            if (newNodeNames[s.name] && priorPos[t.name]) { s.x = t.x + 40; s.y = t.y + 40; }
            if (newNodeNames[t.name] && priorPos[s.name]) { t.x = s.x + 40; t.y = s.y + 40; }
          });
          // A short relax (vs the 500-tick cold layout) keeps existing nodes put.
          forceLayout(model.nodes, model.links, prior ? 70 : 500);
          liveMount.innerHTML = schemaGraphSvg(model);
          wireSchemaGraph(liveMount, model);
          graphModelCache = model;
          animateGraphDelta(liveMount, newNodeNames, priorEdges, model);
        })
        .catch(function () { /* best-effort delight; never disrupt ingest */ });
    }

    function animateGraphDelta(mount, newNodeNames, priorEdges, model) {
      if (graphReducedMotion()) return;
      var nodeEls = [];
      mount.querySelectorAll('g.gnode').forEach(function (g) {
        if (newNodeNames[g.getAttribute('data-table')]) nodeEls.push(g);
      });
      var edgeEls = [];
      mount.querySelectorAll('line.dm-edge').forEach(function (ln) {
        var l = model.links[Number(ln.getAttribute('data-edge'))];
        if (l && !priorEdges[l.kind + ':' + l.s + '|' + l.t]) edgeEls.push(ln);
      });
      var total = nodeEls.length + edgeEls.length;
      if (total === 0) return;
      // Above the cap, a per-element animation is more churn than delight — fade
      // the whole stage in once instead.
      if (total > 24) {
        var stage = mount.querySelector('.dm-stage');
        if (stage) stage.classList.add('graph-feed-in');
        return;
      }
      nodeEls.forEach(function (g) { g.classList.add('gnode-bubble-in'); });
      edgeEls.forEach(function (ln) {
        try {
          var len = ln.getTotalLength();
          ln.style.strokeDasharray = String(len);
          ln.style.strokeDashoffset = String(len);
          void ln.getBoundingClientRect(); // force reflow before transitioning
          ln.style.transition = 'stroke-dashoffset 0.5s ease';
          ln.style.strokeDashoffset = '0';
        } catch (_) { /* getTotalLength unsupported — skip the draw */ }
      });
    }
`;
