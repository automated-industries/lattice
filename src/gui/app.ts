export const guiAppHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lattice Browser</title>
  <style>
    :root {
      --bg: #f7f7f4;
      --panel: #ffffff;
      --ink: #202124;
      --muted: #696f78;
      --line: #d9ddd8;
      --accent: #0b6b62;
      --accent-2: #a64f2a;
      --blue: #345f95;
      --missing: #b3261e;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); }
    button, input { font: inherit; }
    .shell { height: 100vh; display: grid; grid-template-rows: 48px 1fr 48px; }
    header { display: flex; align-items: center; gap: 16px; padding: 0 14px; border-bottom: 1px solid var(--line); background: #fcfcfa; }
    .brand { font-weight: 700; letter-spacing: 0; }
    .meta { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions { margin-left: auto; display: flex; gap: 8px; }
    .icon-btn, .toggle { border: 1px solid var(--line); background: var(--panel); min-height: 32px; padding: 0 10px; border-radius: 6px; color: var(--ink); cursor: pointer; }
    .toggle.active { border-color: var(--accent); color: var(--accent); }
    main { min-height: 0; display: grid; grid-template-columns: 280px minmax(320px, 1fr) 340px; }
    aside, section.inspector { min-width: 0; background: var(--panel); border-right: 1px solid var(--line); overflow: auto; }
    section.inspector { border-right: 0; border-left: 1px solid var(--line); }
    .pane-title { display: flex; justify-content: space-between; align-items: center; padding: 14px; font-weight: 700; }
    .search { padding: 0 14px 12px; }
    .search input { width: 100%; height: 34px; border: 1px solid var(--line); border-radius: 6px; padding: 0 10px; }
    .group { border-top: 1px solid var(--line); }
    .group h3 { margin: 0; padding: 10px 14px 6px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
    .object { width: 100%; display: flex; align-items: center; gap: 8px; border: 0; background: transparent; padding: 8px 14px; text-align: left; cursor: pointer; }
    .object:hover, .object.selected { background: #eef4f1; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); flex: 0 0 auto; }
    .dot.table { background: var(--blue); }
    .dot.file { background: var(--accent-2); }
    .dot.missing { background: var(--missing); }
    .object small { color: var(--muted); display: block; }
    .graph-wrap { min-width: 0; min-height: 0; position: relative; background: #fbfbf8; overflow: hidden; }
    .graph-toolbar { position: absolute; top: 12px; left: 12px; z-index: 2; display: flex; gap: 8px; flex-wrap: wrap; }
    svg { width: 100%; height: 100%; display: block; }
    .edge { stroke: #9da7a3; stroke-width: 1.5; }
    .edge.markdown { stroke-dasharray: 5 4; }
    .node circle { stroke: #fff; stroke-width: 2; cursor: pointer; }
    .node text { font-size: 12px; fill: var(--ink); pointer-events: none; }
    .tabs { display: flex; gap: 4px; padding: 0 14px 10px; border-bottom: 1px solid var(--line); }
    .tabs button { border: 0; background: transparent; padding: 8px 10px; border-radius: 6px; cursor: pointer; color: var(--muted); }
    .tabs button.active { background: #eef4f1; color: var(--accent); }
    .inspector-body { padding: 14px; }
    .kv { display: grid; grid-template-columns: 96px 1fr; gap: 8px; font-size: 13px; margin-bottom: 6px; }
    .kv span:first-child { color: var(--muted); }
    pre { white-space: pre-wrap; overflow: auto; background: #f1f2ef; padding: 12px; border-radius: 6px; font-size: 12px; line-height: 1.45; }
    .file-card, .connection { border: 1px solid var(--line); border-radius: 6px; padding: 10px; margin-bottom: 10px; background: #fff; }
    footer { border-top: 1px solid var(--line); background: #fcfcfa; display: flex; align-items: center; padding: 0 14px; color: var(--muted); font-size: 13px; }
    footer.drop-active { background: #e6f3ef; color: var(--accent); }
    .empty { color: var(--muted); padding: 14px; }
    @media (max-width: 860px) {
      .shell { height: auto; min-height: 100vh; grid-template-rows: 48px auto 54px; }
      main { grid-template-columns: 1fr; grid-template-rows: auto 420px auto; }
      aside, section.inspector { border: 0; border-bottom: 1px solid var(--line); max-height: 380px; }
      .graph-toolbar { position: static; padding: 10px; background: var(--panel); border-bottom: 1px solid var(--line); }
      .graph-wrap { height: 420px; }
      header .meta { display: none; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand">Lattice Browser</div>
      <div class="meta" id="project-meta">Loading project...</div>
      <div class="actions">
        <button class="icon-btn" id="refresh" title="Refresh">Refresh</button>
      </div>
    </header>
    <main>
      <aside>
        <div class="pane-title">Objects <span id="object-count"></span></div>
        <div class="search"><input id="search" placeholder="Search objects..." /></div>
        <div id="objects"></div>
      </aside>
      <div class="graph-wrap">
        <div class="graph-toolbar">
          <button class="toggle active" id="toggle-entities">Entities</button>
          <button class="toggle" id="toggle-files">Files</button>
          <button class="toggle" id="toggle-markdown">Backlinks</button>
          <button class="toggle" id="fit">Fit</button>
        </div>
        <svg id="graph" role="img" aria-label="Lattice object graph"></svg>
      </div>
      <section class="inspector">
        <div class="pane-title">Inspector</div>
        <div class="tabs">
          <button class="active" data-tab="overview">Overview</button>
          <button data-tab="files">Files</button>
          <button data-tab="connections">Connections</button>
          <button data-tab="raw">Raw</button>
        </div>
        <div class="inspector-body" id="inspector"><div class="empty">Select an object to inspect its context.</div></div>
      </section>
    </main>
    <footer id="drop-zone">Drop lattice.config.yml, .db, context folder, or context files here</footer>
  </div>
  <script>
    const state = {
      project: null, entities: null, graph: null, selected: null, tab: 'overview',
      showEntities: true, showFiles: false, showMarkdown: true, dropped: []
    };
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    async function json(url, options) {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }
    async function load() {
      state.project = await json('/api/project');
      state.entities = await json('/api/entities');
      state.graph = await json('/api/graph');
      $('project-meta').textContent = 'config: ' + state.project.configPath + '  output: ' + state.project.outputDir;
      renderObjects(); renderGraph(); renderInspector();
    }
    function allObjects() {
      const counts = new Map();
      for (const e of state.entities?.entities ?? []) counts.set(e.table, (counts.get(e.table) ?? 0) + 1);
      const tables = state.entities?.tables.map(t => ({ id:'table:'+t.name, type:'table', label:t.name, sub:(counts.get(t.name) ?? 0)+' objects', raw:{...t, objectCount: counts.get(t.name) ?? 0} })) ?? [];
      const selectedTable = state.selected?.startsWith('table:') ? state.selected.slice('table:'.length) : '';
      const ents = selectedTable ? (state.entities?.entities.filter(e => e.table === selectedTable).map(e => ({ id:'entity:'+e.table+':'+e.slug, type:'entity', label:e.slug, sub:e.table, raw:e })) ?? []) : [];
      const dropped = state.dropped.map((d, i) => ({ id:'drop:'+i, type:'file', label:d.name, sub:d.type+' · '+d.bytes+' bytes', raw:d }));
      return [...tables, ...ents, ...dropped];
    }
    function renderObjects() {
      const q = $('search').value.toLowerCase();
      const objects = allObjects().filter(o => (o.label+' '+o.sub).toLowerCase().includes(q));
      $('object-count').textContent = String(objects.length);
      const byType = { table: [], entity: [], file: [] };
      for (const o of objects) byType[o.type].push(o);
      $('objects').innerHTML = [
        groupHtml('Objects', byType.table),
        groupHtml('Entities', byType.entity),
        groupHtml('Dropped Files', byType.file)
      ].join('');
      document.querySelectorAll('.object').forEach(btn => btn.addEventListener('click', () => {
        state.selected = btn.dataset.id; state.tab = 'overview'; renderObjects(); renderGraph(); renderInspector();
      }));
    }
    function groupHtml(title, rows) {
      if (!rows.length) return '';
      return '<div class="group"><h3>'+title+'</h3>'+rows.map(o =>
        '<button class="object '+(state.selected===o.id?'selected':'')+'" data-id="'+esc(o.id)+'"><span class="dot '+esc(o.type)+'"></span><span>'+esc(o.label)+'<small>'+esc(o.sub)+'</small></span></button>'
      ).join('')+'</div>';
    }
    function visibleGraph() {
      const selectedTable = state.selected?.startsWith('table:') ? state.selected.slice('table:'.length) : '';
      const selectedEntity = state.selected?.startsWith('entity:') ? state.selected : '';
      const allNodes = state.graph?.nodes ?? [];
      const allEdges = state.graph?.edges ?? [];
      const nodes = allNodes.filter(n => {
        if (n.type === 'table') return true;
        if (n.type === 'entity') {
          if (!state.showEntities) return false;
          if (selectedEntity) return n.id === selectedEntity;
          return Boolean(selectedTable) && n.table === selectedTable;
        }
        if (n.type === 'file') return state.showFiles && Boolean(selectedEntity) && n.id.startsWith('file:' + selectedEntity.split(':').slice(1).join('/') + '/');
        return false;
      });
      const ids = new Set(nodes.map(n => n.id));
      const edges = allEdges.filter(e => {
        if (!ids.has(e.source) || !ids.has(e.target)) return false;
        if (e.type === 'markdown' && !state.showMarkdown) return false;
        if (e.type === 'renders' && !state.showFiles) return false;
        if (e.type === 'contains' && !selectedTable && !selectedEntity) return false;
        return true;
      });
      return { nodes, edges };
    }
    function renderGraph() {
      const svg = $('graph'); const { nodes, edges } = visibleGraph();
      const w = svg.clientWidth || 800, h = svg.clientHeight || 500;
      const cx = w / 2, cy = h / 2, radius = Math.max(120, Math.min(w, h) / 2 - 70);
      const pos = new Map();
      nodes.forEach((n, i) => {
        const a = (Math.PI * 2 * i) / Math.max(nodes.length, 1) - Math.PI / 2;
        pos.set(n.id, { x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
      });
      const color = (n) => n.type === 'table' ? '#345f95' : n.type === 'file' ? '#a64f2a' : n.status === 'missing-files' ? '#b3261e' : '#0b6b62';
      svg.innerHTML = '<g>'+edges.map(e => {
        const s = pos.get(e.source), t = pos.get(e.target); if (!s || !t) return '';
        return '<line class="edge '+esc(e.type)+'" x1="'+s.x+'" y1="'+s.y+'" x2="'+t.x+'" y2="'+t.y+'"><title>'+esc(e.label)+'</title></line>';
      }).join('')+'</g><g>'+nodes.map(n => {
        const p = pos.get(n.id);
        return '<g class="node" data-id="'+esc(n.id)+'" transform="translate('+p.x+' '+p.y+')"><circle r="'+(state.selected===n.id?12:9)+'" fill="'+color(n)+'"></circle><text x="14" y="4">'+esc(n.label)+'</text></g>';
      }).join('')+'</g>';
      svg.querySelectorAll('.node').forEach(n => n.addEventListener('click', () => {
        state.selected = n.dataset.id; state.tab = 'overview'; renderObjects(); renderGraph(); renderInspector();
      }));
    }
    function findSelected() {
      return allObjects().find(o => o.id === state.selected) ?? (state.graph?.nodes ?? []).find(n => n.id === state.selected);
    }
    async function renderInspector() {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
      const selected = findSelected();
      if (!selected) { $('inspector').innerHTML = '<div class="empty">Select an object to inspect its context.</div>'; return; }
      if (state.tab === 'raw') { $('inspector').innerHTML = '<pre>'+esc(JSON.stringify(selected.raw ?? selected, null, 2))+'</pre>'; return; }
      if (state.tab === 'connections') return renderConnections(selected);
      if (state.tab === 'files' && selected.type === 'entity') return renderFiles(selected.raw);
      if (selected.type === 'table') return renderObjectType(selected.raw);
      $('inspector').innerHTML = '<h2>'+esc(selected.label)+'</h2>'
        + '<div class="kv"><span>Type</span><strong>'+esc(selected.type)+'</strong></div>'
        + '<div class="kv"><span>Details</span><span>'+esc(selected.sub ?? selected.table ?? '')+'</span></div>'
        + (selected.raw?.status ? '<div class="kv"><span>Status</span><span>'+esc(selected.raw.status)+'</span></div>' : '');
    }
    function renderObjectType(table) {
      const rows = (state.entities?.entities ?? []).filter(e => e.table === table.name);
      $('inspector').innerHTML = '<h2>'+esc(table.name)+'</h2>'
        + '<div class="kv"><span>Objects</span><strong>'+esc(rows.length)+'</strong></div>'
        + '<div class="kv"><span>Fields</span><span>'+esc(table.columns.join(', '))+'</span></div>'
        + '<h3>Entities</h3>'
        + (rows.length ? rows.slice(0, 80).map(e => '<button class="connection object" data-id="entity:'+esc(e.table)+':'+esc(e.slug)+'"><span class="dot"></span><span>'+esc(e.slug)+'<small>'+esc(e.files.length)+' files</small></span></button>').join('') : '<div class="empty">No rendered entities.</div>')
        + (rows.length > 80 ? '<div class="empty">Showing first 80. Use search to narrow.</div>' : '');
      document.querySelectorAll('.connection').forEach(btn => btn.addEventListener('click', () => { state.selected = btn.dataset.id; state.tab = 'overview'; renderObjects(); renderGraph(); renderInspector(); }));
    }
    async function renderFiles(entity) {
      if (!entity) { $('inspector').innerHTML = '<div class="empty">Files are available for rendered entities.</div>'; return; }
      const payload = await json('/api/files?entity='+encodeURIComponent(entity.table)+'&slug='+encodeURIComponent(entity.slug));
      $('inspector').innerHTML = payload.files.map(f => '<div class="file-card"><strong>'+esc(f.name)+'</strong><small> '+esc(f.path)+'</small><pre>'+esc(f.content || '(missing)')+'</pre></div>').join('');
    }
    function renderConnections(selected) {
      const id = selected.id;
      const connections = (state.graph?.edges ?? []).filter(e => e.source === id || e.target === id);
      $('inspector').innerHTML = connections.length ? connections.map(e => {
        const other = e.source === id ? e.target : e.source;
        return '<button class="connection object" data-id="'+esc(other)+'"><span class="dot"></span><span>'+esc(e.type)+'<small>'+esc(e.label)+' → '+esc(other)+'</small></span></button>';
      }).join('') : '<div class="empty">No visible connections.</div>';
      document.querySelectorAll('.connection').forEach(btn => btn.addEventListener('click', () => { state.selected = btn.dataset.id; renderObjects(); renderGraph(); renderInspector(); }));
    }
    async function handleDrop(ev) {
      ev.preventDefault(); $('drop-zone').classList.remove('drop-active');
      for (const file of ev.dataTransfer.files) {
        const text = file.size < 750000 ? await file.text().catch(() => '') : '';
        const preview = await json('/api/drop', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name:file.name, size:file.size, content:text }) });
        state.dropped.push(preview);
      }
      renderObjects();
    }
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; renderInspector(); }));
    $('search').addEventListener('input', renderObjects);
    $('refresh').addEventListener('click', load);
    $('toggle-entities').addEventListener('click', () => { state.showEntities = !state.showEntities; $('toggle-entities').classList.toggle('active', state.showEntities); renderGraph(); });
    $('toggle-files').addEventListener('click', () => { state.showFiles = !state.showFiles; $('toggle-files').classList.toggle('active', state.showFiles); renderGraph(); });
    $('toggle-markdown').addEventListener('click', () => { state.showMarkdown = !state.showMarkdown; $('toggle-markdown').classList.toggle('active', state.showMarkdown); renderGraph(); });
    $('fit').addEventListener('click', renderGraph);
    window.addEventListener('resize', renderGraph);
    window.addEventListener('dragover', ev => { ev.preventDefault(); $('drop-zone').classList.add('drop-active'); });
    window.addEventListener('dragleave', () => $('drop-zone').classList.remove('drop-active'));
    window.addEventListener('drop', handleDrop);
    load().catch(err => { $('project-meta').textContent = 'Error'; $('objects').innerHTML = '<div class="empty">'+esc(err.message)+'</div>'; });
  </script>
</body>
</html>`;
